import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { Client } from 'pg';
import { aiCache, CacheService } from '@/lib/cache';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface AgentRequest {
  message: string;
  context?: {
    email_id?: string;
    customer_email?: string;
    customer_name?: string;
    previous_messages?: string[];
  };
  // NEW: Email-specific context from Lambda
  emailContext?: {
    thread?: {
      isReply: boolean;
      threadLength: number;
      previousMessages?: Array<{
        date: string;
        from: string;
        subject: string;
        preview: string;
      }>;
    };
    detected?: {
      productNames: string[];
      quantities: string[];
      orderNumbers: string[];
      phoneNumbers: string[];
      urgency: {
        isUrgent: boolean;
        urgencyLevel: string;
        urgentPhrases: string[];
      };
      sentiment: {
        sentiment: string;
        tone: string;
        negativeIndicators: string[];
        positiveIndicators: string[];
      };
    };
    metadata?: {
      receivedTime: string;
      hasAttachments: boolean;
      importance: string;
      ccRecipients: string[];
      categories: string[];
    };
    sender?: {
      email: string;
      domain: string;
      name: string;
    };
  };
}

interface ToolCall {
  tool: string;
  parameters: any;
}

/**
 * Detect intent from the message and route to appropriate tools
 */
async function detectIntentAndRoute(message: string): Promise<ToolCall[]> {
  const lowercaseMessage = message.toLowerCase();
  const toolCalls: ToolCall[] = [];

  // Order tracking patterns
  const orderPatterns = [
    /order\s*#?\s*(\d+)/i,
    /where.*my.*order/i,
    /track.*order/i,
    /shipping.*status/i,
    /when.*arrive/i,
    /delivery.*date/i,
  ];

  // Quote/pricing patterns
  const quotePatterns = [
    /quote.*for/i,
    /price.*(?:of|for)/i,
    /how much.*cost/i,
    /pricing.*information/i,
    /need.*quote/i,
    /bulk.*pricing/i,
  ];

  // Product search patterns
  const productPatterns = [
    /looking for/i,
    /do you (?:have|sell|carry)/i,
    /need.*(?:gallon|drum|tote|pound|kg)/i,
    /what.*products/i,
    /alternative.*to/i,
    /substitute.*for/i,
  ];

  // Check for order tracking
  if (orderPatterns.some(pattern => pattern.test(message))) {
    const orderMatch = message.match(/\b(\d{4,})\b/);
    if (orderMatch) {
      toolCalls.push({
        tool: 'order-status',
        parameters: { order_number: orderMatch[1] },
      });
    }
  }

  // Check for quote requests
  if (quotePatterns.some(pattern => pattern.test(message))) {
    // Extract product mentions and quantities
    const products = extractProductsFromMessage(message);
    if (products.length > 0) {
      toolCalls.push({
        tool: 'quote',
        parameters: { items: products },
      });
    } else {
      // Need to search for products first
      toolCalls.push({
        tool: 'product-search',
        parameters: { query: message },
      });
    }
  }

  // Check for product searches
  if (productPatterns.some(pattern => pattern.test(message)) && toolCalls.length === 0) {
    toolCalls.push({
      tool: 'product-search',
      parameters: { 
        query: message,
        limit: 5,
      },
    });
  }

  // If no specific intent detected, use general response
  if (toolCalls.length === 0) {
    toolCalls.push({
      tool: 'general-response',
      parameters: { message },
    });
  }

  return toolCalls;
}

/**
 * Extract product mentions from message
 */
function extractProductsFromMessage(message: string): any[] {
  const products = [];
  
  // Common chemical patterns
  const chemicalPatterns = [
    /(\d+)\s*(?:gallons?|gal)\s+(?:of\s+)?([a-z\s]+)/gi,
    /(\d+)\s*(?:drums?)\s+(?:of\s+)?([a-z\s]+)/gi,
    /(\d+)\s*(?:totes?)\s+(?:of\s+)?([a-z\s]+)/gi,
    /(\d+)\s*x\s*(\d+)\s*(?:gallon|gal|drum|tote)\s+([a-z\s]+)/gi,
  ];

  for (const pattern of chemicalPatterns) {
    let match;
    while ((match = pattern.exec(message)) !== null) {
      const quantity = parseInt(match[1]);
      const productName = match[match.length - 1].trim();
      
      products.push({
        product_name: productName,
        quantity: quantity || 1,
        container_size: match[0].includes('drum') ? '55 Gallon' : 
                       match[0].includes('tote') ? '275 Gallon' : 
                       '5 Gallon',
      });
    }
  }

  return products;
}

/**
 * Execute tool calls and format responses
 */
async function executeToolCalls(toolCalls: ToolCall[]): Promise<any[]> {
  const results = [];

  for (const call of toolCalls) {
    try {
      let response;
      
      switch (call.tool) {
        case 'order-status':
          response = await fetch('/api/tools/order-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(call.parameters),
          });
          break;

        case 'product-search':
          response = await fetch('/api/tools/product-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(call.parameters),
          });
          break;

        case 'pricing':
          response = await fetch('/api/tools/pricing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(call.parameters),
          });
          break;

        case 'quote':
          response = await fetch('/api/tools/quote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(call.parameters),
          });
          break;

        default:
          results.push({
            tool: call.tool,
            error: 'Unknown tool',
          });
          continue;
      }

      if (response && response.ok) {
        const data = await response.json();
        results.push({
          tool: call.tool,
          data,
        });
      } else {
        results.push({
          tool: call.tool,
          error: 'Tool execution failed',
        });
      }
    } catch (error) {
      console.error(`Tool ${call.tool} error:`, error);
      results.push({
        tool: call.tool,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Generate natural language response from tool results
 */
async function generateResponse(
  message: string,
  toolResults: any[],
  context?: any,
  emailContext?: any
): Promise<string> {
  // Get appropriate prompt template from database
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();

    // Determine category based on tool results
    let category = 'general';
    if (toolResults.some(r => r.tool === 'order-status')) {
      category = 'order_status';
    } else if (toolResults.some(r => r.tool === 'quote')) {
      category = 'quote_request';
    } else if (toolResults.some(r => r.tool === 'product-search')) {
      category = 'product_inquiry';
    }

    // Get the best template for this category
    const templateResult = await client.query(
      `SELECT template_text, system_prompt 
       FROM prompt_templates 
       WHERE category = $1 AND is_active = true 
       ORDER BY is_default DESC, success_rate DESC NULLS LAST 
       LIMIT 1`,
      [category]
    );

    // Enhanced system prompt with company context
    let systemPrompt = `You are a helpful customer service representative for Alliance Chemical.

COMPANY CONTEXT:
- Alliance Chemical is a chemical distributor based in Austin, Texas
- We ship nationwide via UPS (small packages) and freight carriers (XPO, ABF, SAIA for bulk)
- We provide COAs (Certificates of Analysis), SDS sheets, and other certificates upon request
- Our standard business hours are Monday-Friday 8AM-5PM CST
- We offer both retail and wholesale pricing
- We accept POs from established customers with NET 30 terms
- New customers typically use credit card or wire transfer

RESPONSE GUIDELINES:
- Be professional yet friendly
- Always offer to provide documentation (COA, SDS) when relevant
- Include specific next steps or actions
- For pricing inquiries, mention both retail and wholesale options
- For shipping questions, specify carrier based on order size
- Always include a clear call-to-action`;
    
    let template = '';

    if (templateResult.rows.length > 0 && templateResult.rows[0].system_prompt) {
      // If we have a custom prompt, append our context to it
      systemPrompt = templateResult.rows[0].system_prompt + '\n\n' + systemPrompt;
      template = templateResult.rows[0].template_text;
    }

    // Build enhanced context with email-specific information
    let enhancedPrompt = `Customer inquiry: ${message}\n\n`;
    
    // Add user-provided context if available
    if (context?.user_provided_context) {
      enhancedPrompt = `IMPORTANT CONTEXT FROM USER:\n${context.user_provided_context}\n\n${enhancedPrompt}`;
    }
    
    // Add email context if available
    if (emailContext) {
      // Thread context
      if (emailContext.thread?.isReply) {
        enhancedPrompt += `📧 This is a reply in a thread of ${emailContext.thread.threadLength} messages\n`;
        if (emailContext.thread.previousMessages?.length > 0) {
          enhancedPrompt += 'Previous messages:\n';
          emailContext.thread.previousMessages.forEach((msg: any) => {
            enhancedPrompt += `  - [${msg.date}] ${msg.from}: ${msg.preview}\n`;
          });
        }
      }
      
      // Detected information
      if (emailContext.detected) {
        if (emailContext.detected.productNames?.length > 0) {
          enhancedPrompt += `\n📦 Products mentioned: ${emailContext.detected.productNames.join(', ')}\n`;
        }
        if (emailContext.detected.quantities?.length > 0) {
          enhancedPrompt += `📊 Quantities: ${emailContext.detected.quantities.join(', ')}\n`;
        }
        if (emailContext.detected.orderNumbers?.length > 0) {
          enhancedPrompt += `📋 Order numbers: ${emailContext.detected.orderNumbers.join(', ')}\n`;
        }
        if (emailContext.detected.urgency?.isUrgent) {
          enhancedPrompt += `⚠️ URGENT: ${emailContext.detected.urgency.urgentPhrases.join(', ')}\n`;
        }
        if (emailContext.detected.sentiment) {
          enhancedPrompt += `💬 Tone: ${emailContext.detected.sentiment.tone} (${emailContext.detected.sentiment.sentiment})\n`;
        }
      }
      
      // Sender information
      if (emailContext.sender) {
        enhancedPrompt += `\n👤 From: ${emailContext.sender.name || emailContext.sender.email}\n`;
      }
    }
    
    enhancedPrompt += `\nData retrieved:\n${JSON.stringify(toolResults, null, 2)}\n\n`;
    
    // Add category-specific context
    if (category === 'order_status') {
      enhancedPrompt += `\nADDITIONAL CONTEXT FOR ORDER INQUIRIES:
- Standard shipping times: 1-2 days for UPS, 3-5 days for freight
- Orders ship same day if placed before 2PM CST
- Tracking information is sent automatically via email
- For expedited shipping, mention our rush order options\n`;
    } else if (category === 'quote_request') {
      enhancedPrompt += `\nADDITIONAL CONTEXT FOR QUOTES:
- Wholesale pricing available for orders over $1,000
- Volume discounts: 5% (5+ drums), 10% (10+ drums), 15% (20+ drums)
- Quotes are valid for 30 days
- We can match competitor pricing with verification
- Mention our quick quote turnaround (usually within 2 hours)\n`;
    } else if (category === 'product_inquiry') {
      enhancedPrompt += `\nADDITIONAL CONTEXT FOR PRODUCT INQUIRIES:
- We stock over 500 chemical products
- Custom packaging available (drums, totes, pails, bottles)
- All products come with COA and SDS
- We can source hard-to-find chemicals
- Minimum order is typically 1 gallon for most products\n`;
    }
    
    // Add instructions based on context
    const instructions = [];
    
    // Prioritize user-provided context
    if (context?.user_provided_context) {
      instructions.push('CRITICAL: Pay special attention to the user-provided context above and incorporate it into your response');
    }
    
    if (emailContext?.detected?.urgency?.isUrgent) {
      instructions.push('Acknowledge the urgency and provide expedited options if available');
    }
    
    if (emailContext?.detected?.sentiment?.sentiment === 'negative') {
      instructions.push('Use an empathetic and apologetic tone to address their concerns');
    }
    
    if (emailContext?.detected?.productNames?.length > 0) {
      instructions.push('Reference the specific products they mentioned');
    }
    
    if (emailContext?.detected?.quantities?.length > 0) {
      instructions.push('Address the specific quantities requested');
    }
    
    if (emailContext?.thread?.isReply) {
      instructions.push('Reference the previous conversation context');
    }
    
    if (emailContext?.detected?.sentiment?.tone === 'formal') {
      instructions.push('Use a professional, formal tone matching their communication style');
    } else {
      instructions.push('Use a friendly, conversational tone');
    }
    
    if (instructions.length > 0) {
      enhancedPrompt += 'Instructions:\n' + instructions.map(i => `- ${i}`).join('\n') + '\n\n';
    }
    
    // Add common FAQ context
    enhancedPrompt += `\nCOMMON INFORMATION TO REFERENCE:
- Payment methods: Credit card, Wire transfer, ACH, Purchase Order (approved accounts)
- Return policy: Unopened products within 30 days with 15% restocking fee
- Emergency spill hotline: 1-800-424-9300 (CHEMTREC)
- Customer service hours: M-F 8AM-5PM CST
- Phone: 512-555-0100 | Email: sales@alliancechemical.com
- We maintain $5M in liability insurance
- ISO 9001:2015 certified facility\n\n`;
    
    enhancedPrompt += 'Please provide a helpful, accurate response based on this data and context. End your response with a specific call-to-action or next step.';

    // Generate response using OpenAI
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_LLM_MODEL || 'gpt-4-turbo-preview',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: enhancedPrompt,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0].message.content || 'I apologize, but I was unable to generate a response.';

  } catch (error) {
    console.error('Response generation error:', error);
    return 'I apologize for the inconvenience. I encountered an error while processing your request. Please try again or contact our support team directly.';
  } finally {
    await client.end();
  }
}

/**
 * POST /api/agent
 * Unified agent endpoint that orchestrates all tools
 */
export async function POST(request: NextRequest) {
  try {
    const body: AgentRequest = await request.json();
    const { message, context, emailContext } = body;

    if (!message) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    // Create cache key
    const cacheKey = CacheService.createKey('agent', message);

    // Check cache first
    const cachedResponse = await aiCache.get(cacheKey);
    if (cachedResponse) {
      return NextResponse.json(cachedResponse);
    }

    // Detect intent and determine which tools to use
    const toolCalls = await detectIntentAndRoute(message);

    // Execute the tool calls
    const toolResults = await executeToolCalls(toolCalls);

    // Generate natural language response with email context
    const response = await generateResponse(message, toolResults, context, emailContext);

    // Build final response
    const finalResponse = {
      success: true,
      message: response,
      tools_used: toolCalls.map(t => t.tool),
      confidence: toolResults.some(r => r.error) ? 0.7 : 0.95,
      metadata: {
        timestamp: new Date().toISOString(),
        cached: false,
      },
    };

    // Cache the response for 1 hour
    await aiCache.set(cacheKey, finalResponse, { ttl: 3600 });

    // Log the interaction for analytics
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
    });

    try {
      await client.connect();
      await client.query(
        `INSERT INTO alliance_search_logs (
          query_text, 
          result_count, 
          filters,
          created_at
        ) VALUES ($1, $2, $3, NOW())`,
        [
          message,
          toolResults.filter(r => !r.error).length,
          JSON.stringify({ tools: toolCalls }),
        ]
      );
    } catch (logError) {
      console.error('Failed to log interaction:', logError);
    } finally {
      await client.end();
    }

    return NextResponse.json(finalResponse);

  } catch (error) {
    console.error('Agent error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to process request',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}