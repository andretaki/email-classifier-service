-- Enable pgvector extension on Neon database for vector similarity search
-- This extension allows us to store and query OpenAI embeddings efficiently

-- Enable the vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify the extension is installed
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Check available vector operators
SELECT 
    amname as access_method,
    opcname as operator_class,
    opcintype::regtype as input_type
FROM pg_am 
JOIN pg_opclass ON pg_am.oid = pg_opclass.opcmethod
WHERE amname IN ('ivfflat', 'hnsw')
ORDER BY amname, opcname;

-- Show vector extension version
SELECT extversion FROM pg_extension WHERE extname = 'vector';