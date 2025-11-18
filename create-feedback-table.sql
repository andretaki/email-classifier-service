-- Email feedback tracking table for response analysis
CREATE TABLE IF NOT EXISTS email_feedback (
  message_id TEXT PRIMARY KEY REFERENCES email_classifier_processed_emails(message_id),
  flagged_at TIMESTAMP NOT NULL,
  responded BOOLEAN DEFAULT FALSE,
  days_to_response INTEGER,
  response_category TEXT,  -- pricing, shipping, product, support, etc
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_email_feedback_flagged_at ON email_feedback(flagged_at);
CREATE INDEX IF NOT EXISTS idx_email_feedback_responded ON email_feedback(responded);

-- View for easy analysis
CREATE OR REPLACE VIEW feedback_summary AS
SELECT 
  DATE_TRUNC('day', flagged_at) as date,
  COUNT(*) as total_flagged,
  SUM(CASE WHEN responded THEN 1 ELSE 0 END) as total_responded,
  ROUND(AVG(CASE WHEN responded THEN 1.0 ELSE 0.0 END) * 100, 2) as response_rate_percent,
  AVG(days_to_response) as avg_days_to_response
FROM email_feedback
GROUP BY DATE_TRUNC('day', flagged_at)
ORDER BY date DESC;