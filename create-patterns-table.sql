-- Create the missing email_classifier_patterns table
CREATE TABLE IF NOT EXISTS email_classifier_patterns (
  id SERIAL PRIMARY KEY,
  pattern_type TEXT,
  pattern_value TEXT,
  typical_classification TEXT,
  confidence_boost DECIMAL(3,2),
  occurrence_count INTEGER DEFAULT 1,
  last_seen TIMESTAMP DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_patterns_type_value ON email_classifier_patterns(pattern_type, pattern_value);
CREATE INDEX IF NOT EXISTS idx_patterns_last_seen ON email_classifier_patterns(last_seen);

-- Grant permissions if needed
-- GRANT ALL ON email_classifier_patterns TO your_user;