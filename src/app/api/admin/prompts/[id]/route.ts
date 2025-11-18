import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

/**
 * GET /api/admin/prompts/:id
 * Fetch a specific prompt template
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    
    const result = await client.query(
      `SELECT * FROM prompt_templates WHERE id = $1`,
      [params.id]
    );
    
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json(result.rows[0]);
    
  } catch (error) {
    console.error('Error fetching template:', error);
    return NextResponse.json(
      { error: 'Failed to fetch template' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * PUT /api/admin/prompts/:id
 * Update a prompt template
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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
      is_active,
      is_default,
      version,
    } = body;
    
    // If setting as default, unset other defaults in same category
    if (is_default) {
      await client.query(
        `UPDATE prompt_templates 
         SET is_default = false 
         WHERE category = $1 AND is_default = true AND id != $2`,
        [category, params.id]
      );
    }
    
    const result = await client.query(
      `UPDATE prompt_templates SET
        name = $1,
        category = $2,
        description = $3,
        template_text = $4,
        system_prompt = $5,
        required_variables = $6,
        optional_variables = $7,
        is_active = $8,
        is_default = $9,
        version = $10,
        updated_at = NOW()
      WHERE id = $11
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
        version,
        params.id,
      ]
    );
    
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      id: result.rows[0].id,
    });
    
  } catch (error) {
    console.error('Error updating template:', error);
    return NextResponse.json(
      { error: 'Failed to update template' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * DELETE /api/admin/prompts/:id
 * Delete a prompt template
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    
    // Soft delete by setting is_active to false
    const result = await client.query(
      `UPDATE prompt_templates 
       SET is_active = false, updated_at = NOW() 
       WHERE id = $1
       RETURNING id`,
      [params.id]
    );
    
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      message: 'Template deactivated',
    });
    
  } catch (error) {
    console.error('Error deleting template:', error);
    return NextResponse.json(
      { error: 'Failed to delete template' },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}