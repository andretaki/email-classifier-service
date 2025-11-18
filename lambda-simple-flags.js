// Simple Lambda handler with basic flagging (no colors)
const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
const { desc, gte, sql, and, eq } = require('drizzle-orm');
const { pgTable, text, timestamp, boolean, integer, serial, decimal, jsonb } = require('drizzle-orm/pg-core');
const axios = require('axios');

// Database schema with new email content columns
const processedEmails = pgTable('email_classifier_processed_emails', {
  id: serial('id').primaryKey(),
  messageId: text('message_id').notNull().unique(),
  internetMessageId: text('internet_message_id'),
  subject: text('subject'),
  senderEmail: text('sender_email'),
  classification: text('classification').notNull(),
  status: text('status').notNull(),
  flagged: boolean('flagged').default(false),
  error: text('error'),
  processedAt: timestamp('processed_at').defaultNow().notNull(),
  // Email content columns
  bodyText: text('body_text'),
  bodyHtml: text('body_html'), 
  bodyPreview: text('body_preview'),
  // AI analysis columns
  aiReasoning: text('ai_reasoning'),
  aiConfidence: decimal('ai_confidence'),
  aiFactors: jsonb('ai_factors')
});

const processingStats = pgTable('email_classifier_processing_stats', {
  id: serial('id').primaryKey(),
  date: timestamp('date').defaultNow().notNull(),
  processed: integer('processed').notNull().default(0),
  flagged: integer('flagged').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  discarded: integer('discarded').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  duration_ms: integer('duration_ms').notNull().default(0),
});

// Learning table to track patterns (simplified schema)
const emailPatterns = pgTable('email_classifier_patterns', {
  id: serial('id').primaryKey(),
  patternType: text('pattern_type'),
  patternValue: text('pattern_value'),
  typicalClassification: text('typical_classification'),
  confidenceBoost: decimal('confidence_boost'),
  occurrenceCount: integer('occurrence_count').default(1),
  lastSeen: timestamp('last_seen').defaultNow(),
});

// Feedback table schema
const emailFeedback = pgTable('email_feedback', {
  messageId: text('message_id').primaryKey(),
  flaggedAt: timestamp('flagged_at').notNull(),
  responded: boolean('responded').default(false),
  daysToResponse: integer('days_to_response'),
  responseCategory: text('response_category'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Classifications that should be flagged
const CLASSIFICATIONS_TO_FLAG = [
  'ANGRY_CUSTOMER',
  'COMPLAINT', 
  'URGENT_REQUEST',
  'QUOTE_REQUEST',
  'NEW_LEAD',
  'PURCHASE_INTENT',
  'PRICING_INQUIRY',
  'GENERAL_INQUIRY',
  'PRODUCT_QUESTION',
  'CUSTOMER_SUPPORT_REQUEST',
  'TESTIMONIAL',
  'THANK_YOU',
  'PURCHASE_ORDER_FORWARD',
];

// Classifications to skip/discard
const CLASSIFICATIONS_TO_SKIP = [
  'SPAM_PHISHING',
  'MARKETING_PROMOTIONAL',
  'OUT_OF_OFFICE',
  'SYSTEM_NOTIFICATION',
  'PERSONAL_INTERNAL',
  'NEWSLETTER_SIGNUP',
  'VENDOR_BUSINESS',
  'AMAZON_NOTIFICATION',
  'FREIGHT_NOTIFICATION',
  'PAYMENT_NOTIFICATION',
  'SURVEY_RESPONSE'
];

// System notification domains to auto-skip
const SYSTEM_DOMAINS = [
  // Marketplaces - ANY subdomain included
  'amazon.com', 'amazonservices.com', 'marketplace.amazon.com', 'sellercentral.amazon.com',
  'shopify.com', 'shop.app',
  // Freight companies
  'fedex.com', 'ups.com', 'xpo.com', 'odfl.com', 'yrc.com',
  'estes-express.com', 'rlcarriers.com', 'saia.com', 'abf.com', 'lojistic.com',
  // Payment processors
  'stripe.com', 'paypal.com', 'square.com', 'authorize.net', 'bill.com',
  // Email marketing
  'klaviyo.com', 'mailchimp.com', 'constantcontact.com', 'ndia.org',
  // Additional marketing/system sources reported as false positives
  'tiktok.com', 'tiktokshop.com',
  'linkedin.com',
  'yotpo.com',
  'ccsend.com',
  'github.com',
  'vercel.com',
  'eventbrite.com',
  'canva.com',
  'emmerandrye.com',
  'shipstation.com'
];

// Known safe senders that should never be flagged
const AUTO_SKIP_RULES = [
  {
    name: 'TikTok Shop Support Survey',
    classification: 'SYSTEM_NOTIFICATION',
    reason: 'Automatic feedback request from TikTok Shop support',
    domains: ['tiktok.com', 'tiktokshop.com'],
    subjectKeywords: ['support', 'ticket', 'onboarding', 'feedback', 'rate your experience']
  },
  {
    name: 'LinkedIn Notifications',
    classification: 'MARKETING_PROMOTIONAL',
    reason: 'LinkedIn marketing or notification email',
    domains: ['linkedin.com']
  },
  {
    name: 'Yotpo Review Requests',
    classification: 'SYSTEM_NOTIFICATION',
    reason: 'Automated Yotpo review system message',
    domains: ['yotpo.com']
  },
  {
    name: 'Constant Contact Marketing',
    classification: 'MARKETING_PROMOTIONAL',
    reason: 'Newsletter sent via Constant Contact',
    domains: ['ccsend.com', 'constantcontact.com']
  },
  {
    name: 'GitHub Notifications',
    classification: 'SYSTEM_NOTIFICATION',
    reason: 'Automated GitHub notification',
    domains: ['github.com']
  },
  {
    name: 'Eventbrite Marketing',
    classification: 'MARKETING_PROMOTIONAL',
    reason: 'Eventbrite marketing or promotional campaign',
    domains: ['eventbrite.com']
  },
  {
    name: 'Canva Notifications',
    classification: 'MARKETING_PROMOTIONAL',
    reason: 'Automated Canva account or marketing notification',
    domains: ['canva.com']
  },
  {
    name: 'Emmer and Rye Hospitality',
    classification: 'MARKETING_PROMOTIONAL',
    reason: 'Hospitality group marketing or community announcement',
    domains: ['emmerandrye.com']
  },
  {
    name: 'ShipStation Tracking',
    classification: 'SYSTEM_NOTIFICATION',
    reason: 'Automated shipment or tracking update from ShipStation',
    domains: ['shipstation.com'],
    subjectKeywords: ['tracking', 'shipment', 'fulfillment', 'package']
  },
  {
    name: 'Automatic Reply Subject',
    classification: 'OUT_OF_OFFICE',
    reason: 'Automatic reply detected in subject line',
    matchAll: true,
    subjectKeywords: [
      'automatic reply:',
      'automatic reply',
      'auto reply',
      'autoreply',
      'out of office',
      'out-of-office'
    ]
  }
];

// Known senders that should be flagged automatically
const AUTO_FLAG_RULES = [
  {
    name: 'Shopify Mailer Alerts',
    classification: 'CUSTOMER_SUPPORT_REQUEST',
    reason: 'Shopify order or fulfillment notification requiring follow-up',
    addresses: ['mailer@shopify.com'],
    domains: ['shopify.com'],
    confidence: 0.95
  }
];

function matchesDomain(senderDomain, domain) {
  if (!senderDomain || !domain) return false;
  return senderDomain === domain || senderDomain.endsWith(`.${domain}`);
}

function isSystemNotificationDomain(senderDomain) {
  return SYSTEM_DOMAINS.some(domain => matchesDomain(senderDomain, domain));
}

function getAutoSkipRule(email) {
  const senderEmail = email.from?.emailAddress?.address?.toLowerCase() || '';
  if (!senderEmail) return null;

  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
  const subject = email.subject?.toLowerCase() || '';

  for (const rule of AUTO_SKIP_RULES) {
    const domainMatch = rule.domains?.some(domain => matchesDomain(senderDomain, domain)) || false;
    const addressMatch = rule.addresses?.includes(senderEmail) || false;

    if (!rule.matchAll && !domainMatch && !addressMatch) {
      continue;
    }

    if (rule.subjectKeywords && !rule.subjectKeywords.some(keyword => subject.includes(keyword))) {
      continue;
    }

    return {
      classification: rule.classification,
      reason: rule.reason,
      name: rule.name
    };
  }

  return null;
}

function getAutoFlagRule(email) {
  const senderEmail = email.from?.emailAddress?.address?.toLowerCase() || '';
  if (!senderEmail) return null;

  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
  const subject = email.subject?.toLowerCase() || '';

  for (const rule of AUTO_FLAG_RULES) {
    const addressMatch = rule.addresses?.includes(senderEmail) || false;
    const domainMatch = rule.domains?.some(domain => matchesDomain(senderDomain, domain)) || false;

    if (!rule.matchAll && !addressMatch && !domainMatch) {
      continue;
    }

    if (rule.subjectKeywords && !rule.subjectKeywords.some(keyword => subject.includes(keyword))) {
      continue;
    }

    return {
      classification: rule.classification,
      confidence: rule.confidence,
      reason: rule.reason,
      name: rule.name
    };
  }

  return null;
}

// Check if an email is from Amazon (including all subdomains and variations)
function isAmazonEmail(email) {
  const from = email.from?.emailAddress?.address?.toLowerCase() || '';
  const senderName = email.from?.emailAddress?.name?.toLowerCase() || '';
  const subject = email.subject?.toLowerCase() || '';
  const body = email.bodyPreview?.toLowerCase() || '';

  // Check sender address for ANY Amazon domain or marketplace address
  if (from.includes('@amazon.com') ||                    // Catches donotreply@amazon.com, atoz-guarantee-no-reply@amazon.com
      from.includes('@amazonservices.com') ||
      from.includes('@marketplace.amazon.com') ||        // Catches all customer messages through marketplace
      from.includes('marketplace.amazon')) {             // Catches any variation
    return true;
  }

  // Check sender name for Amazon variations
  if (senderName.includes('amazon') ||
      senderName.includes('seller central') ||
      senderName.includes('marketplace')) {
    return true;
  }

  // Check for marketplace message patterns (customer messages through Amazon)
  // These use format: random+guid@marketplace.amazon.com
  if (from.match(/[a-z0-9]+\+[a-f0-9\-]+@marketplace\.amazon\.com/)) {
    return true;
  }

  // Check for Amazon-specific markers in email body
  if (body.includes('spc-usamazon-') ||
      body.includes('seller central') ||
      body.includes('amazon services') ||
      body.includes('a-to-z guarantee') ||
      body.includes('amazon.com') ||
      body.includes('marketplace.amazon')) {
    return true;
  }

  // Check for Amazon-specific subject patterns
  if (subject.includes('a-to-z guarantee') ||
      subject.includes('return request') ||
      subject.includes('you have received a message') ||
      subject.includes('amazon') ||
      subject.includes('seller central') ||
      subject.includes('[commMgrTok:')) {
    return true;
  }

  return false;
}

// Helper functions
const createResponse = (statusCode, body, headers = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...headers
  },
  body: JSON.stringify(body)
});

const getDb = () => {
  const client = postgres(process.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return drizzle(client);
};

// Microsoft Graph helper
async function getAccessToken() {
  const tokenEndpoint = `https://login.microsoftonline.com/${process.env.MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_GRAPH_CLIENT_ID,
    client_secret: process.env.MICROSOFT_GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await axios.post(tokenEndpoint, params);
  return response.data.access_token;
}

// Apply flag to email in Outlook
async function applyFlag(emailId, mailbox, accessToken, justification) {
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${emailId}`;

  try {
    await axios.patch(graphUrl, {
      flag: {
        flagStatus: "flagged"
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Flagged email ${emailId} in ${mailbox} - ${justification}`);
    return true;
  } catch (error) {
    console.error(`Failed to flag email ${emailId}:`, error.response?.data || error.message);
    return false;
  }
}

// Fetch full email content from Microsoft Graph
async function fetchEmailContent(emailId, mailbox, accessToken) {
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${emailId}?$select=body,bodyPreview`;
  
  try {
    const response = await axios.get(graphUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const email = response.data;
    const bodyContent = email.body?.content || email.bodyPreview || '';
    
    return {
      bodyText: bodyContent.replace(/<[^>]*>/g, '').trim(), // Strip HTML tags
      bodyHtml: email.body?.contentType === 'html' ? bodyContent : null,
      bodyPreview: email.bodyPreview?.slice(0, 200) || bodyContent.slice(0, 200)
    };
  } catch (error) {
    console.error(`Failed to fetch email content ${emailId}:`, error.response?.data || error.message);
    return {
      bodyText: 'Failed to fetch email content',
      bodyHtml: null,
      bodyPreview: 'Content unavailable'
    };
  }
}

// Mark email as read
async function markAsRead(emailId, mailbox, accessToken) {
  const graphUrl = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${emailId}`;
  
  try {
    await axios.patch(graphUrl, {
      isRead: true
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`Marked as read: ${emailId}`);
  } catch (error) {
    console.error(`Failed to mark as read ${emailId}:`, error.response?.data || error.message);
  }
}

// Extract product names from email text
function extractProductNames(bodyText) {
  const products = [];
  const productPatterns = [
    /(\d+%?\s+)?(acetone|methanol|ipa|isopropyl|sulfuric|hydrochloric|glycol|sodium hydroxide|caustic|peroxide)/gi,
    /\b(cas\s*#?\s*\d{2,7}-\d{2}-\d{1,2})/gi,
    /\b(un\s*\d{4})\b/gi,
    /(vinegar|d-limonene|mek|mibk|xylene|toluene|glycerin)/gi
  ];
  
  productPatterns.forEach(pattern => {
    const matches = bodyText.match(pattern);
    if (matches) products.push(...matches);
  });
  
  return [...new Set(products.map(p => p.trim()))];
}

// Extract quantities and container sizes
function extractQuantities(bodyText) {
  const quantities = [];
  const patterns = [
    /(\d+)\s*(drums?|gallons?|gal|liters?|kg|lbs?|tons?|cases?|pallets?)/gi,
    /(\d+)\s*x\s*(\d+)\s*(gal|gallons?|drums?|bottles?|cases?)/gi,
    /(\d+)\s*-\s*(\d+)\s*(gallons?|drums?)/gi
  ];
  
  patterns.forEach(pattern => {
    const matches = bodyText.match(pattern);
    if (matches) quantities.push(...matches);
  });
  
  return quantities.map(q => q.trim());
}

// Extract order numbers from email
function extractOrderNumbers(bodyText) {
  const orderPatterns = [
    /\b(AC|PO|SO|INV)-?\d{4,8}\b/gi,
    /order\s*#?\s*(\d{4,8})/gi,
    /invoice\s*#?\s*(\d{4,8})/gi,
    /po\s*#?\s*(\d{4,8})/gi
  ];
  
  const orders = [];
  orderPatterns.forEach(pattern => {
    const matches = bodyText.match(pattern);
    if (matches) orders.push(...matches);
  });
  
  return [...new Set(orders)];
}

// Extract phone numbers
function extractPhoneNumbers(bodyText) {
  const phonePattern = /(\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/g;
  const matches = bodyText.match(phonePattern);
  return matches ? [...new Set(matches)] : [];
}

// Detect urgency in email
function detectUrgency(bodyText) {
  const urgentWords = [
    'urgent', 'asap', 'immediately', 'today', 'rush',
    'emergency', 'critical', 'by end of day', 'eod', 'expedite',
    'as soon as possible', 'right away', 'time sensitive'
  ];
  
  const lower = bodyText.toLowerCase();
  const urgencyScore = urgentWords.reduce((score, word) => 
    score + (lower.includes(word) ? 1 : 0), 0
  );
  
  return {
    isUrgent: urgencyScore > 0,
    urgencyLevel: urgencyScore > 2 ? 'high' : urgencyScore > 0 ? 'medium' : 'low',
    urgentPhrases: urgentWords.filter(w => lower.includes(w))
  };
}

// Detect sentiment/tone
function detectSentiment(bodyText) {
  const lower = bodyText.toLowerCase();
  
  const negativeWords = ['angry', 'frustrated', 'disappointed', 'unacceptable', 'terrible', 'awful', 'complaint'];
  const positiveWords = ['thank', 'appreciate', 'excellent', 'great', 'happy', 'pleased', 'wonderful'];
  const formalIndicators = ['dear', 'sincerely', 'regards', 'respectfully', 'mr.', 'ms.', 'dr.'];
  
  const negativeScore = negativeWords.filter(w => lower.includes(w)).length;
  const positiveScore = positiveWords.filter(w => lower.includes(w)).length;
  const formalScore = formalIndicators.filter(w => lower.includes(w)).length;
  
  return {
    sentiment: negativeScore > positiveScore ? 'negative' : positiveScore > 0 ? 'positive' : 'neutral',
    tone: formalScore >= 2 ? 'formal' : 'casual',
    negativeIndicators: negativeWords.filter(w => lower.includes(w)),
    positiveIndicators: positiveWords.filter(w => lower.includes(w))
  };
}

// Get thread information
async function getThreadInfo(emailId, conversationId, mailbox, accessToken) {
  if (!conversationId) return { isReply: false, threadLength: 1 };
  
  try {
    const graphUrl = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?$filter=conversationId eq '${conversationId}'&$select=id,subject,from,receivedDateTime,bodyPreview&$top=5&$orderby=receivedDateTime desc`;
    
    const response = await axios.get(graphUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    const messages = response.data.value || [];
    const isReply = messages.length > 1;
    
    return {
      isReply,
      threadLength: messages.length,
      previousMessages: messages.slice(1, 4).map(m => ({
        date: m.receivedDateTime,
        from: m.from?.emailAddress?.address,
        subject: m.subject,
        preview: m.bodyPreview?.slice(0, 100)
      }))
    };
  } catch (error) {
    console.error('Failed to get thread info:', error.message);
    return { isReply: false, threadLength: 1 };
  }
}

// Extract email-specific context
async function extractEmailContext(email, mailbox, accessToken) {
  const bodyText = email.bodyPreview || '';
  
  // Get thread information
  const threadInfo = await getThreadInfo(
    email.id, 
    email.conversationId, 
    mailbox, 
    accessToken
  );
  
  // Extract entities from email
  const detectedInfo = {
    productNames: extractProductNames(bodyText),
    quantities: extractQuantities(bodyText),
    orderNumbers: extractOrderNumbers(bodyText),
    phoneNumbers: extractPhoneNumbers(bodyText),
    urgency: detectUrgency(bodyText),
    sentiment: detectSentiment(bodyText)
  };
  
  // Email metadata
  const metadata = {
    receivedTime: email.receivedDateTime,
    hasAttachments: email.hasAttachments || false,
    importance: email.importance || 'normal',
    ccRecipients: email.ccRecipients?.map(r => r.emailAddress?.address) || [],
    categories: email.categories || []
  };
  
  // Sender context
  const senderEmail = email.from?.emailAddress?.address?.toLowerCase() || '';
  const senderContext = {
    email: senderEmail,
    domain: senderEmail.split('@')[1] || '',
    name: email.from?.emailAddress?.name || ''
  };
  
  return {
    thread: threadInfo,
    detected: detectedInfo,
    metadata: metadata,
    sender: senderContext
  };
}

// Call webhook to generate AI response for flagged email
async function callResponseWebhook(emailData) {
  if (!process.env.RESPONSE_WEBHOOK_URL) {
    return;
  }
  
  try {
    const response = await axios.post(
      process.env.RESPONSE_WEBHOOK_URL,
      emailData,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': process.env.EMAIL_PROCESSING_SECRET || '',
        },
        timeout: 5000, // 5 second timeout
      }
    );
    
    if (response.data.success) {
      console.log(`Response generated for ${emailData.messageId}`);
    }
  } catch (error) {
    console.error('Webhook call failed:', error.message);
    throw error;
  }
}

// Check sender response history from feedback data
async function getSenderHistory(senderEmail, db) {
  if (!senderEmail) return null;
  
  try {
    const senderDomain = senderEmail.split('@')[1];
    
    // Get feedback stats for this sender
    const senderStats = await db.select({
      totalEmails: sql`COUNT(*)`,
      responseRate: sql`AVG(CASE WHEN ${emailFeedback.responded} THEN 1.0 ELSE 0.0 END)`,
      avgResponseTime: sql`AVG(${emailFeedback.daysToResponse})`
    })
    .from(emailFeedback)
    .leftJoin(processedEmails, eq(emailFeedback.messageId, processedEmails.messageId))
    .where(eq(processedEmails.senderEmail, senderEmail))
    .groupBy(processedEmails.senderEmail);
    
    // Also check domain-level stats
    const domainStats = await db.select({
      totalEmails: sql`COUNT(*)`,
      responseRate: sql`AVG(CASE WHEN ${emailFeedback.responded} THEN 1.0 ELSE 0.0 END)`
    })
    .from(emailFeedback)
    .leftJoin(processedEmails, eq(emailFeedback.messageId, processedEmails.messageId))
    .where(sql`${processedEmails.senderEmail} LIKE '%@' || ${senderDomain}`)
    .groupBy(sql`SPLIT_PART(${processedEmails.senderEmail}, '@', 2)`);
    
    const sender = senderStats[0];
    const domain = domainStats[0];
    
    if (sender && sender.totalEmails >= 2) {
      return {
        type: 'sender',
        email: senderEmail,
        totalEmails: Number(sender.totalEmails),
        responseRate: Number(sender.responseRate || 0),
        avgResponseTime: Number(sender.avgResponseTime || 0),
        priority: sender.responseRate > 0.7 ? 'high' : sender.responseRate < 0.2 ? 'low' : 'medium'
      };
    } else if (domain && domain.totalEmails >= 5) {
      return {
        type: 'domain',
        domain: senderDomain,
        totalEmails: Number(domain.totalEmails),
        responseRate: Number(domain.responseRate || 0),
        priority: domain.responseRate > 0.6 ? 'high' : domain.responseRate < 0.3 ? 'low' : 'medium'
      };
    }
    
    return null;
    
  } catch (error) {
    console.error('Error checking sender history:', error);
    return null;
  }
}

// Check learned patterns
async function checkLearnedPatterns(email, db) {
  const senderEmail = email.from?.emailAddress?.address?.toLowerCase();
  if (!senderEmail) return null;
  
  const senderDomain = senderEmail.split('@')[1];
  
  try {
    // Check if we've seen this sender before
    const pattern = await db.select()
      .from(emailPatterns)
      .where(sql`(${emailPatterns.patternType} = 'sender' AND ${emailPatterns.patternValue} = ${senderEmail}) OR (${emailPatterns.patternType} = 'domain' AND ${emailPatterns.patternValue} = ${senderDomain})`)
      .orderBy(desc(emailPatterns.occurrenceCount))
      .limit(1);
    
    if (pattern.length > 0 && pattern[0].occurrenceCount >= 3) {
      // We've seen this sender at least 3 times, use learned pattern
      const shouldFlag = CLASSIFICATIONS_TO_FLAG.includes(pattern[0].typicalClassification);
      return {
        classification: pattern[0].typicalClassification,
        shouldFlag: shouldFlag,
        confidence: Math.min(0.9, 0.6 + (pattern[0].occurrenceCount * 0.05)),
        reasoning: `Based on ${pattern[0].occurrenceCount} previous emails from this ${pattern[0].patternType}`
      };
    }
  } catch (error) {
    console.error('Error checking patterns:', error);
  }
  
  return null;
}

// AI classification with OpenAI
async function classifyEmail(email, senderHistory = null) {
  // Build sender history context
  let historyContext = '';
  if (senderHistory) {
    const rate = Math.round(senderHistory.responseRate * 100);
    const priority = senderHistory.priority.toUpperCase();

    if (senderHistory.type === 'sender') {
      historyContext = `\n  SENDER HISTORY: This email address has sent ${senderHistory.totalEmails} emails. ${rate}% got responses (${priority} PRIORITY).`;
      if (senderHistory.avgResponseTime > 0) {
        historyContext += ` Average response time: ${Math.round(senderHistory.avgResponseTime)} days.`;
      }
    } else {
      historyContext = `\n  DOMAIN HISTORY: This domain has sent ${senderHistory.totalEmails} emails. ${rate}% got responses (${priority} PRIORITY).`;
    }

    if (priority === 'LOW') {
      historyContext += `\n  ⚠️  LOW PRIORITY: Similar emails rarely need responses. Consider if this is truly important.`;
    } else if (priority === 'HIGH') {
      historyContext += `\n  🔥 HIGH PRIORITY: This sender's emails almost always need responses.`;
    }
  }

  const prompt = `
  Classify this email. Flag customer requests, skip vendor/freight/system emails.

  FLAG THESE:
  - Customer questions, quotes, orders, complaints, urgent requests
  - Product inquiries, pricing, support requests
  - Thanks, testimonials
  - Andre's POs with attachments → PURCHASE_ORDER_FORWARD

  SKIP THESE:
  - Freight companies pitching services (UPS, FedEx, XPO, Echo, etc.)
  - Vendors selling to us ("demo", "webinar", "capabilities", "partnership")
  - Marketing (unsubscribe links, no-reply senders)
  - Amazon, Shopify, payment processors
  - Out of office, spam, newsletters

  CUSTOMER REQUEST needs BOTH:
  - Intent: "quote", "price", "ship", "need", "order", "urgent", "ASAP"
  - Commerce: product name, quantity, concentration %, pack size

  If uncertain → skip (NO ACTION)
  ${historyContext}

  Email:
  From: ${email.from?.emailAddress?.address || 'unknown'}
  Subject: ${(email.subject || '').replace(/[^\x20-\x7E\n\r\t]/g, '')}
  Has Attachments: ${email.hasAttachments}
  Body: ${(email.bodyPreview || '').slice(0, 2000).replace(/[^\x20-\x7E\n\r\t]/g, '')}

  JSON only:
  {
    "classification": "CATEGORY_NAME",
    "confidence": 0.95,
    "reasoning": "Brief why"
  }`;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.MODEL || 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an email classifier. Return a single valid JSON object only. No explanation, no extra keys, no prose, no markdown. The JSON must be parseable by JSON.parse in JavaScript. Do not include any text outside the JSON object.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 1,
        max_completion_tokens: 1000,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const responseText = response.data.choices[0].message.content;

    // Log the actual response for debugging
    console.log('OpenAI response:', responseText);
    console.log('Response length:', responseText ? responseText.length : 0);

    // Check for empty response
    if (!responseText || responseText.trim() === '') {
      console.error('Empty response from OpenAI');
      throw new Error('Empty AI response');
    }

    // Try to parse JSON with better error handling
    try {
      const parsed = JSON.parse(responseText);
      return parsed;
    } catch (parseError) {
      console.error('Failed to parse AI JSON:', parseError.message);
      console.error('Response text was:', responseText);
      console.error('Response text (first 500 chars):', responseText.substring(0, 500));
      throw parseError;
    }
  } catch (error) {
    console.error('AI classification error:', error.message);

    // Log full error details
    if (error.response?.data) {
      try {
        console.error('OpenAI error response:', JSON.stringify(error.response.data, null, 2));
      } catch {
        console.error('OpenAI error response (raw):', error.response.data);
      }
    }

    // Log stack trace for debugging
    console.error('Error stack:', error.stack);
  }
  
  // Default to flagging for review
  return {
    classification: 'CUSTOMER_SUPPORT_REQUEST',
    confidence: 0.5,
    reasoning: 'AI classification failed, defaulting to manual review'
  };
}

// Main email processor
exports.handler = async (event) => {
  console.log('Email processor starting...');
  const startTime = Date.now();
  const db = getDb();
  
  try {
    const accessToken = await getAccessToken();
    
    // Get unread emails from both mailboxes
    const mailboxes = [
      process.env.SHARED_MAILBOX_ADDRESS || 'sales@alliancechemical.com',
      'andre@alliancechemical.com'
    ];
    
    let stats = {
      processed: 0,
      flagged: 0,
      skipped: 0,
      discarded: 0,
      errors: 0
    };
    
    for (const mailbox of mailboxes) {
      console.log(`Processing mailbox: ${mailbox}`);
      const graphUrl = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?$filter=isRead eq false&$top=50&$select=id,subject,from,bodyPreview,hasAttachments,receivedDateTime,internetMessageId,conversationId,importance,ccRecipients,categories`;
      
      try {
        const response = await axios.get(graphUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        const emails = response.data.value || [];
        console.log(`Found ${emails.length} unread emails in ${mailbox}`);
        
        for (const email of emails) {
          try {
            // Check if already processed
            const existing = await db.select()
              .from(processedEmails)
              .where(sql`${processedEmails.messageId} = ${email.id}`)
              .limit(1);

            if (existing.length > 0) {
              console.log(`Already processed: ${email.subject}`);
              continue;
            }

            // Check for special case: PO from Andre
            const fromAddress = (email.from?.emailAddress?.address || '').toLowerCase();
            const senderDomain = fromAddress.includes('@') ? fromAddress.split('@')[1] : '';
            const isFromAndre = fromAddress.includes('andre@alliancechemical.com');
            const hasAttachments = email.hasAttachments === true;
            const mentionsPO = (email.subject?.toLowerCase().includes('po') ||
                               email.subject?.toLowerCase().includes('purchase order'));

            let classification;
            let senderHistory = null; // Declare here so it's accessible throughout the email processing
            const autoFlagRule = getAutoFlagRule(email);
            if (autoFlagRule) {
              console.log(`Auto-flagging email from ${fromAddress}: ${autoFlagRule.reason}`);
              classification = {
                classification: autoFlagRule.classification,
                confidence: autoFlagRule.confidence ?? 1.0,
                reasoning: autoFlagRule.reason
              };
            }

            if (!classification) {
              // Auto-skip known safe senders before running classification
              const autoSkipRule = getAutoSkipRule(email);
              if (autoSkipRule) {
                console.log(`Auto-skipping email from ${fromAddress}: ${autoSkipRule.reason}`);
                await markAsRead(email.id, mailbox, accessToken);
                stats.discarded++;

                await db.insert(processedEmails).values({
                  messageId: email.id,
                  internetMessageId: email.internetMessageId,
                  subject: email.subject,
                  senderEmail: email.from?.emailAddress?.address,
                  classification: autoSkipRule.classification,
                  status: 'discarded',
                  flagged: false,
                  error: JSON.stringify({ reasoning: autoSkipRule.reason, rule: autoSkipRule.name }),
                  bodyText: email.bodyPreview?.slice(0, 200) || '',
                  bodyHtml: null,
                  bodyPreview: email.bodyPreview?.slice(0, 200) || '',
                  aiReasoning: autoSkipRule.reason,
                  aiConfidence: 1.0,
                  aiFactors: JSON.stringify({
                    autoSkip: true,
                    reason: autoSkipRule.reason,
                    rule: autoSkipRule.name,
                    senderDomain
                  })
                });

                continue;
              }
            }

            if (!classification && isFromAndre && hasAttachments && mentionsPO) {
              classification = {
                classification: 'PURCHASE_ORDER_FORWARD',
                confidence: 1.0,
                reasoning: 'Purchase order from Andre'
              };
            }

            if (!classification && fromAddress.includes('@alliancechemical.com')) {
              // Skip internal Alliance emails
              console.log(`Skipping internal email from ${fromAddress}`);
              await markAsRead(email.id, mailbox, accessToken);
              stats.skipped++;
              continue;
            }

            if (!classification && isAmazonEmail(email)) {
              // Skip ALL Amazon notifications - returns, A-to-z, messages, etc.
              console.log(`Skipping Amazon notification: ${email.subject}`);
              await markAsRead(email.id, mailbox, accessToken);
              stats.discarded++;

              // Store as system notification
              await db.insert(processedEmails).values({
                messageId: email.id,
                internetMessageId: email.internetMessageId,
                subject: email.subject,
                senderEmail: email.from?.emailAddress?.address,
                classification: 'AMAZON_NOTIFICATION',
                status: 'discarded',
                flagged: false,
                error: JSON.stringify({ reasoning: `Auto-skipped Amazon notification` }),
                bodyPreview: email.bodyPreview?.slice(0, 200),
                aiReasoning: `Auto-skipped Amazon notification - no action needed in email system`,
                aiConfidence: 1.0,
                aiFactors: JSON.stringify({ amazonEmail: true, skipReason: 'Amazon system notification' })
              });

              continue;
            }

            if (!classification && isSystemNotificationDomain(senderDomain)) {
              console.log(`Skipping system notification from ${senderDomain}`);
              await markAsRead(email.id, mailbox, accessToken);
              stats.discarded++;

              // Store as system notification
              await db.insert(processedEmails).values({
                messageId: email.id,
                internetMessageId: email.internetMessageId,
                subject: email.subject,
                senderEmail: email.from?.emailAddress?.address,
                classification: 'SYSTEM_NOTIFICATION',
                status: 'discarded',
                flagged: false,
                error: JSON.stringify({ reasoning: `Auto-skipped system domain: ${senderDomain}` }),
                bodyPreview: email.bodyPreview?.slice(0, 200),
                aiReasoning: `Auto-skipped system domain: ${senderDomain}`,
                aiConfidence: 1.0,
                aiFactors: JSON.stringify({ systemDomain: true, domain: senderDomain })
              });

              continue;
            }

            if (!classification) {
              // Skip pattern checking for now (table doesn't exist)
              // const learnedPattern = await checkLearnedPatterns(email, db);
              const learnedPattern = null;

              if (learnedPattern) {
                classification = learnedPattern;
                console.log(`Using learned pattern for ${fromAddress}`);
              } else {
                // Get sender history for better classification
                senderHistory = await getSenderHistory(fromAddress, db);

                // Get AI classification with history context
                classification = await classifyEmail(email, senderHistory);

                // Log sender history for debugging
                if (senderHistory) {
                  console.log(`Sender history for ${fromAddress}: ${Math.round(senderHistory.responseRate * 100)}% response rate (${senderHistory.priority} priority)`);
                }
              }
              
              // Skip pattern learning for now (table doesn't exist)
              /*
              try {
                await db.insert(emailPatterns)
                  .values({
                    patternType: 'sender',
                    patternValue: fromAddress,
                    typicalClassification: classification.classification,
                    confidenceBoost: classification.confidence,
                    occurrenceCount: 1
                  })
                  .onConflictDoNothing();
                  
                // Also update domain pattern
                await db.insert(emailPatterns)
                  .values({
                    patternType: 'domain',
                    patternValue: senderDomain,
                    typicalClassification: classification.classification,
                    confidenceBoost: classification.confidence,
                    occurrenceCount: 1
                  })
                  .onConflictDoNothing();
              } catch (err) {
                console.error('Failed to update pattern:', err);
              }
              */
            }
            
            // Extract email-specific context
            const emailContext = await extractEmailContext(email, mailbox, accessToken);
            console.log(`Extracted context for ${email.subject}: ${emailContext.detected.productNames.length} products, urgency: ${emailContext.detected.urgency.urgencyLevel}`);
            
            // Fetch full email content for flagged emails
            let emailContent = { bodyText: '', bodyHtml: null, bodyPreview: email.bodyPreview?.slice(0, 200) || '' };
            
            // Determine action based on classification
            const shouldFlag = CLASSIFICATIONS_TO_FLAG.includes(classification.classification);
            const shouldSkip = CLASSIFICATIONS_TO_SKIP.includes(classification.classification);
            
            if (shouldFlag) {
              // Fetch full content for flagged emails
              emailContent = await fetchEmailContent(email.id, mailbox, accessToken);
              
              // Apply flag with justification
              const justification = classification.reasoning || `Classified as ${classification.classification}`;
              await applyFlag(email.id, mailbox, accessToken, justification);
              stats.flagged++;
            } else if (shouldSkip) {
              // Mark as read (no flag)
              await markAsRead(email.id, mailbox, accessToken);
              stats.discarded++;
            } else {
              // Unknown classification - flag for review and fetch content
              emailContent = await fetchEmailContent(email.id, mailbox, accessToken);
              await applyFlag(email.id, mailbox, accessToken, 'Needs manual review - unclear classification');
              stats.flagged++;
            }
            
            // Store in database with full content and AI analysis
            const metadata = JSON.stringify({
              justification: classification.reasoning,
              confidence: classification.confidence
            });
            
            await db.insert(processedEmails).values({
              messageId: email.id,
              internetMessageId: email.internetMessageId,
              subject: email.subject,
              senderEmail: email.from?.emailAddress?.address,
              classification: classification.classification,
              status: shouldFlag ? 'flagged' : 'processed',
              flagged: shouldFlag,
              error: metadata,
              // Email content
              bodyText: emailContent.bodyText,
              bodyHtml: emailContent.bodyHtml,
              bodyPreview: emailContent.bodyPreview,
              // AI analysis
              aiReasoning: classification.reasoning,
              aiConfidence: classification.confidence,
              aiFactors: JSON.stringify({
                classification: classification.classification,
                senderHistory: senderHistory || null,
                hasAttachments: email.hasAttachments,
                fromDomain: senderDomain,
                // NEW: Email-specific context
                thread: emailContext.thread,
                detectedProducts: emailContext.detected.productNames,
                quantities: emailContext.detected.quantities,
                orderNumbers: emailContext.detected.orderNumbers,
                phoneNumbers: emailContext.detected.phoneNumbers,
                urgency: emailContext.detected.urgency,
                sentiment: emailContext.detected.sentiment,
                metadata: emailContext.metadata
              })
            });
            
            // Call webhook for flagged emails to generate AI response
            if (shouldFlag && process.env.RESPONSE_WEBHOOK_URL) {
              try {
                await callResponseWebhook({
                  messageId: email.id,
                  senderEmail: email.from?.emailAddress?.address,
                  subject: email.subject,
                  classification: classification.classification,
                  bodyText: emailContent.bodyText,
                  bodyPreview: emailContent.bodyPreview,
                  aiReasoning: classification.reasoning,
                  aiConfidence: classification.confidence,
                  // Include enriched email context
                  emailContext: {
                    thread: emailContext.thread,
                    detected: emailContext.detected,
                    metadata: emailContext.metadata,
                    sender: emailContext.sender
                  },
                  aiFactors: {
                    senderHistory: senderHistory || null,
                    hasAttachments: email.hasAttachments,
                  }
                });
                console.log(`Webhook called for flagged email ${email.id} with enriched context`);
              } catch (webhookError) {
                console.error(`Webhook failed for ${email.id}:`, webhookError.message);
                // Don't fail the whole process if webhook fails
              }
            }
            
            stats.processed++;
            
          } catch (error) {
            console.error(`Error processing email ${email.id}:`, error);
            stats.errors++;
          }
        }
      } catch (error) {
        console.error(`Error fetching from ${mailbox}:`, error.message);
      }
    }
    
    // Store processing stats
    const duration = Date.now() - startTime;
    await db.insert(processingStats).values({
      processed: stats.processed,
      flagged: stats.flagged,
      skipped: stats.skipped,
      discarded: stats.discarded,
      errors: stats.errors,
      duration_ms: duration
    });
    
    console.log('Processing complete:', stats);
    
    return createResponse(200, {
      success: true,
      message: 'Emails processed successfully',
      stats: {
        ...stats,
        duration_ms: duration
      }
    });
    
  } catch (error) {
    console.error('Processing error:', error);
    return createResponse(500, {
      success: false,
      error: error.message
    });
  }
};

// Health check
exports.healthHandler = async (event) => {
  return createResponse(200, {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'email-classifier-simple',
    version: '1.0.0'
  });
};

// Stats handler
exports.statsHandler = async (event) => {
  const db = getDb();
  
  try {
    const recentStats = await db.select()
      .from(processingStats)
      .orderBy(desc(processingStats.date))
      .limit(10);
    
    return createResponse(200, {
      success: true,
      stats: recentStats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Stats error:', error);
    return createResponse(500, {
      success: false,
      error: error.message
    });
  }
};
