import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

/**
 * GET /api/admin/prompts
 * Fetch all prompt templates
 */
export async function GET(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    
    const category = request.nextUrl.searchParams.get('category');
    const activeOnly = request.nextUrl.searchParams.get('active') === 'true';
    
    let query = `
      SELECT 
        id, name, category, description, template_text, system_prompt,
        required_variables, optional_variables, version, is_active, is_default,
        usage_count, success_rate, avg_feedback_score,
        created_at, updated_at
      FROM prompt_templates
      WHERE 1=1
    `;
    
    const params: any[] = [];
    let paramCount = 1;
    
    if (category) {
      query += ` AND category = $${paramCount}`;
      params.push(category);
      paramCount++;
    }
    
    if (activeOnly) {
      query += ` AND is_active = true`;
    }
    
    query += ` ORDER BY category, is_default DESC, version DESC`;
    
    const result = await client.query(query, params);
    
    return NextResponse.json({
      templates: result.rows,
      total: result.rows.length,
    });
    
  } catch (error) {
    console.error('Error fetching templates:', error);
    return NextResponse.json(
      { error: 'Failed to fetch templates' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * POST /api/admin/prompts
 * Create a new prompt template
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    
    const body = await request.json();
    const {
      name,
      category,
      description,
      template_text,
      system_prompt,
      required_variables = [],
      optional_variables = [],
      is_active = true,
      is_default = false,
    } = body;
    
    // If setting as default, unset other defaults in same category
    if (is_default) {
      await client.query(
        `UPDATE prompt_templates 
         SET is_default = false 
         WHERE category = $1 AND is_default = true`,
        [category]
      );
    }
    
    const result = await client.query(
      `INSERT INTO prompt_templates (
        name, category, description, template_text, system_prompt,
        required_variables, optional_variables, is_active, is_default
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id`,
      [
        name,
        category,
        description,
        template_text,
        system_prompt,
        JSON.stringify(required_variables),
        JSON.stringify(optional_variables),
        is_active,
        is_default,
      ]
    );
    
    return NextResponse.json({
      success: true,
      id: result.rows[0].id,
    });
    
  } catch (error) {
    console.error('Error creating template:', error);
    return NextResponse.json(
      { error: 'Failed to create template' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}