// Database types for Alliance Chemical RAG System

export interface AllianceProduct {
  id: number;
  shopify_id: number;
  title: string;
  product_type?: string;
  vendor: string;
  description?: string;
  body_html?: string;
  tags?: string;
  
  // Chemical-specific fields
  cas_number?: string;
  synonyms?: string[];
  chemical_formula?: string;
  molecular_weight?: number;
  hs_code?: string;
  un_number?: string;
  hazard_class?: string;
  sds_url?: string;
  
  // Specifications and metadata
  specs?: Record<string, any>;
  applications?: string[];
  embedding?: number[];
  metadata?: Record<string, any>;
  
  // Aggregated fields from variants (used in search results)
  container_sizes?: string[];
  in_stock?: boolean;
  min_price?: number;
  
  // Search result scoring fields
  relevance_score?: number;
  text_score?: number;
  vector_score?: number;
  
  // Status and timestamps
  status: 'active' | 'archived' | 'draft';
  published_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface AllianceProductVariant {
  id: number;
  product_id: number;
  shopify_variant_id: number;
  
  // Variant details
  title: string;
  sku?: string;
  container_size?: string;
  container_type?: string;
  
  // Pricing
  price: number;
  compare_at_price?: number;
  cost?: number;
  
  // Inventory and shipping
  inventory_quantity: number;
  inventory_policy: 'allow' | 'deny';
  weight?: number;
  weight_unit: string;
  requires_shipping: boolean;
  
  // Shopify variant options
  option1?: string;
  option2?: string;
  option3?: string;
  
  metadata?: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface AllianceVariantPricingTier {
  id: number;
  variant_id: number;
  min_qty: number;
  max_qty?: number;
  unit_price: number;
  notes?: string;
  created_at: Date;
}

export interface ProductSearchLog {
  id: number;
  session_id?: string;
  query: string;
  query_embedding?: number[];
  filters?: Record<string, any>;
  
  // Search results
  candidates?: Record<string, any>;
  selected_product_id?: number;
  result_rank?: number;
  
  // Context and outcome
  email_context?: string;
  quote_generated: boolean;
  quote_id?: number;
  
  // Performance metrics
  search_time_ms?: number;
  total_results?: number;
  
  created_at: Date;
}

export interface Quote {
  id: number;
  quote_number: string;
  
  // Customer information
  customer_name?: string;
  customer_email?: string;
  customer_company?: string;
  customer_phone?: string;
  
  // Shipping and terms
  shipping_address?: Record<string, any>;
  billing_address?: Record<string, any>;
  incoterms: string;
  payment_terms: string;
  
  // Quote totals
  subtotal?: number;
  shipping_cost?: number;
  hazmat_fee?: number;
  tax?: number;
  total?: number;
  
  // Status and metadata
  status: 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';
  expires_at?: Date;
  notes?: string;
  internal_notes?: string;
  
  // References
  email_id?: string;
  generated_by?: 'ai' | 'manual' | 'hybrid';
  
  created_at: Date;
  updated_at: Date;
}

export interface QuoteLineItem {
  id: number;
  quote_id: number;
  line_number: number;
  
  // Product references
  product_id?: number;
  variant_id?: number;
  sku?: string;
  
  // Line item details
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  
  // Additional details
  lead_time_days?: number;
  special_instructions?: string;
  
  created_at: Date;
}

// Search and API types
export interface SearchParams {
  query: string;
  filters?: {
    product_type?: string;
    hazmat?: boolean;
    container_size?: string;
    max_price?: number;
    in_stock?: boolean;
  };
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  products: AllianceProduct[];
  total: number;
  search_time_ms: number;
  query_id: number;
}

export interface PricingRequest {
  product_id: number;
  variant_id?: number;
  quantity: number;
  customer_tier?: 'retail' | 'wholesale' | 'distributor';
}

export interface PricingResult {
  product: AllianceProduct;
  variant: AllianceProductVariant;
  pricing_tiers: AllianceVariantPricingTier[];
  recommended_price: number;
  volume_discount?: number;
  hazmat_fee?: number;
  shipping_estimate?: number;
}

// Shopify sync types
export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  tags: string;
  status: string;
  variants: ShopifyVariant[];
  created_at: string;
  updated_at: string;
}

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  price: string;
  sku: string;
  inventory_quantity: number;
  weight: number;
  option1: string;
  option2?: string;
  option3?: string;
  created_at: string;
  updated_at: string;
}