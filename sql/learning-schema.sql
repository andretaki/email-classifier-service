-- Learning and feedback tables for email classifier

-- Store AI classification history with corrections
CREATE TABLE IF NOT EXISTS email_classifier_learning (
    id SERIAL PRIMARY KEY,
    email_id VARCHAR(255) UNIQUE NOT NULL,
    subject TEXT,
    sender VARCHAR(255),
    
    -- Original AI classification
    ai_classification VARCHAR(50),
    ai_confidence DECIMAL(3,2),
    ai_flag_color VARCHAR(20),
    ai_reasoning TEXT,
    
    -- Human correction (if any)
    human_classification VARCHAR(50),
    human_flag_color VARCHAR(20),
    corrected_at TIMESTAMP,
    corrected_by VARCHAR(255),
    correction_notes TEXT,
    
    -- Learning metadata
    was_correct BOOLEAN,
    processing_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Email features for retraining
    email_length INTEGER,
    has_attachments BOOLEAN,
    sentiment_score DECIMAL(3,2),
    urgency_keywords TEXT[],
    
    INDEX idx_classification (ai_classification),
    INDEX idx_corrections (was_correct),
    INDEX idx_date (processing_date)
);

-- Track classification patterns and accuracy
CREATE TABLE IF NOT EXISTS email_classifier_patterns (
    id SERIAL PRIMARY KEY,
    pattern_type VARCHAR(50), -- 'sender', 'subject_keyword', 'domain'
    pattern_value TEXT,
    typical_classification VARCHAR(50),
    confidence_boost DECIMAL(3,2),
    occurrence_count INTEGER DEFAULT 1,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE KEY unique_pattern (pattern_type, pattern_value)
);

-- Store custom rules created from learning
CREATE TABLE IF NOT EXISTS email_classifier_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(255),
    rule_type VARCHAR(50), -- 'sender', 'subject', 'content', 'combined'
    conditions JSONB, -- Flexible condition storage
    classification VARCHAR(50),
    flag_color VARCHAR(20),
    priority INTEGER DEFAULT 100,
    active BOOLEAN DEFAULT true,
    created_by VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    success_rate DECIMAL(3,2),
    times_applied INTEGER DEFAULT 0
);

-- Performance metrics by classification
CREATE TABLE IF NOT EXISTS email_classifier_metrics (
    id SERIAL PRIMARY KEY,
    classification VARCHAR(50),
    date DATE,
    total_classified INTEGER DEFAULT 0,
    correct_classifications INTEGER DEFAULT 0,
    false_positives INTEGER DEFAULT 0,
    false_negatives INTEGER DEFAULT 0,
    accuracy_rate DECIMAL(3,2),
    avg_confidence DECIMAL(3,2),
    
    UNIQUE KEY unique_daily_metric (classification, date)
);