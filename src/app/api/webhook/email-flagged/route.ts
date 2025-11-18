import { NextRequest, NextResponse } from 'next/server';
import { Client } from 'pg';

interface EmailFlaggedWebhook {
  messageId: string;
  senderEmail: string;
  subject: string;
  classification: string;
  bodyText?: string;
  bodyPreview?: string;
  aiReasoning?: string;
  aiConfidence?: number;
  aiFactors?: any;
}

/**
 * POST /api/webhook/email-flagged
 * Called by Lambda when an email is flagged
 * Generates AI response and stores it for review
 */
export async function POST(request: NextRequest) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Verify webhook secret if configured
    const webhookSecret = request.headers.get('x-webhook-secret');
    if (process.env.EMAIL_PROCESSING_SECRET && webhookSecret !== process.env.EMAIL_PROCESSING_SECRET) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body: EmailFlaggedWebhook = await request.json();
    const {
      messageId,
      senderEmail,
      subject,
      classification,
      bodyText,
      bodyPreview,
      aiReasoning,
      aiConfidence,
      aiFactors,
    } = body;

    if (!messageId || !senderEmail || !subject) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    console.log(`Processing flagged email: ${messageId} from ${senderEmail}`);

    // Call our agent API to generate a response
    const agentResponse = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: bodyText || bodyPreview || `Subject: ${subject}`,
          context: {
            email_id: messageId,
            customer_email: senderEmail,
            customer_name: senderEmail.split('@')[0],
            classification,
            subject,
          },
        }),
      }
    );

    let generatedResponse = '';
    let toolsUsed: string[] = [];
    let responseConfidence = 0.5;

    if (agentResponse.ok) {
      const agentData = await agentResponse.json();
      generatedResponse = agentData.message || '';
      toolsUsed = agentData.tools_used || [];
      responseConfidence = agentData.confidence || 0.5;
    } else {
      // Fallback to a template response if agent fails
      generatedResponse = await generateFallbackResponse(
        classification,
        subject,
        senderEmail
      );
    }

    // Store the generated response in database
    await client.connect();

    // Create or update response draft
    await client.query(
      `INSERT INTO email_response_drafts (
        message_id,
        sender_email,
        subject,
        classification,
        draft_response,
        tools_used,
        confidence_score,
        generated_at,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 'pending')
      ON CONFLICT (message_id) 
      DO UPDATE SET 
        draft_response = $5,
        tools_used = $6,
        confidence_score = $7,
        generated_at = NOW(),
        status = 'pending'`,
      [
        messageId,
        senderEmail,
        subject,
        classification,
        generatedResponse,
        JSON.stringify(toolsUsed),
        responseConfidence,
      ]
    );

    // Update email_feedback table to track this flagged email
    await client.query(
      `INSERT INTO email_feedback (
        message_id,
        flagged_at,
        responded,
        created_at
      ) VALUES ($1, NOW(), false, NOW())
      ON CONFLICT (message_id) DO NOTHING`,
      [messageId]
    );

    // Log the webhook event
    await client.query(
      `INSERT INTO webhook_events (
        event_type,
        message_id,
        payload,
        created_at
      ) VALUES ($1, $2, $3, NOW())`,
      [
        'email_flagged',
        messageId,
        JSON.stringify({
          classification,
          tools_used: toolsUsed,
          confidence: responseConfidence,
        }),
      ]
    );

    console.log(`Generated response for ${messageId} using tools: ${toolsUsed.join(', ')}`);

    return NextResponse.json({
      success: true,
      message_id: messageId,
      response_generated: true,
      tools_used: toolsUsed,
      confidence: responseConfidence,
    });

  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      {
        error: 'Failed to process webhook',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    await client.end();
  }
}

/**
 * Generate a fallback response when agent API fails
 */
async function generateFallbackResponse(
  classification: string,
  subject: string,
  senderEmail: string
): Promise<string> {
  const templates: Record<string, string> = {
    QUOTE_REQUEST: `Thank you for your inquiry about "${subject}".

I'll prepare a detailed quote for you right away. To ensure accuracy, could you please confirm:
- Quantity needed
- Delivery location
- Any specific grade or purity requirements

I'll get back to you within 1 business day with pricing and availability.

Best regards,
Alliance Chemical Sales Team`,

    ORDER_STATUS: `Thank you for checking on your order status.

I'm looking into "${subject}" for you now. Could you please provide your order number so I can give you the most accurate tracking information?

You can also track your order directly at: https://alliance-chemical.com/track

Best regards,
Alliance Chemical Customer Service`,

    PRODUCT_QUESTION: `Thank you for your question about "${subject}".

I'll be happy to help you with product information. Our technical team will review your inquiry and provide detailed specifications and recommendations.

We'll respond within 1 business day with complete information.

Best regards,
Alliance Chemical Technical Support`,

    COMPLAINT: `Thank you for bringing this to our attention.

We take all customer concerns seriously. I've escalated your message about "${subject}" to our management team for immediate review.

You can expect a response within 4 business hours.

We appreciate your patience and the opportunity to make this right.

Best regards,
Alliance Chemical Customer Service`,

    DEFAULT: `Thank you for contacting Alliance Chemical.

I've received your message about "${subject}" and will ensure the appropriate team member responds promptly.

We typically respond within 1 business day.

Best regards,
Alliance Chemical Team`,
  };

  return templates[classification] || templates.DEFAULT;
}

/**
 * GET /api/webhook/email-flagged
 * Health check endpoint
 */
export async function GET(request: NextRequest) {
  return NextResponse.json({
    status: 'healthy',
    endpoint: '/api/webhook/email-flagged',
    ready: true,
  });
}