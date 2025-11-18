import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

interface ResponseFeedback {
  message_id: string;
  draft_response: string;
  final_response: string;
  was_edited: boolean;
  sent_by?: string;
  tools_used?: string[];
  confidence_score?: number;
}

/**
 * Calculate simple edit distance (character difference)
 * In production, you'd use a proper Levenshtein distance algorithm
 */
function calculateEditDistance(str1: string, str2: string): number {
  if (str1 === str2) return 0;
  
  // Simple character count difference for now
  const lengthDiff = Math.abs(str1.length - str2.length);
  
  // Count character differences in the overlap
  const minLength = Math.min(str1.length, str2.length);
  let differences = lengthDiff;
  
  for (let i = 0; i < minLength; i++) {
    if (str1[i] !== str2[i]) {
      differences++;
    }
  }
  
  return differences;
}

/**
 * Analyze what was changed between draft and final
 */
function analyzeEdits(draft: string, final: string): string {
  if (draft === final) return 'No changes made';
  
  const draftLines = draft.split('\n');
  const finalLines = final.split('\n');
  
  const changes = [];
  
  if (draftLines.length !== finalLines.length) {
    changes.push(`Line count changed: ${draftLines.length} → ${finalLines.length}`);
  }
  
  if (final.length < draft.length * 0.5) {
    changes.push('Response significantly shortened');
  } else if (final.length > draft.length * 1.5) {
    changes.push('Response significantly expanded');
  }
  
  // Check for common patterns
  if (draft.includes('Thank you') && !final.includes('Thank you')) {
    changes.push('Removed greeting');
  }
  if (!draft.includes('Best regards') && final.includes('Best regards')) {
    changes.push('Added closing');
  }
  
  return changes.length > 0 ? changes.join(', ') : 'Minor edits';
}

/**
 * POST /api/feedback/response-sent
 * Track when a response is sent and how it was edited
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const body: ResponseFeedback = await request.json();
    const {
      message_id,
      draft_response,
      final_response,
      was_edited,
      sent_by,
      tools_used,
      confidence_score,
    } = body;

    if (!message_id || !final_response) {
      return NextResponse.json(
        { error: 'message_id and final_response are required' },
        { status: 400 }
      );
    }

    await client.connect();

    // Calculate edit metrics
    const editDistance = was_edited && draft_response 
      ? calculateEditDistance(draft_response, final_response)
      : 0;
    
    const editSummary = was_edited && draft_response
      ? analyzeEdits(draft_response, final_response)
      : 'No changes made';

    // Update the response draft record
    await client.query(
      `UPDATE email_response_drafts 
       SET 
         final_response = $1,
         was_edited = $2,
         edit_distance = $3,
         edit_summary = $4,
         status = 'sent',
         sent_at = NOW(),
         reviewed_by = $5
       WHERE message_id = $6`,
      [
        final_response,
        was_edited,
        editDistance,
        editSummary,
        sent_by || 'unknown',
        message_id,
      ]
    );

    // Update email_feedback to mark as responded
    await client.query(
      `UPDATE email_feedback 
       SET 
         responded = true,
         days_to_response = EXTRACT(DAY FROM NOW() - flagged_at),
         response_category = $1,
         updated_at = NOW()
       WHERE message_id = $2`,
      [
        was_edited ? 'edited' : 'sent_as_is',
        message_id,
      ]
    );

    // Track template usage if applicable
    if (tools_used && tools_used.length > 0) {
      await client.query(
        `INSERT INTO template_usage (
          message_id,
          tools_used,
          was_sent,
          was_edited,
          used_at
        ) VALUES ($1, $2, true, $3, NOW())`,
        [
          message_id,
          tools_used,
          was_edited,
        ]
      );
    }

    // Update system metrics
    await client.query(
      `INSERT INTO system_metrics (
        metric_name,
        metric_value,
        metric_unit,
        component
      ) VALUES 
        ('responses_sent', 1, 'count', 'feedback'),
        ('edit_rate', $1, 'percentage', 'feedback')
      ON CONFLICT DO NOTHING`,
      [was_edited ? 100 : 0]
    );

    // If the response was heavily edited, store it for prompt improvement
    if (was_edited && editDistance > 100) {
      await client.query(
        `INSERT INTO response_feedback (
          email_id,
          email_subject,
          email_body,
          generated_response,
          final_response,
          was_accurate,
          feedback_text,
          feedback_category,
          confidence_score,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, false, $6, 'heavy_edit', $7, NOW())`,
        [
          message_id,
          '', // Subject would need to be passed in
          '', // Body would need to be passed in
          draft_response,
          final_response,
          editSummary,
          confidence_score || 0,
        ]
      );
    }

    // Calculate feedback metrics for this sender
    const metricsResult = await client.query(
      `SELECT 
        COUNT(*) as total_responses,
        AVG(CASE WHEN was_edited THEN 1 ELSE 0 END) * 100 as edit_rate,
        AVG(confidence_score) as avg_confidence
      FROM email_response_drafts
      WHERE sender_email = (
        SELECT sender_email FROM email_response_drafts WHERE message_id = $1 LIMIT 1
      )`,
      [message_id]
    );

    const metrics = metricsResult.rows[0];

    return NextResponse.json({
      success: true,
      message_id,
      feedback_recorded: true,
      was_edited,
      edit_distance: editDistance,
      edit_summary: editSummary,
      sender_metrics: {
        total_responses: parseInt(metrics.total_responses),
        edit_rate: parseFloat(metrics.edit_rate || 0).toFixed(1),
        avg_confidence: parseFloat(metrics.avg_confidence || 0).toFixed(2),
      },
    });

  } catch (error) {
    console.error('Feedback tracking error:', error);
    return NextResponse.json(
      {
        error: 'Failed to track feedback',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * GET /api/feedback/response-sent
 * Get feedback metrics
 */
export async function GET(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    const searchParams = request.nextUrl.searchParams;
    const days = parseInt(searchParams.get('days') || '7');

    // Get overall metrics
    const metricsResult = await client.query(
      `SELECT 
        COUNT(*) as total_responses,
        COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_responses,
        COUNT(CASE WHEN was_edited THEN 1 END) as edited_responses,
        AVG(confidence_score) as avg_confidence,
        AVG(edit_distance) as avg_edit_distance
      FROM email_response_drafts
      WHERE generated_at > NOW() - INTERVAL '${days} days'`
    );

    // Get tool usage stats
    const toolsResult = await client.query(
      `SELECT 
        tool,
        COUNT(*) as usage_count
      FROM (
        SELECT jsonb_array_elements_text(tools_used) as tool
        FROM email_response_drafts
        WHERE generated_at > NOW() - INTERVAL '${days} days'
          AND tools_used IS NOT NULL
      ) t
      GROUP BY tool
      ORDER BY usage_count DESC`
    );

    // Get edit patterns
    const editPatternsResult = await client.query(
      `SELECT 
        edit_summary,
        COUNT(*) as occurrence_count
      FROM email_response_drafts
      WHERE was_edited = true
        AND generated_at > NOW() - INTERVAL '${days} days'
        AND edit_summary IS NOT NULL
      GROUP BY edit_summary
      ORDER BY occurrence_count DESC
      LIMIT 10`
    );

    const metrics = metricsResult.rows[0];
    
    return NextResponse.json({
      period_days: days,
      total_responses: parseInt(metrics.total_responses),
      sent_responses: parseInt(metrics.sent_responses),
      edited_responses: parseInt(metrics.edited_responses),
      edit_rate: ((parseInt(metrics.edited_responses) / parseInt(metrics.total_responses)) * 100).toFixed(1),
      avg_confidence: parseFloat(metrics.avg_confidence || 0).toFixed(2),
      avg_edit_distance: parseFloat(metrics.avg_edit_distance || 0).toFixed(0),
      tool_usage: toolsResult.rows,
      common_edits: editPatternsResult.rows,
    });

  } catch (error) {
    console.error('Metrics retrieval error:', error);
    return NextResponse.json(
      {
        error: 'Failed to retrieve metrics',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}