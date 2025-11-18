-- Alliance Chemical Product Intelligence Database Schema
-- This schema supports hybrid search (BM25 + vector) with deterministic pricing

-- ============================================================================
-- PRODUCTS TABLE - Main product catalog with vector embeddings
-- ============================================================================
CREATE TABLE alliance_products (
  id BIGSERIAL PRIMARY KEY,
  shopify_id BIGINT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  product_type TEXT,
  vendor TEXT DEFAULT 'Alliance Chemical',
  description TEXT,
  body_html TEXT,
  tags TEXT,
  
  -- Chemical-specific fields
  cas_number TEXT,
  synonyms TEXT[], -- Manual + auto-mined synonyms for better search
  chemical_formula TEXT,
  molecular_weight DECIMAL(10,4),
  hs_code TEXT, -- Harmonized System code for shipping
  un_number TEXT, -- UN number for hazmat classification
  hazard_class TEXT, -- DOT hazard classification
  sds_url TEXT, -- Safety Data Sheet URL
  
  -- Specifications stored as JSON
  specs JSONB, -- {purity: "99%", grade: "ACS", density: "1.05", etc.}
  applications TEXT[], -- Common use cases for search
  
  -- Search and metadata
  embedding vector(1536), -- OpenAI text-embedding-3-small
  metadata JSONB, -- Flexible storage for additional data
  
  -- Status and timestamps
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'draft')),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- PRODUCT VARIANTS - Container sizes and SKUs with pricing
-- ============================================================================
CREATE TABLE alliance_product_variants (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT REFERENCES alliance_products(id) ON DELETE CASCADE,
  shopify_variant_id BIGINT UNIQUE NOT NULL,
  
  -- Variant details
  title TEXT NOT NULL, -- e.g., "1 Gallon / 1 Gallon Clear HDPE Jug"
  sku TEXT UNIQUE,
  container_size TEXT, -- Normalized: "1 Quart", "5 Gallon", "55 Gallon", etc.
  container_type TEXT, -- "Jug", "Pail", "Drum", "Tote", etc.
  
  -- Pricing (base Shopify price - margins applied in code)
  price DECIMAL(12,2) NOT NULL,
  compare_at_price DECIMAL(12,2),
  cost DECIMAL(12,2), -- Our cost for margin calculations
  
  -- Inventory and shipping
  inventory_quantity INTEGER DEFAULT 0,
  inventory_policy TEXT DEFAULT 'deny', -- 'allow' or 'deny' out-of-stock orders
  weight DECIMAL(10,3),
  weight_unit TEXT DEFAULT 'lb',
  requires_shipping BOOLEAN DEFAULT true,
  
  -- Shopify variant options
  option1 TEXT, -- Usually container size
  option2 TEXT, -- Usually specific product variant
  option3 TEXT, -- Additional options if any
  
  -- Metadata and status
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- PRICING TIERS - Volume-based pricing for specific variants
-- ============================================================================
CREATE TABLE alliance_variant_pricing_tiers (
  id BIGSERIAL PRIMARY KEY,
  variant_id BIGINT REFERENCES alliance_product_variants(id) ON DELETE CASCADE,
  min_qty INTEGER NOT NULL,
  max_qty INTEGER, -- NULL means no upper limit
  unit_price DECIMAL(12,2) NOT NULL,
  notes TEXT, -- e.g., "Pallet quantity", "LTL freight required"
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- SEARCH AND ANALYTICS TABLES
-- ============================================================================

-- Query logging for learning and optimization
CREATE TABLE product_search_log (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT, -- Track user sessions
  query TEXT NOT NULL,
  query_embedding vector(1536), -- For similarity analysis
  filters JSONB, -- Applied filters: {hazmat: false, size: "5 Gallon", etc.}
  
  -- Search results
  candidates JSONB, -- Top-K product IDs with scores
  selected_product_id BIGINT REFERENCES alliance_products(id),
  result_rank INTEGER, -- Which result was selected (1-based)
  
  -- Context and outcome
  email_context TEXT, -- Original customer email if applicable
  quote_generated BOOLEAN DEFAULT false,
  quote_id BIGINT, -- Reference to generated quote
  
  -- Performance metrics
  search_time_ms INTEGER,
  total_results INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Synonyms and search improvements
CREATE TABLE product_synonyms (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT REFERENCES alliance_products(id) ON DELETE CASCADE,
  synonym TEXT NOT NULL,
  synonym_type TEXT, -- 'manual', 'learned', 'cas', 'trade_name'
  confidence DECIMAL(3,2), -- How confident we are in this synonym
  usage_count INTEGER DEFAULT 0, -- How often it's been used
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- QUOTES AND SALES TRACKING
-- ============================================================================

-- Customer quotes
CREATE TABLE quotes (
  id BIGSERIAL PRIMARY KEY,
  quote_number TEXT UNIQUE, -- Human-readable quote number
  
  -- Customer information
  customer_name TEXT,
  customer_email TEXT,
  customer_company TEXT,
  customer_phone TEXT,
  
  -- Shipping and terms
  shipping_address JSONB,
  billing_address JSONB,
  incoterms TEXT DEFAULT 'FOB', -- FOB, CIF, etc.
  payment_terms TEXT DEFAULT 'Net 30',
  
  -- Quote totals
  subtotal DECIMAL(12,2),
  shipping_cost DECIMAL(12,2),
  hazmat_fee DECIMAL(12,2),
  tax DECIMAL(12,2),
  total DECIMAL(12,2),
  
  -- Metadata and status
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  expires_at TIMESTAMPTZ,
  notes TEXT,
  internal_notes TEXT, -- Not visible to customer
  
  -- References
  email_id TEXT, -- Link to original email request
  generated_by TEXT, -- 'ai', 'manual', 'hybrid'
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Quote line items
CREATE TABLE quote_line_items (
  id BIGSERIAL PRIMARY KEY,
  quote_id BIGINT REFERENCES quotes(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL, -- Order within quote
  
  -- Product references
  product_id BIGINT REFERENCES alliance_products(id),
  variant_id BIGINT REFERENCES alliance_product_variants(id),
  sku TEXT,
  
  -- Line item details
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  line_total DECIMAL(12,2) NOT NULL,
  
  -- Additional details
  lead_time_days INTEGER,
  special_instructions TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Full-text search indexes
CREATE INDEX idx_products_fts ON alliance_products 
  USING GIN (to_tsvector('english', 
    COALESCE(title,'') || ' ' || 
    COALESCE(description,'') || ' ' || 
    COALESCE(tags,'') || ' ' || 
    COALESCE(array_to_string(synonyms, ' '),'') || ' ' ||
    COALESCE(cas_number,'') || ' ' ||
    COALESCE(array_to_string(applications, ' '),'')
  ));

-- Vector similarity index (HNSW for better performance)
CREATE INDEX idx_products_embedding ON alliance_products 
  USING hnsw (embedding vector_cosine_ops) 
  WITH (m = 16, ef_construction = 64);

-- Product lookup indexes
CREATE INDEX idx_products_shopify_id ON alliance_products(shopify_id);
CREATE INDEX idx_products_type_status ON alliance_products(product_type, status);
CREATE INDEX idx_products_cas ON alliance_products(cas_number) WHERE cas_number IS NOT NULL;

-- Variant indexes
CREATE INDEX idx_variants_product_id ON alliance_product_variants(product_id);
CREATE INDEX idx_variants_sku ON alliance_product_variants(sku);
CREATE INDEX idx_variants_container_size ON alliance_product_variants(container_size);
CREATE INDEX idx_variants_inventory ON alliance_product_variants(inventory_quantity) WHERE inventory_quantity > 0;

-- Search log indexes for analytics
CREATE INDEX idx_search_log_query ON product_search_log USING GIN (to_tsvector('english', query));
CREATE INDEX idx_search_log_created ON product_search_log(created_at DESC);
CREATE INDEX idx_search_log_selected ON product_search_log(selected_product_id) WHERE selected_product_id IS NOT NULL;

-- Quote indexes
CREATE INDEX idx_quotes_customer_email ON quotes(customer_email);
CREATE INDEX idx_quotes_status_created ON quotes(status, created_at DESC);
CREATE INDEX idx_quote_items_quote_id ON quote_line_items(quote_id);

-- ============================================================================
-- TRIGGERS FOR AUTOMATIC UPDATES
-- ============================================================================

-- Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_alliance_products_updated_at 
    BEFORE UPDATE ON alliance_products 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_alliance_product_variants_updated_at 
    BEFORE UPDATE ON alliance_product_variants 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_quotes_updated_at 
    BEFORE UPDATE ON quotes 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- VIEWS FOR COMMON QUERIES
-- ============================================================================

-- Product search view with variant summary
CREATE VIEW product_search_view AS
SELECT 
    p.id,
    p.shopify_id,
    p.title,
    p.product_type,
    p.description,
    p.cas_number,
    p.synonyms,
    p.applications,
    p.hazard_class,
    p.embedding,
    -- Variant summary
    COUNT(v.id) as variant_count,
    MIN(v.price) as min_price,
    MAX(v.price) as max_price,
    array_agg(DISTINCT v.container_size ORDER BY v.container_size) as available_sizes,
    SUM(v.inventory_quantity) as total_inventory
FROM alliance_products p
LEFT JOIN alliance_product_variants v ON p.id = v.product_id
WHERE p.status = 'active'
GROUP BY p.id, p.shopify_id, p.title, p.product_type, p.description, 
         p.cas_number, p.synonyms, p.applications, p.hazard_class, p.embedding;

-- Search analytics view
CREATE VIEW search_analytics_view AS
SELECT 
    DATE_TRUNC('day', created_at) as date,
    COUNT(*) as total_searches,
    COUNT(DISTINCT query) as unique_queries,
    COUNT(selected_product_id) as successful_searches,
    AVG(search_time_ms) as avg_search_time_ms,
    AVG(result_rank) FILTER (WHERE selected_product_id IS NOT NULL) as avg_result_rank
FROM product_search_log
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY date DESC;

-- Comments for documentation
COMMENT ON TABLE alliance_products IS 'Main product catalog with vector embeddings for semantic search';
COMMENT ON TABLE alliance_product_variants IS 'Product variants with container sizes and pricing';
COMMENT ON TABLE alliance_variant_pricing_tiers IS 'Volume-based pricing tiers for bulk discounts';
COMMENT ON TABLE product_search_log IS 'Search query logging for analytics and learning';
COMMENT ON TABLE quotes IS 'Customer quotes generated by the system';
COMMENT ON COLUMN alliance_products.embedding IS 'OpenAI text-embedding-3-small vector (1536 dimensions)';
COMMENT ON COLUMN alliance_products.synonyms IS 'Alternative names and search terms for this product';
COMMENT ON COLUMN alliance_products.cas_number IS 'Chemical Abstracts Service registry number';
COMMENT ON COLUMN alliance_products.un_number IS 'UN number for hazardous materials shipping';
COMMENT ON INDEX idx_products_embedding IS 'HNSW index for fast vector similarity search';