-- Add email content and AI analysis columns to the email_classifier_processed_emails table
-- Run this migration to enable full email content storage and AI transparency

-- Add columns for storing email content
ALTER TABLE email_classifier_processed_emails 
ADD COLUMN IF NOT EXISTS body_text TEXT,
ADD COLUMN IF NOT EXISTS body_html TEXT,
ADD COLUMN IF NOT EXISTS body_preview TEXT;

-- Add columns for AI analysis transparency  
ALTER TABLE email_classifier_processed_emails
ADD COLUMN IF NOT EXISTS ai_reasoning TEXT,
ADD COLUMN IF NOT EXISTS ai_confidence DECIMAL(3,2),
ADD COLUMN IF NOT EXISTS ai_factors JSONB;

-- Add index for better performance on flagged emails
CREATE INDEX IF NOT EXISTS idx_flagged_emails_date 
ON email_classifier_processed_emails (flagged, processed_at DESC) 
WHERE flagged = true;

-- Add comments for documentation
COMMENT ON COLUMN email_classifier_processed_emails.body_text IS 'Plain text version of email body for AI processing and display';
COMMENT ON COLUMN email_classifier_processed_emails.body_html IS 'HTML version of email body for rich display';
COMMENT ON COLUMN email_classifier_processed_emails.body_preview IS 'First 200 chars of email for quick preview';
COMMENT ON COLUMN email_classifier_processed_emails.ai_reasoning IS 'AI explanation of why email was flagged/classified';
COMMENT ON COLUMN email_classifier_processed_emails.ai_confidence IS 'AI confidence score (0.00 to 1.00)';
COMMENT ON COLUMN email_classifier_processed_emails.ai_factors IS 'JSON object with key factors that influenced classification';

-- Show the updated table structure
\d email_classifier_processed_emails;