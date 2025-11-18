-- ============================================================================
-- EMAIL RESPONSE INTEGRATION TABLES
-- For connecting Lambda classifier to AI response system
-- ============================================================================

-- Email Response Drafts Table
-- Stores AI-generated draft responses for flagged emails
CREATE TABLE IF NOT EXISTS email_response_drafts (
  id SERIAL PRIMARY KEY,
  message_id TEXT UNIQUE NOT NULL,
  sender_email TEXT NOT NULL,
  subject TEXT,
  classification TEXT,
  
  -- The generated response
  draft_response TEXT NOT NULL,
  final_response TEXT, -- After human edits
  
  -- Metadata about generation
  tools_used JSONB DEFAULT '[]',
  confidence_score DECIMAL(3,2),
  generation_time_ms INTEGER,
  
  -- Tracking edits
  was_edited BOOLEAN DEFAULT false,
  edit_distance INTEGER, -- Levenshtein distance between draft and final
  edit_summary TEXT, -- What was changed
  
  -- Status tracking
  status TEXT DEFAULT 'pending', -- pending, reviewed, sent, discarded
  
  generated_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  sent_at TIMESTAMP,
  reviewed_by TEXT
);

-- Webhook Events Table
-- Logs all webhook calls for debugging and analytics
CREATE TABLE IF NOT EXISTS webhook_events (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL, -- email_flagged, response_sent, etc
  message_id TEXT,
  
  -- Request details
  source_ip TEXT,
  user_agent TEXT,
  
  -- Payload and response
  payload JSONB,
  response JSONB,
  status_code INTEGER,
  
  -- Timing
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  duration_ms INTEGER
);

-- Response Templates Usage Table
-- Track which templates are actually used
CREATE TABLE IF NOT EXISTS template_usage (
  id SERIAL PRIMARY KEY,
  template_id INTEGER REFERENCES prompt_templates(id),
  message_id TEXT,
  
  -- Usage context
  classification TEXT,
  tools_used TEXT[],
  
  -- Outcome tracking
  was_sent BOOLEAN DEFAULT false,
  was_edited BOOLEAN DEFAULT false,
  customer_satisfaction INTEGER, -- 1-5 rating if available
  
  used_at TIMESTAMP DEFAULT NOW()
);

-- System Metrics Table
-- Track overall system performance
CREATE TABLE IF NOT EXISTS system_metrics (
  id SERIAL PRIMARY KEY,
  metric_name TEXT NOT NULL,
  metric_value DECIMAL,
  metric_unit TEXT,
  
  -- Context
  component TEXT, -- lambda, agent, cache, etc
  environment TEXT DEFAULT 'production',
  
  recorded_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX idx_drafts_message_id ON email_response_drafts(message_id);
CREATE INDEX idx_drafts_status ON email_response_drafts(status);
CREATE INDEX idx_drafts_generated ON email_response_drafts(generated_at DESC);

CREATE INDEX idx_webhook_events_type ON webhook_events(event_type);
CREATE INDEX idx_webhook_events_created ON webhook_events(created_at DESC);
CREATE INDEX idx_webhook_events_message ON webhook_events(message_id);

CREATE INDEX idx_template_usage_template ON template_usage(template_id);
CREATE INDEX idx_template_usage_sent ON template_usage(was_sent);

CREATE INDEX idx_metrics_name ON system_metrics(metric_name, recorded_at DESC);
CREATE INDEX idx_metrics_component ON system_metrics(component);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Calculate edit distance between draft and final response
CREATE OR REPLACE FUNCTION calculate_edit_distance(draft TEXT, final TEXT)
RETURNS INTEGER AS $$
BEGIN
  -- PostgreSQL's levenshtein function requires fuzzystrmatch extension
  -- For now, return character count difference as approximation
  RETURN ABS(LENGTH(draft) - LENGTH(final));
END;
$$ LANGUAGE plpgsql;

-- Get response metrics for a time period
CREATE OR REPLACE FUNCTION get_response_metrics(
  p_start_date TIMESTAMP,
  p_end_date TIMESTAMP
) RETURNS TABLE (
  total_responses INTEGER,
  responses_sent INTEGER,
  responses_edited INTEGER,
  avg_confidence DECIMAL,
  most_used_tools TEXT[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::INTEGER as total_responses,
    COUNT(CASE WHEN status = 'sent' THEN 1 END)::INTEGER as responses_sent,
    COUNT(CASE WHEN was_edited THEN 1 END)::INTEGER as responses_edited,
    AVG(confidence_score) as avg_confidence,
    ARRAY(
      SELECT DISTINCT jsonb_array_elements_text(tools_used) 
      FROM email_response_drafts 
      WHERE generated_at BETWEEN p_start_date AND p_end_date
      LIMIT 5
    ) as most_used_tools
  FROM email_response_drafts
  WHERE generated_at BETWEEN p_start_date AND p_end_date;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SEED DATA - Sample metrics
-- ============================================================================

INSERT INTO system_metrics (metric_name, metric_value, metric_unit, component)
VALUES 
  ('cache_hit_rate', 0.0, 'percentage', 'cache'),
  ('avg_response_time', 0.0, 'milliseconds', 'agent'),
  ('emails_processed', 0.0, 'count', 'lambda'),
  ('tools_called', 0.0, 'count', 'agent')
ON CONFLICT DO NOTHING;