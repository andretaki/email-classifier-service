-- ============================================================================
-- PROMPT MANAGEMENT SYSTEM
-- For managing AI response templates without code changes
-- ============================================================================

-- Prompt Templates Table
-- Stores different response templates by category
CREATE TABLE IF NOT EXISTS prompt_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL, -- 'quote_request', 'order_status', 'product_inquiry', 'general'
  description TEXT,
  
  -- The actual prompt template with variables like {{product_name}}, {{price}}, etc.
  template_text TEXT NOT NULL,
  
  -- System instructions for the AI
  system_prompt TEXT,
  
  -- Variables this template expects
  required_variables JSONB DEFAULT '[]',
  optional_variables JSONB DEFAULT '[]',
  
  -- Versioning and testing
  version INTEGER DEFAULT 1,
  is_active BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false, -- Default template for this category
  
  -- Performance metrics
  usage_count INTEGER DEFAULT 0,
  success_rate DECIMAL(5,2),
  avg_feedback_score DECIMAL(3,2),
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by VARCHAR(255),
  
  UNIQUE(name, version)
);

-- Response Rules Table
-- Business rules and conditions for using specific templates
CREATE TABLE IF NOT EXISTS response_rules (
  id SERIAL PRIMARY KEY,
  rule_name VARCHAR(255) NOT NULL,
  description TEXT,
  
  -- Conditions (JSON object describing when this rule applies)
  conditions JSONB NOT NULL,
  -- Example: {"email_contains": ["quote", "pricing"], "has_attachment": true}
  
  -- Actions to take
  template_id INTEGER REFERENCES prompt_templates(id),
  additional_context TEXT,
  
  -- Priority (higher number = higher priority)
  priority INTEGER DEFAULT 0,
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Feedback Logs Table
-- Track accuracy feedback for continuous improvement
CREATE TABLE IF NOT EXISTS response_feedback (
  id SERIAL PRIMARY KEY,
  
  -- Context
  email_id VARCHAR(255),
  email_subject TEXT,
  email_body TEXT,
  email_category VARCHAR(100), -- From classifier
  
  -- Generated response
  template_id INTEGER REFERENCES prompt_templates(id),
  generated_response TEXT NOT NULL,
  final_response TEXT, -- After manual edits
  
  -- Feedback
  was_accurate BOOLEAN,
  feedback_text TEXT,
  feedback_category VARCHAR(100), -- 'wrong_price', 'missing_info', 'wrong_product', etc.
  
  -- Additional context provided by user
  manual_context TEXT,
  
  -- Metrics
  generation_time_ms INTEGER,
  confidence_score DECIMAL(3,2),
  
  created_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  reviewed_by VARCHAR(255)
);

-- Prompt Variables Table
-- Store commonly used variables and their current values
CREATE TABLE IF NOT EXISTS prompt_variables (
  id SERIAL PRIMARY KEY,
  variable_name VARCHAR(100) UNIQUE NOT NULL,
  variable_type VARCHAR(50) NOT NULL, -- 'static', 'dynamic', 'function'
  
  -- For static variables
  static_value TEXT,
  
  -- For dynamic variables (query to fetch value)
  fetch_query TEXT,
  
  -- For function variables (function name to call)
  function_name VARCHAR(255),
  
  description TEXT,
  category VARCHAR(100),
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- A/B Testing Table
-- Track different prompt versions for testing
CREATE TABLE IF NOT EXISTS prompt_ab_tests (
  id SERIAL PRIMARY KEY,
  test_name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL,
  
  -- Templates being tested
  template_a_id INTEGER REFERENCES prompt_templates(id),
  template_b_id INTEGER REFERENCES prompt_templates(id),
  
  -- Test configuration
  traffic_split DECIMAL(3,2) DEFAULT 0.50, -- Percentage going to template A
  
  -- Test status
  status VARCHAR(50) DEFAULT 'active', -- 'active', 'completed', 'paused'
  
  -- Results
  template_a_uses INTEGER DEFAULT 0,
  template_a_successes INTEGER DEFAULT 0,
  template_b_uses INTEGER DEFAULT 0,
  template_b_successes INTEGER DEFAULT 0,
  
  -- Winner (once determined)
  winner_template_id INTEGER REFERENCES prompt_templates(id),
  
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  created_by VARCHAR(255)
);

-- Response Cache Table
-- Cache frequently used responses
CREATE TABLE IF NOT EXISTS response_cache (
  id SERIAL PRIMARY KEY,
  cache_key VARCHAR(255) UNIQUE NOT NULL, -- Hash of query + context
  query TEXT NOT NULL,
  context JSONB,
  
  response TEXT NOT NULL,
  template_id INTEGER REFERENCES prompt_templates(id),
  
  hit_count INTEGER DEFAULT 0,
  
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  last_accessed TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX idx_templates_category ON prompt_templates(category) WHERE is_active = true;
CREATE INDEX idx_templates_default ON prompt_templates(category, is_default) WHERE is_active = true;
CREATE INDEX idx_rules_priority ON response_rules(priority DESC) WHERE is_active = true;
CREATE INDEX idx_feedback_created ON response_feedback(created_at DESC);
CREATE INDEX idx_feedback_template ON response_feedback(template_id);
CREATE INDEX idx_cache_key ON response_cache(cache_key);
CREATE INDEX idx_cache_expires ON response_cache(expires_at) WHERE expires_at IS NOT NULL;

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to get the best template for a category
CREATE OR REPLACE FUNCTION get_best_template(p_category VARCHAR)
RETURNS INTEGER AS $$
DECLARE
  v_template_id INTEGER;
BEGIN
  -- First try to get the default template
  SELECT id INTO v_template_id
  FROM prompt_templates
  WHERE category = p_category
    AND is_active = true
    AND is_default = true
  ORDER BY version DESC
  LIMIT 1;
  
  -- If no default, get the one with best success rate
  IF v_template_id IS NULL THEN
    SELECT id INTO v_template_id
    FROM prompt_templates
    WHERE category = p_category
      AND is_active = true
      AND usage_count > 10 -- Minimum usage for statistics
    ORDER BY success_rate DESC NULLS LAST, version DESC
    LIMIT 1;
  END IF;
  
  -- If still nothing, just get the latest active one
  IF v_template_id IS NULL THEN
    SELECT id INTO v_template_id
    FROM prompt_templates
    WHERE category = p_category
      AND is_active = true
    ORDER BY version DESC
    LIMIT 1;
  END IF;
  
  RETURN v_template_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED DATA - Example Templates
-- ============================================================================

-- Quote Request Template
INSERT INTO prompt_templates (name, category, description, template_text, system_prompt, required_variables)
VALUES (
  'Standard Quote Request',
  'quote_request',
  'Default template for handling quote requests',
  'Thank you for your interest in {{product_names}}!

Based on your requirements, here''s your quote:

{{quote_items}}

Subtotal: ${{subtotal}}
Estimated Shipping: ${{shipping_estimate}}
{{#if hazmat_fee}}Hazmat Fee: ${{hazmat_fee}}{{/if}}

Total: ${{total}}

• All prices are in USD
• Quote valid for 30 days
• Shipping from Austin, Texas
• {{payment_terms}}

{{#if special_notes}}
Important: {{special_notes}}
{{/if}}

Would you like to proceed with this order? I can help you with:
- Adjusting quantities
- Exploring volume discounts
- Checking alternative products
- Setting up a purchase order

Best regards,
{{agent_name}}
Alliance Chemical',
  'You are a helpful sales assistant for Alliance Chemical. Be professional, accurate with pricing, and always mention safety considerations for hazardous materials.',
  '["product_names", "quote_items", "subtotal", "total"]'
);

-- Order Status Template
INSERT INTO prompt_templates (name, category, description, template_text, system_prompt, required_variables)
VALUES (
  'Order Status Response',
  'order_status',
  'Template for order status inquiries',
  'Thank you for checking on order #{{order_number}}.

Order Status: {{order_status}}
{{#if shipped}}
Shipped Date: {{ship_date}}
Carrier: {{carrier}}
Tracking Number: {{tracking_number}}
Track your package: {{tracking_url}}

Estimated Delivery: {{estimated_delivery}}
{{else}}
Expected Ship Date: {{expected_ship_date}}
{{/if}}

Items in this order:
{{order_items}}

Shipping to:
{{shipping_address}}

If you have any questions about your order, please let me know!

Best regards,
{{agent_name}}
Alliance Chemical',
  'You are a customer service representative for Alliance Chemical. Provide accurate order information and be helpful with any shipping concerns.',
  '["order_number", "order_status", "order_items"]'
);

-- Add more default templates...

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update timestamp trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_prompt_templates_updated_at 
  BEFORE UPDATE ON prompt_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_response_rules_updated_at 
  BEFORE UPDATE ON response_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_prompt_variables_updated_at 
  BEFORE UPDATE ON prompt_variables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();