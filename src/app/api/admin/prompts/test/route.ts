import { NextRequest, NextResponse } from 'next/server';

/**
 * Simple template renderer using regex replacement
 * Supports {{variable}} and {{#if condition}} blocks
 */
function renderTemplate(template: string, variables: Record<string, any>): string {
  let rendered = template;
  
  // Handle conditional blocks {{#if variable}}...{{/if}}
  rendered = rendered.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (match, varName, content) => {
      return variables[varName] ? content : '';
    }
  );
  
  // Handle simple variable replacement {{variable}}
  rendered = rendered.replace(
    /\{\{(\w+)\}\}/g,
    (match, varName) => {
      return variables[varName] !== undefined ? String(variables[varName]) : match;
    }
  );
  
  return rendered;
}

/**
 * POST /api/admin/prompts/test
 * Test a prompt template with sample variables
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { template, variables = {} } = body;
    
    if (!template) {
      return NextResponse.json(
        { error: 'Template is required' },
        { status: 400 }
      );
    }
    
    // Extract required variables from template
    const variablePattern = /\{\{(?:#if\s+)?(\w+)\}\}/g;
    const foundVariables = new Set<string>();
    let match;
    
    while ((match = variablePattern.exec(template)) !== null) {
      foundVariables.add(match[1]);
    }
    
    // Check for missing required variables
    const missingVars = Array.from(foundVariables).filter(
      v => !(v in variables)
    );
    
    // Render the template
    const rendered = renderTemplate(template, variables);
    
    return NextResponse.json({
      rendered,
      variables_used: Array.from(foundVariables),
      missing_variables: missingVars,
      warning: missingVars.length > 0 
        ? `Missing variables: ${missingVars.join(', ')}`
        : null,
    });
    
  } catch (error) {
    console.error('Error testing template:', error);
    return NextResponse.json(
      { 
        error: 'Failed to test template',
        rendered: '',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}