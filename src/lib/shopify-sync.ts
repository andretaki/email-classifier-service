import { Client } from 'pg';
import OpenAI from 'openai';
import type { ShopifyProduct, ShopifyVariant, AllianceProduct, AllianceProductVariant } from '@/types';

// GraphQL Response Types
interface ShopifyGraphQLResponse {
  data?: {
    products: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          bodyHtml: string;
          vendor: string;
          productType: string;
          tags: string[];
          status: string;
          createdAt: string;
          updatedAt: string;
          variants: {
            edges: Array<{
              node: {
                id: string;
                title: string;
                price: string;
                sku: string;
                inventoryQuantity: number;
                weight: number;
                weightUnit: string;
                selectedOptions: Array<{
                  name: string;
                  value: string;
                }>;
                createdAt: string;
                updatedAt: string;
              };
            }>;
          };
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  errors?: Array<{
    message: string;
    extensions?: Record<string, any>;
  }>;
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Database client
function createDbClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL,
  });
}

// Shopify GraphQL query for products
const SHOPIFY_PRODUCTS_QUERY = `
  query getProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges {
        node {
          id
          title
          bodyHtml
          vendor
          productType
          tags
          status
          createdAt
          updatedAt
          variants(first: 250) {
            edges {
              node {
                id
                title
                price
                sku
                inventoryQuantity
                weight
                weightUnit
                selectedOptions {
                  name
                  value
                }
                createdAt
                updatedAt
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Fetch products from Shopify using GraphQL Admin API
 */
async function fetchShopifyProducts(): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;
  
  const shopifyUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/graphql.json`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN!,
  };

  console.log('🔄 Fetching products from Shopify...');

  while (hasNextPage) {
    const response: Response = await fetch(shopifyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: SHOPIFY_PRODUCTS_QUERY,
        variables: {
          first: 50,
          after: cursor,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
    }

    const data: ShopifyGraphQLResponse = await response.json();
    
    if (data.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    if (!data.data) {
      throw new Error('No data returned from Shopify GraphQL');
    }

    const edges = data.data.products.edges;
    const pageInfo = data.data.products.pageInfo;

    for (const edge of edges) {
      const product = edge.node;
      
      // Transform Shopify product to our format
      const transformedProduct: ShopifyProduct = {
        id: parseInt(product.id.split('/').pop()!),
        title: product.title,
        body_html: product.bodyHtml,
        vendor: product.vendor,
        product_type: product.productType,
        tags: Array.isArray(product.tags) ? product.tags.join(', ') : product.tags,
        status: product.status.toLowerCase(),
        variants: product.variants.edges.map((variantEdge) => {
          const variant = variantEdge.node;
          return {
            id: parseInt(variant.id.split('/').pop()!),
            product_id: parseInt(product.id.split('/').pop()!),
            title: variant.title,
            price: variant.price,
            sku: variant.sku,
            inventory_quantity: variant.inventoryQuantity,
            weight: variant.weight,
            option1: variant.selectedOptions[0]?.value || '',
            option2: variant.selectedOptions[1]?.value || '',
            option3: variant.selectedOptions[2]?.value || '',
            created_at: variant.createdAt,
            updated_at: variant.updatedAt,
          } as ShopifyVariant;
        }),
        created_at: product.createdAt,
        updated_at: product.updatedAt,
      };

      products.push(transformedProduct);
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
    
    console.log(`📦 Fetched ${products.length} products so far...`);
  }

  console.log(`✅ Retrieved ${products.length} total products from Shopify`);
  return products;
}

/**
 * Generate OpenAI embedding for product text
 */
async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
      dimensions: 1536,
    });
    
    return response.data[0].embedding;
  } catch (error) {
    console.error('❌ Error generating embedding:', error);
    throw error;
  }
}

/**
 * Extract chemical information from product data
 */
function extractChemicalInfo(product: ShopifyProduct) {
  const fullText = `${product.title} ${product.body_html} ${product.tags}`.toLowerCase();
  
  // Extract CAS number using regex
  const casMatch = fullText.match(/\b\d{2,7}-\d{2}-\d\b/);
  const cas_number = casMatch ? casMatch[0] : null;
  
  // Extract UN number
  const unMatch = fullText.match(/\bun\s*(\d{4})\b/i);
  const un_number = unMatch ? `UN${unMatch[1]}` : null;
  
  // Determine hazard class based on product type and keywords
  let hazard_class = null;
  if (fullText.includes('acid') || product.product_type.toLowerCase().includes('acid')) {
    hazard_class = 'Class 8 - Corrosive';
  } else if (fullText.includes('flammable') || fullText.includes('solvent')) {
    hazard_class = 'Class 3 - Flammable Liquid';
  }
  
  // Extract applications from tags and description
  const applications = product.tags
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag.length > 2 && !tag.match(/\d+/))
    .slice(0, 10); // Limit to 10 applications
  
  return {
    cas_number,
    un_number,
    hazard_class,
    applications,
  };
}

/**
 * Parse container size from variant title
 */
function parseContainerInfo(variantTitle: string) {
  const title = variantTitle.toLowerCase();
  
  // Extract container size (1 gallon, 5 gallon, 55 gallon, 1 quart, etc.)
  let container_size = null;
  const sizeMatch = title.match(/(\d+(?:\.\d+)?)\s*(gallon|gal|quart|qt|pound|lb|liter|l|pint|pt)\b/i);
  if (sizeMatch) {
    const amount = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toLowerCase();
    
    // Normalize units
    if (unit.startsWith('gal')) {
      container_size = `${amount} Gallon${amount !== 1 ? 's' : ''}`;
    } else if (unit.startsWith('q')) {
      container_size = `${amount} Quart${amount !== 1 ? 's' : ''}`;
    } else if (unit.startsWith('l') && unit !== 'lb') {
      container_size = `${amount} Liter${amount !== 1 ? 's' : ''}`;
    } else if (unit.startsWith('p') && unit !== 'pound') {
      container_size = `${amount} Pint${amount !== 1 ? 's' : ''}`;
    } else if (unit.includes('lb') || unit.includes('pound')) {
      container_size = `${amount} Pound${amount !== 1 ? 's' : ''}`;
    }
  }
  
  // Extract container type
  let container_type = null;
  if (title.includes('jug')) container_type = 'Jug';
  else if (title.includes('pail')) container_type = 'Pail';
  else if (title.includes('drum')) container_type = 'Drum';
  else if (title.includes('tote')) container_type = 'Tote';
  else if (title.includes('bottle')) container_type = 'Bottle';
  else if (title.includes('can')) container_type = 'Can';
  
  return { container_size, container_type };
}

/**
 * Sync a single product to the database
 */
async function syncProduct(client: Client, shopifyProduct: ShopifyProduct): Promise<void> {
  try {
    // Extract chemical information
    const chemicalInfo = extractChemicalInfo(shopifyProduct);
    
    // Generate embedding for the product
    const embeddingText = [
      shopifyProduct.title,
      shopifyProduct.body_html?.replace(/<[^>]*>/g, ''), // Strip HTML
      shopifyProduct.tags,
      chemicalInfo.applications?.join(' '),
      chemicalInfo.cas_number,
    ].filter(Boolean).join(' ');
    
    console.log(`🧬 Generating embedding for: ${shopifyProduct.title.substring(0, 50)}...`);
    const embedding = await generateEmbedding(embeddingText);
    
    // Insert or update product
    const productResult = await client.query(`
      INSERT INTO alliance_products (
        shopify_id, title, product_type, vendor, description, body_html, tags,
        cas_number, synonyms, un_number, hazard_class, applications,
        embedding, status, published_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (shopify_id) DO UPDATE SET
        title = EXCLUDED.title,
        product_type = EXCLUDED.product_type,
        description = EXCLUDED.description,
        body_html = EXCLUDED.body_html,
        tags = EXCLUDED.tags,
        cas_number = EXCLUDED.cas_number,
        un_number = EXCLUDED.un_number,
        hazard_class = EXCLUDED.hazard_class,
        applications = EXCLUDED.applications,
        embedding = EXCLUDED.embedding,
        updated_at = now()
      RETURNING id
    `, [
      shopifyProduct.id,
      shopifyProduct.title,
      shopifyProduct.product_type,
      shopifyProduct.vendor,
      shopifyProduct.body_html?.replace(/<[^>]*>/g, '').substring(0, 1000), // Strip HTML and truncate
      shopifyProduct.body_html,
      shopifyProduct.tags,
      chemicalInfo.cas_number,
      chemicalInfo.applications,
      chemicalInfo.un_number,
      chemicalInfo.hazard_class,
      chemicalInfo.applications,
      `[${embedding.join(',')}]`, // PostgreSQL array format
      shopifyProduct.status === 'active' ? 'active' : 'draft',
      new Date(shopifyProduct.created_at),
      new Date(shopifyProduct.created_at),
      new Date(shopifyProduct.updated_at),
    ]);
    
    const productId = productResult.rows[0].id;
    
    // Sync variants
    for (const variant of shopifyProduct.variants) {
      const containerInfo = parseContainerInfo(variant.title);
      
      await client.query(`
        INSERT INTO alliance_product_variants (
          product_id, shopify_variant_id, title, sku, container_size, container_type,
          price, inventory_quantity, weight, weight_unit, option1, option2, option3,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (shopify_variant_id) DO UPDATE SET
          title = EXCLUDED.title,
          sku = EXCLUDED.sku,
          container_size = EXCLUDED.container_size,
          container_type = EXCLUDED.container_type,
          price = EXCLUDED.price,
          inventory_quantity = EXCLUDED.inventory_quantity,
          weight = EXCLUDED.weight,
          updated_at = now()
      `, [
        productId,
        variant.id,
        variant.title,
        variant.sku,
        containerInfo.container_size,
        containerInfo.container_type,
        parseFloat(variant.price),
        variant.inventory_quantity,
        variant.weight,
        'lb', // Default weight unit
        variant.option1,
        variant.option2,
        variant.option3,
        new Date(variant.created_at),
        new Date(variant.updated_at),
      ]);
    }
    
    console.log(`✅ Synced: ${shopifyProduct.title} (${shopifyProduct.variants.length} variants)`);
  } catch (error) {
    console.error(`❌ Error syncing product ${shopifyProduct.title}:`, error);
    throw error;
  }
}

/**
 * Main sync function
 */
export async function syncShopifyProducts(): Promise<{
  synced: number;
  errors: number;
  duration_ms: number;
}> {
  const startTime = Date.now();
  let synced = 0;
  let errors = 0;
  
  const client = createDbClient();
  
  try {
    await client.connect();
    console.log('🔗 Connected to database');
    
    // Fetch all products from Shopify
    const shopifyProducts = await fetchShopifyProducts();
    
    console.log(`🔄 Starting sync of ${shopifyProducts.length} products...`);
    
    // Process products in batches to avoid rate limits
    const batchSize = 5; // Process 5 products at a time
    for (let i = 0; i < shopifyProducts.length; i += batchSize) {
      const batch = shopifyProducts.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (product) => {
        try {
          await syncProduct(client, product);
          synced++;
        } catch (error) {
          console.error(`❌ Failed to sync product ${product.title}:`, error);
          errors++;
        }
      });
      
      await Promise.all(batchPromises);
      
      // Rate limiting - wait 1 second between batches
      if (i + batchSize < shopifyProducts.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      console.log(`📊 Progress: ${Math.min(i + batchSize, shopifyProducts.length)}/${shopifyProducts.length} products processed`);
    }
    
    console.log(`🎉 Sync complete! ${synced} synced, ${errors} errors`);
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    throw error;
  } finally {
    await client.end();
  }
  
  return {
    synced,
    errors,
    duration_ms: Date.now() - startTime,
  };
}