import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

interface QuoteItem {
  sku?: string;
  product_name?: string;
  container_size?: string;
  quantity: number;
}

interface QuoteRequest {
  customer_email?: string;
  customer_name?: string;
  items: QuoteItem[];
  notes?: string;
  shipping_address?: {
    city?: string;
    state?: string;
    zip?: string;
  };
}

interface QuoteLineItem {
  sku: string;
  product_name: string;
  container_size: string;
  unit_price: number;
  quantity: number;
  subtotal: number;
  hazmat_fee: number;
  total: number;
}

/**
 * POST /api/tools/quote
 * Generate a complete quote with multiple products
 * Stores quote in database for tracking
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const body: QuoteRequest = await request.json();
    const { customer_email, customer_name, items, notes, shipping_address } = body;

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: 'At least one item is required for a quote' },
        { status: 400 }
      );
    }

    await client.connect();
    await client.query('BEGIN');

    // Create the quote record
    const quoteResult = await client.query(
      `INSERT INTO alliance_quotes (
        customer_email,
        customer_name,
        status,
        notes,
        metadata
      ) VALUES ($1, $2, $3, $4, $5)
      RETURNING id, quote_number`,
      [
        customer_email || 'unknown',
        customer_name || 'Unknown Customer',
        'draft',
        notes,
        JSON.stringify({ shipping_address }),
      ]
    );

    const quoteId = quoteResult.rows[0].id;
    const quoteNumber = quoteResult.rows[0].quote_number;

    const lineItems: QuoteLineItem[] = [];
    let totalAmount = 0;
    let totalHazmatFees = 0;

    // Process each item in the quote
    for (const item of items) {
      // Find the product variant
      let query = `
        SELECT 
          p.id as product_id,
          p.title as product_name,
          p.hazard_class,
          v.id as variant_id,
          v.sku,
          v.container_size,
          v.price,
          v.inventory_quantity
        FROM alliance_products p
        JOIN alliance_product_variants v ON p.id = v.product_id
        WHERE v.is_active = true
      `;

      const params: any[] = [];
      let paramCount = 1;

      if (item.sku) {
        query += ` AND LOWER(v.sku) = LOWER($${paramCount})`;
        params.push(item.sku);
      } else if (item.product_name && item.container_size) {
        query += ` AND LOWER(p.title) LIKE LOWER($${paramCount})`;
        params.push(`%${item.product_name}%`);
        paramCount++;
        query += ` AND LOWER(v.container_size) LIKE LOWER($${paramCount})`;
        params.push(`%${item.container_size}%`);
      } else {
        continue; // Skip items without enough info
      }

      query += ` LIMIT 1`;

      const productResult = await client.query(query, params);

      if (productResult.rows.length === 0) {
        // Track items that couldn't be found
        lineItems.push({
          sku: item.sku || 'NOT_FOUND',
          product_name: item.product_name || 'Product not found',
          container_size: item.container_size || 'N/A',
          unit_price: 0,
          quantity: item.quantity,
          subtotal: 0,
          hazmat_fee: 0,
          total: 0,
        });
        continue;
      }

      const product = productResult.rows[0];
      let unitPrice = parseFloat(product.price);

      // Check for quantity discounts
      if (item.quantity > 1) {
        const tierResult = await client.query(
          `SELECT discount_percentage 
           FROM alliance_pricing_tiers
           WHERE product_id = $1 AND min_quantity <= $2
           ORDER BY min_quantity DESC
           LIMIT 1`,
          [product.product_id, item.quantity]
        );

        if (tierResult.rows.length > 0) {
          const discount = tierResult.rows[0].discount_percentage;
          unitPrice = unitPrice * (1 - discount / 100);
        }
      }

      const hazmatFee = product.hazard_class ? 35.00 : 0;
      const subtotal = unitPrice * item.quantity;
      const lineTotal = subtotal + hazmatFee;

      // Insert quote line item
      await client.query(
        `INSERT INTO alliance_quote_items (
          quote_id,
          product_id,
          variant_id,
          quantity,
          unit_price,
          total_price,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          quoteId,
          product.product_id,
          product.variant_id,
          item.quantity,
          unitPrice,
          lineTotal,
          JSON.stringify({
            sku: product.sku,
            container_size: product.container_size,
            hazmat_fee: hazmatFee,
          }),
        ]
      );

      lineItems.push({
        sku: product.sku,
        product_name: product.product_name,
        container_size: product.container_size,
        unit_price: unitPrice,
        quantity: item.quantity,
        subtotal: subtotal,
        hazmat_fee: hazmatFee,
        total: lineTotal,
      });

      totalAmount += lineTotal;
      totalHazmatFees += hazmatFee;
    }

    // Calculate shipping estimate
    const hasFreightItems = lineItems.some(item => 
      item.container_size.includes('Drum') || 
      item.container_size.includes('Tote')
    );
    const shippingEstimate = hasFreightItems ? 250.00 : 45.00;

    // Update quote with totals
    await client.query(
      `UPDATE alliance_quotes 
       SET total_amount = $1, 
           metadata = metadata || $2::jsonb,
           updated_at = NOW()
       WHERE id = $3`,
      [
        totalAmount,
        JSON.stringify({
          shipping_estimate: shippingEstimate,
          hazmat_fees: totalHazmatFees,
          freight_required: hasFreightItems,
        }),
        quoteId,
      ]
    );

    await client.query('COMMIT');

    // Format the response
    const response = {
      success: true,
      quote_number: quoteNumber,
      quote_id: quoteId,
      customer: {
        name: customer_name || 'Unknown Customer',
        email: customer_email || 'unknown',
      },
      line_items: lineItems,
      summary: {
        subtotal: lineItems.reduce((sum, item) => sum + item.subtotal, 0),
        hazmat_fees: totalHazmatFees,
        shipping_estimate: shippingEstimate,
        total: totalAmount + shippingEstimate,
      },
      notes: {
        validity: 'Quote valid for 30 days',
        payment_terms: 'Net 30 for approved accounts',
        shipping: hasFreightItems 
          ? 'Freight shipping required (LTL carrier)'
          : 'Standard UPS Ground shipping',
        hazmat: totalHazmatFees > 0
          ? 'Hazmat fees apply due to dangerous goods classification'
          : null,
      },
      created_at: new Date().toISOString(),
    };

    return NextResponse.json(response);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Quote generation error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to generate quote',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * GET /api/tools/quote/:id
 * Retrieve an existing quote
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const quoteNumber = searchParams.get('quote_number');
  
  if (!quoteNumber) {
    return NextResponse.json(
      { error: 'Quote number is required' },
      { status: 400 }
    );
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const quoteResult = await client.query(
      `SELECT 
        q.*,
        json_agg(
          json_build_object(
            'product_id', qi.product_id,
            'quantity', qi.quantity,
            'unit_price', qi.unit_price,
            'total_price', qi.total_price,
            'metadata', qi.metadata
          )
        ) as items
      FROM alliance_quotes q
      LEFT JOIN alliance_quote_items qi ON q.id = qi.quote_id
      WHERE q.quote_number = $1
      GROUP BY q.id`,
      [quoteNumber]
    );

    if (quoteResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'Quote not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(quoteResult.rows[0]);

  } catch (error) {
    console.error('Quote retrieval error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to retrieve quote',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}