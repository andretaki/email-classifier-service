import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';
import OpenAI from 'openai';
import type { SearchParams, SearchResult, AllianceProduct } from '@/types';

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Hybrid product search combining BM25 (lexical) and vector similarity
 * 
 * This API provides:
 * - Full-text search using PostgreSQL's ts_vector
 * - Semantic search using pgvector similarity
 * - Hybrid ranking combining both scores
 * - Chemical-specific filters (CAS numbers, hazard class, etc.)
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    
    // Parse request body
    const body: SearchParams = await request.json();
    const { 
      query, 
      filters = {}, 
      limit = 20, 
      offset = 0 
    } = body;

    if (!query || query.trim().length === 0) {
      return NextResponse.json(
        { error: 'Query parameter is required' },
        { status: 400 }
      );
    }

    const startTime = Date.now();

    // Generate embedding for the query
    console.log('Generating query embedding...');
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
      dimensions: 1536,
    });
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Build filter conditions
    const filterConditions: string[] = [];
    const filterParams: any[] = [];
    let paramCounter = 4; // Starting after the main query params

    if (filters.product_type) {
      filterConditions.push(`p.product_type = $${paramCounter}`);
      filterParams.push(filters.product_type);
      paramCounter++;
    }

    if (filters.hazmat !== undefined) {
      if (filters.hazmat) {
        filterConditions.push(`p.hazard_class IS NOT NULL`);
      } else {
        filterConditions.push(`p.hazard_class IS NULL`);
      }
    }

    if (filters.container_size) {
      filterConditions.push(`
        EXISTS (
          SELECT 1 FROM alliance_product_variants v 
          WHERE v.product_id = p.id 
          AND v.container_size = $${paramCounter}
        )
      `);
      filterParams.push(filters.container_size);
      paramCounter++;
    }

    if (filters.max_price) {
      filterConditions.push(`
        EXISTS (
          SELECT 1 FROM alliance_product_variants v 
          WHERE v.product_id = p.id 
          AND v.price <= $${paramCounter}
        )
      `);
      filterParams.push(filters.max_price);
      paramCounter++;
    }

    if (filters.in_stock) {
      filterConditions.push(`
        EXISTS (
          SELECT 1 FROM alliance_product_variants v 
          WHERE v.product_id = p.id 
          AND v.inventory_quantity > 0
        )
      `);
    }

    const whereClause = filterConditions.length > 0 
      ? `AND ${filterConditions.join(' AND ')}` 
      : '';

    // Hybrid search query combining BM25 and vector similarity
    const searchQuery = `
      WITH text_search AS (
        -- BM25 full-text search
        SELECT 
          p.id,
          p.shopify_id,
          p.title,
          p.description,
          p.product_type,
          p.vendor,
          p.cas_number,
          p.un_number,
          p.hazard_class,
          p.applications,
          p.status,
          ts_rank_cd(
            to_tsvector('english', 
              COALESCE(p.title,'') || ' ' || 
              COALESCE(p.description,'') || ' ' || 
              COALESCE(p.tags,'') || ' ' || 
              COALESCE(p.cas_number,'')
            ),
            plainto_tsquery('english', $1)
          ) as text_score
        FROM alliance_products p
        WHERE 
          p.status = 'active'
          ${whereClause}
          AND to_tsvector('english', 
            COALESCE(p.title,'') || ' ' || 
            COALESCE(p.description,'') || ' ' || 
            COALESCE(p.tags,'') || ' ' || 
            COALESCE(p.cas_number,'')
          ) @@ plainto_tsquery('english', $1)
      ),
      vector_search AS (
        -- Vector similarity search
        SELECT 
          p.id,
          p.shopify_id,
          p.title,
          p.description,
          p.product_type,
          p.vendor,
          p.cas_number,
          p.un_number,
          p.hazard_class,
          p.applications,
          p.status,
          1 - (p.embedding <=> $2::vector) as vector_score
        FROM alliance_products p
        WHERE 
          p.status = 'active'
          AND p.embedding IS NOT NULL
          ${whereClause}
        ORDER BY p.embedding <=> $2::vector
        LIMIT 100
      ),
      combined_results AS (
        -- Combine and weight both search methods
        SELECT 
          COALESCE(t.id, v.id) as id,
          COALESCE(t.shopify_id, v.shopify_id) as shopify_id,
          COALESCE(t.title, v.title) as title,
          COALESCE(t.description, v.description) as description,
          COALESCE(t.product_type, v.product_type) as product_type,
          COALESCE(t.vendor, v.vendor) as vendor,
          COALESCE(t.cas_number, v.cas_number) as cas_number,
          COALESCE(t.un_number, v.un_number) as un_number,
          COALESCE(t.hazard_class, v.hazard_class) as hazard_class,
          COALESCE(t.applications, v.applications) as applications,
          COALESCE(t.status, v.status) as status,
          -- Weighted hybrid score (60% semantic, 40% lexical)
          (COALESCE(v.vector_score, 0) * 0.6 + COALESCE(t.text_score, 0) * 0.4) as hybrid_score,
          COALESCE(t.text_score, 0) as text_score,
          COALESCE(v.vector_score, 0) as vector_score
        FROM text_search t
        FULL OUTER JOIN vector_search v ON t.id = v.id
      )
      SELECT 
        cr.*,
        -- Get the lowest price variant for display
        (
          SELECT MIN(v.price) 
          FROM alliance_product_variants v 
          WHERE v.product_id = cr.id
        ) as min_price,
        -- Get available container sizes
        (
          SELECT ARRAY_AGG(DISTINCT v.container_size) 
          FROM alliance_product_variants v 
          WHERE v.product_id = cr.id AND v.container_size IS NOT NULL
        ) as container_sizes,
        -- Check if in stock
        (
          SELECT SUM(v.inventory_quantity) > 0
          FROM alliance_product_variants v 
          WHERE v.product_id = cr.id
        ) as in_stock
      FROM combined_results cr
      ORDER BY cr.hybrid_score DESC
      LIMIT $3 OFFSET $4
    `;

    // Execute search
    const result = await client.query(searchQuery, [
      query,
      `[${queryEmbedding.join(',')}]`,
      limit,
      offset,
      ...filterParams
    ]);

    // Log search for analytics
    await client.query(`
      INSERT INTO product_search_log (
        query, query_embedding, filters, total_results, search_time_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      query,
      `[${queryEmbedding.join(',')}]`,
      JSON.stringify(filters),
      result.rows.length,
      Date.now() - startTime
    ]);

    // Transform results
    const products: AllianceProduct[] = result.rows.map(row => ({
      id: row.id,
      shopify_id: row.shopify_id,
      title: row.title,
      description: row.description,
      product_type: row.product_type,
      vendor: row.vendor,
      cas_number: row.cas_number,
      un_number: row.un_number,
      hazard_class: row.hazard_class,
      applications: row.applications,
      status: row.status,
      min_price: parseFloat(row.min_price || '0'),
      container_sizes: row.container_sizes || [],
      in_stock: row.in_stock || false,
      relevance_score: row.hybrid_score,
      text_score: row.text_score,
      vector_score: row.vector_score,
      created_at: new Date(),
      updated_at: new Date(),
    }));

    const response: SearchResult = {
      products,
      total: result.rows.length,
      search_time_ms: Date.now() - startTime,
      query_id: Date.now(), // Simple ID for now
    };

    return NextResponse.json(response);

  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json(
      { error: 'Failed to perform search', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * GET endpoint for simple searches without embedding
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');
  const limit = parseInt(searchParams.get('limit') || '20');
  const offset = parseInt(searchParams.get('offset') || '0');

  if (!query) {
    return NextResponse.json(
      { error: 'Query parameter "q" is required' },
      { status: 400 }
    );
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    // Simple text search without embeddings
    const result = await client.query(`
      SELECT 
        p.id,
        p.shopify_id,
        p.title,
        p.description,
        p.product_type,
        p.vendor,
        p.cas_number,
        p.un_number,
        p.hazard_class,
        p.status,
        MIN(v.price) as min_price,
        ARRAY_AGG(DISTINCT v.container_size) FILTER (WHERE v.container_size IS NOT NULL) as container_sizes,
        SUM(v.inventory_quantity) > 0 as in_stock
      FROM alliance_products p
      LEFT JOIN alliance_product_variants v ON v.product_id = p.id
      WHERE 
        p.status = 'active'
        AND (
          p.title ILIKE $1
          OR p.description ILIKE $1
          OR p.cas_number ILIKE $1
          OR p.tags ILIKE $1
        )
      GROUP BY p.id
      ORDER BY 
        CASE 
          WHEN p.title ILIKE $2 THEN 1
          WHEN p.cas_number = $3 THEN 2
          ELSE 3
        END,
        p.title
      LIMIT $4 OFFSET $5
    `, [
      `%${query}%`,
      `${query}%`,
      query,
      limit,
      offset
    ]);

    return NextResponse.json({
      products: result.rows,
      total: result.rows.length,
      query,
    });

  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json(
      { error: 'Failed to perform search' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}