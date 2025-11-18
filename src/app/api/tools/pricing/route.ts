import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';
import { pricingCache, CacheService } from '@/lib/cache';

interface PricingRequest {
  product_name?: string;
  sku?: string;
  cas_number?: string;
  container_size?: string;
  quantity?: number;
}

interface ProductPrice {
  product_id: number;
  product_name: string;
  sku: string;
  cas_number?: string;
  container_size: string;
  unit_price: number;
  quantity_available?: number;
  hazmat_fee?: number;
  total_price: number;
  shipping_class?: string;
}

/**
 * POST /api/tools/pricing
 * Deterministic pricing tool for AI agents
 * Returns exact prices from database - no hallucinations
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const body: PricingRequest = await request.json();
    const { product_name, sku, cas_number, container_size, quantity = 1 } = body;

    // Create cache key from request parameters
    const cacheKey = CacheService.createKey(
      'price',
      product_name || '',
      sku || '',
      cas_number || '',
      container_size || '',
      quantity
    );

    // Check cache first
    const cachedResponse = await pricingCache.get(cacheKey);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse);
    }

    if (!product_name && !sku && !cas_number) {
      return NextResponse.json(
        { error: 'Must provide product_name, sku, or cas_number' },
        { status: 400 }
      );
    }

    await client.connect();

    // Build the query based on provided parameters
    let query = `
      SELECT 
        p.id as product_id,
        p.title as product_name,
        p.cas_number,
        v.sku,
        v.container_size,
        v.price as unit_price,
        v.inventory_quantity as quantity_available,
        p.hazard_class,
        CASE 
          WHEN p.hazard_class IS NOT NULL THEN 35.00
          ELSE 0
        END as hazmat_fee,
        CASE 
          WHEN v.container_size LIKE '%Drum%' OR v.container_size LIKE '%Tote%' THEN 'freight'
          ELSE 'standard'
        END as shipping_class
      FROM alliance_products p
      JOIN alliance_product_variants v ON p.id = v.product_id
      WHERE v.is_active = true
    `;

    const params: any[] = [];
    let paramCount = 1;

    // Add search conditions
    if (sku) {
      query += ` AND LOWER(v.sku) = LOWER($${paramCount})`;
      params.push(sku);
      paramCount++;
    } else if (product_name && container_size) {
      // Exact match by product name and container size
      query += ` AND LOWER(p.title) LIKE LOWER($${paramCount})`;
      params.push(`%${product_name}%`);
      paramCount++;
      query += ` AND LOWER(v.container_size) LIKE LOWER($${paramCount})`;
      params.push(`%${container_size}%`);
      paramCount++;
    } else if (cas_number) {
      query += ` AND p.cas_number = $${paramCount}`;
      params.push(cas_number);
      paramCount++;
      if (container_size) {
        query += ` AND LOWER(v.container_size) LIKE LOWER($${paramCount})`;
        params.push(`%${container_size}%`);
        paramCount++;
      }
    } else if (product_name) {
      // Fuzzy search by product name
      query += ` AND (
        LOWER(p.title) LIKE LOWER($${paramCount}) 
        OR $${paramCount} = ANY(LOWER(p.synonyms::text)::text[])
      )`;
      params.push(`%${product_name}%`);
      paramCount++;
    }

    query += ` ORDER BY v.price ASC LIMIT 10`;

    const result = await client.query(query, params);

    if (result.rows.length === 0) {
      return NextResponse.json({
        found: false,
        message: 'No products found matching your criteria',
        search_criteria: { product_name, sku, cas_number, container_size },
      });
    }

    // Calculate total prices
    const prices: ProductPrice[] = result.rows.map(row => ({
      product_id: row.product_id,
      product_name: row.product_name,
      sku: row.sku,
      cas_number: row.cas_number,
      container_size: row.container_size,
      unit_price: parseFloat(row.unit_price),
      quantity_available: row.quantity_available,
      hazmat_fee: parseFloat(row.hazmat_fee),
      total_price: (parseFloat(row.unit_price) * quantity) + parseFloat(row.hazmat_fee),
      shipping_class: row.shipping_class,
    }));

    // Get quantity-based discounts if applicable
    if (quantity > 1 && prices.length > 0) {
      const tierQuery = `
        SELECT 
          min_quantity,
          discount_percentage
        FROM alliance_pricing_tiers
        WHERE product_id = $1
          AND min_quantity <= $2
        ORDER BY min_quantity DESC
        LIMIT 1
      `;

      for (const price of prices) {
        const tierResult = await client.query(tierQuery, [price.product_id, quantity]);
        
        if (tierResult.rows.length > 0) {
          const discount = tierResult.rows[0].discount_percentage;
          const discountedPrice = price.unit_price * (1 - discount / 100);
          price.unit_price = discountedPrice;
          price.total_price = (discountedPrice * quantity) + (price.hazmat_fee || 0);
        }
      }
    }

    // Format response for AI consumption
    const response = {
      found: true,
      query: { product_name, sku, cas_number, container_size, quantity },
      results: prices,
      disclaimer: 'Prices are in USD. Shipping costs not included. Quote valid for 30 days.',
      notes: prices.some(p => (p.hazmat_fee || 0) > 0) 
        ? 'Hazmat fee applies to this product due to dangerous goods classification.'
        : null,
    };

    // Cache the response for 5 minutes
    await pricingCache.set(cacheKey, response, { ttl: 300 });

    return NextResponse.json(response);

  } catch (error) {
    console.error('Pricing tool error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to retrieve pricing',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * GET /api/tools/pricing
 * Get pricing for a specific SKU
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const sku = searchParams.get('sku');
  
  if (!sku) {
    return NextResponse.json(
      { error: 'SKU parameter required' },
      { status: 400 }
    );
  }

  // Delegate to POST handler
  return POST(new NextRequest(request.url, {
    method: 'POST',
    body: JSON.stringify({ sku }),
  }));
}