import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';
import OpenAI from 'openai';
import { productCache, CacheService } from '@/lib/cache';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface SearchRequest {
  query: string;
  filters?: {
    category?: string;
    hazmat_only?: boolean;
    min_price?: number;
    max_price?: number;
    container_sizes?: string[];
  };
  limit?: number;
}

/**
 * POST /api/tools/product-search
 * Semantic product search for AI agents
 * Combines vector similarity with filters
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const body: SearchRequest = await request.json();
    const { query, filters = {}, limit = 10 } = body;

    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      );
    }

    // Create cache key from search parameters
    const cacheKey = CacheService.createKey(
      'search',
      query,
      JSON.stringify(filters),
      limit
    );

    // Check cache first
    const cachedResponse = await productCache.get(cacheKey);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse);
    }

    await client.connect();

    // Generate embedding for the search query
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Build the search query with filters
    let searchQuery = `
      WITH semantic_search AS (
        SELECT 
          p.id,
          p.title,
          p.description,
          p.cas_number,
          p.category,
          p.hazard_class,
          p.synonyms,
          1 - (p.embedding <=> $1::vector) as similarity
        FROM alliance_products p
        WHERE p.embedding IS NOT NULL
    `;

    const params: any[] = [`[${queryEmbedding.join(',')}]`];
    let paramCount = 2;

    // Add filters to CTE
    if (filters.category) {
      searchQuery += ` AND p.category = $${paramCount}`;
      params.push(filters.category);
      paramCount++;
    }

    if (filters.hazmat_only) {
      searchQuery += ` AND p.hazard_class IS NOT NULL`;
    }

    searchQuery += `
        ORDER BY similarity DESC
        LIMIT $${paramCount}
      ),
      product_details AS (
        SELECT 
          s.*,
          json_agg(
            json_build_object(
              'sku', v.sku,
              'container_size', v.container_size,
              'price', v.price,
              'available', v.inventory_quantity > 0
            ) ORDER BY v.price ASC
          ) FILTER (WHERE v.is_active = true) as variants
        FROM semantic_search s
        LEFT JOIN alliance_product_variants v ON s.id = v.product_id
    `;

    params.push(limit * 2); // Get more for filtering
    paramCount++;

    // Add variant-level filters
    if (filters.min_price || filters.max_price || filters.container_sizes?.length) {
      searchQuery += ` WHERE 1=1`;
      
      if (filters.min_price) {
        searchQuery += ` AND v.price >= $${paramCount}`;
        params.push(filters.min_price);
        paramCount++;
      }
      
      if (filters.max_price) {
        searchQuery += ` AND v.price <= $${paramCount}`;
        params.push(filters.max_price);
        paramCount++;
      }
      
      if (filters.container_sizes?.length) {
        searchQuery += ` AND v.container_size = ANY($${paramCount}::text[])`;
        params.push(filters.container_sizes);
        paramCount++;
      }
    }

    searchQuery += `
        GROUP BY s.id, s.title, s.description, s.cas_number, 
                 s.category, s.hazard_class, s.synonyms, s.similarity
      )
      SELECT * FROM product_details
      WHERE variants IS NOT NULL
      ORDER BY similarity DESC
      LIMIT $${paramCount}
    `;

    params.push(limit);

    const result = await client.query(searchQuery, params);

    if (result.rows.length === 0) {
      // Fallback to lexical search if no semantic matches
      const lexicalQuery = `
        SELECT 
          p.id,
          p.title,
          p.description,
          p.cas_number,
          p.category,
          p.hazard_class,
          p.synonyms,
          json_agg(
            json_build_object(
              'sku', v.sku,
              'container_size', v.container_size,
              'price', v.price,
              'available', v.inventory_quantity > 0
            ) ORDER BY v.price ASC
          ) FILTER (WHERE v.is_active = true) as variants
        FROM alliance_products p
        LEFT JOIN alliance_product_variants v ON p.id = v.product_id
        WHERE (
          p.title ILIKE $1
          OR p.description ILIKE $1
          OR p.cas_number = $2
          OR $1 = ANY(p.synonyms)
        )
        GROUP BY p.id
        LIMIT $3
      `;

      const lexicalResult = await client.query(
        lexicalQuery,
        [`%${query}%`, query, limit]
      );

      if (lexicalResult.rows.length === 0) {
        return NextResponse.json({
          found: false,
          message: 'No products found matching your search',
          query,
          filters,
        });
      }

      result.rows = lexicalResult.rows;
    }

    // Format results for AI consumption
    const products = result.rows.map(row => ({
      id: row.id,
      name: row.title,
      description: row.description,
      cas_number: row.cas_number,
      category: row.category,
      hazmat: row.hazard_class !== null,
      hazard_class: row.hazard_class,
      synonyms: row.synonyms,
      similarity_score: row.similarity || 0,
      variants: row.variants || [],
    }));

    // Log the search for analytics
    const logQuery = `
      INSERT INTO alliance_search_logs (
        query_text,
        query_embedding,
        result_count,
        top_result_id,
        filters
      ) VALUES ($1, $2, $3, $4, $5)
    `;

    await client.query(logQuery, [
      query,
      `[${queryEmbedding.join(',')}]`,
      products.length,
      products[0]?.id || null,
      JSON.stringify(filters),
    ]);

    const response = {
      found: true,
      query,
      filters,
      result_count: products.length,
      products,
      search_type: result.rows[0]?.similarity ? 'semantic' : 'lexical',
    };

    // Cache the response for 15 minutes
    await productCache.set(cacheKey, response, { ttl: 900 });

    return NextResponse.json(response);

  } catch (error) {
    console.error('Product search error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to search products',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}