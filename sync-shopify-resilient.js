require('dotenv').config();
const { Client } = require('pg');
const OpenAI = require('openai').default;
const fs = require('fs');
const path = require('path');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Checkpoint file to track progress
const CHECKPOINT_FILE = path.join(__dirname, 'sync-checkpoint.json');

/**
 * Load checkpoint to resume from last position
 */
function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const data = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.log('⚠️  Could not load checkpoint, starting fresh');
  }
  return { 
    lastSyncedId: null, 
    syncedCount: 0, 
    totalProducts: 0,
    syncedProducts: []
  };
}

/**
 * Save checkpoint after each successful sync
 */
function saveCheckpoint(checkpoint) {
  try {
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
  } catch (error) {
    console.error('⚠️  Failed to save checkpoint:', error.message);
  }
}

/**
 * Create database connection with retry logic
 */
async function createDbConnection(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 30000,
        idle_in_transaction_session_timeout: 60000,
      });
      await client.connect();
      console.log('✅ Database connected');
      return client;
    } catch (error) {
      console.log(`⚠️  Connection attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }
  throw new Error('Failed to connect to database after multiple attempts');
}

// Shopify GraphQL query
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
 * Fetch products from Shopify with pagination
 */
async function fetchShopifyProducts() {
  const products = [];
  let hasNextPage = true;
  let cursor = null;
  
  const shopifyUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/graphql.json`;
  const headers = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
  };

  console.log('🔄 Fetching products from Shopify...');

  while (hasNextPage) {
    try {
      const response = await fetch(shopifyUrl, {
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

      const data = await response.json();
      
      if (data.errors) {
        throw new Error(`Shopify GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      const edges = data.data.products.edges;
      const pageInfo = data.data.products.pageInfo;

      for (const edge of edges) {
        const product = edge.node;
        
        const transformedProduct = {
          id: parseInt(product.id.split('/').pop()),
          title: product.title,
          body_html: product.bodyHtml,
          vendor: product.vendor,
          product_type: product.productType,
          tags: Array.isArray(product.tags) ? product.tags : product.tags || [],
          status: product.status.toLowerCase(),
          variants: product.variants.edges.map((variantEdge) => {
            const variant = variantEdge.node;
            return {
              id: parseInt(variant.id.split('/').pop()),
              product_id: parseInt(product.id.split('/').pop()),
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
            };
          }),
          created_at: product.createdAt,
          updated_at: product.updatedAt,
        };

        products.push(transformedProduct);
      }

      hasNextPage = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;
      
      console.log(`📦 Fetched ${products.length} products so far...`);
    } catch (error) {
      console.error('❌ Error fetching from Shopify:', error);
      throw error;
    }
  }

  console.log(`✅ Retrieved ${products.length} total products from Shopify`);
  return products;
}

/**
 * Generate embedding with retry logic
 */
async function generateEmbedding(text, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
        dimensions: 1536,
      });
      
      return response.data[0].embedding;
    } catch (error) {
      console.log(`⚠️  Embedding attempt ${i + 1} failed:`, error.message);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        throw error;
      }
    }
  }
}

/**
 * Extract chemical information from product
 */
function extractChemicalInfo(product) {
  const fullText = `${product.title} ${product.body_html || ''} ${Array.isArray(product.tags) ? product.tags.join(' ') : product.tags}`.toLowerCase();
  
  // Extract CAS number
  const casMatch = fullText.match(/\b\d{2,7}-\d{2}-\d\b/);
  const cas_number = casMatch ? casMatch[0] : null;
  
  // Extract UN number
  const unMatch = fullText.match(/\bun\s*(\d{4})\b/i);
  const un_number = unMatch ? `UN${unMatch[1]}` : null;
  
  // Determine hazard class
  let hazard_class = null;
  if (fullText.includes('acid') || (product.product_type || '').toLowerCase().includes('acid')) {
    hazard_class = 'Class 8 - Corrosive';
  } else if (fullText.includes('flammable') || fullText.includes('solvent')) {
    hazard_class = 'Class 3 - Flammable Liquid';
  }
  
  // Extract applications from tags
  const tags = Array.isArray(product.tags) ? product.tags : (product.tags || '').split(',');
  const applications = tags
    .map(tag => tag.trim().toLowerCase())
    .filter(tag => tag.length > 2 && !tag.match(/\d+/))
    .slice(0, 10);
  
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
function parseContainerInfo(variantTitle) {
  const title = variantTitle.toLowerCase();
  
  let container_size = null;
  const sizeMatch = title.match(/(\d+(?:\.\d+)?)\s*(gallon|gal|quart|qt|pound|lb|liter|l|pint|pt)\b/i);
  if (sizeMatch) {
    const amount = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2].toLowerCase();
    
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
 * Sync a single product with retry logic
 */
async function syncProduct(client, shopifyProduct, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Extract chemical information
      const chemicalInfo = extractChemicalInfo(shopifyProduct);
      
      // Generate embedding for the product
      const tagsText = Array.isArray(shopifyProduct.tags) ? shopifyProduct.tags.join(' ') : shopifyProduct.tags;
      const embeddingText = [
        shopifyProduct.title,
        shopifyProduct.body_html?.replace(/<[^>]*>/g, ''), // Strip HTML
        tagsText,
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
        shopifyProduct.body_html?.replace(/<[^>]*>/g, '').substring(0, 1000),
        shopifyProduct.body_html,
        tagsText,
        chemicalInfo.cas_number,
        chemicalInfo.applications,
        chemicalInfo.un_number,
        chemicalInfo.hazard_class,
        chemicalInfo.applications,
        `[${embedding.join(',')}]`,
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
          'lb',
          variant.option1,
          variant.option2,
          variant.option3,
          new Date(variant.created_at),
          new Date(variant.updated_at),
        ]);
      }
      
      console.log(`✅ Synced: ${shopifyProduct.title} (${shopifyProduct.variants.length} variants)`);
      return true;
      
    } catch (error) {
      console.error(`❌ Attempt ${attempt + 1} failed for ${shopifyProduct.title}:`, error.message);
      
      if (attempt < retries - 1) {
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if connection is still alive
        try {
          await client.query('SELECT 1');
        } catch (connError) {
          console.log('🔄 Reconnecting to database...');
          // Connection lost, need to reconnect
          throw new Error('DATABASE_CONNECTION_LOST');
        }
      } else {
        throw error;
      }
    }
  }
  return false;
}

/**
 * Main sync function with checkpoint support
 */
async function syncShopifyProducts() {
  const startTime = Date.now();
  let synced = 0;
  let errors = 0;
  let client = null;
  
  try {
    // Load checkpoint
    const checkpoint = loadCheckpoint();
    console.log(`📌 Checkpoint loaded: ${checkpoint.syncedCount} products already synced`);
    
    // Connect to database
    client = await createDbConnection();
    
    // Fetch all products from Shopify
    const shopifyProducts = await fetchShopifyProducts();
    checkpoint.totalProducts = shopifyProducts.length;
    
    // Filter out already synced products
    const productsToSync = checkpoint.lastSyncedId 
      ? shopifyProducts.filter(p => !checkpoint.syncedProducts.includes(p.id))
      : shopifyProducts;
    
    console.log(`📋 Products to sync: ${productsToSync.length} of ${shopifyProducts.length} total`);
    
    // Process products
    const batchSize = 3;
    for (let i = 0; i < productsToSync.length; i += batchSize) {
      const batch = productsToSync.slice(i, i + batchSize);
      
      for (const product of batch) {
        try {
          // Check database connection
          if (!client) {
            console.log('🔄 Reconnecting to database...');
            client = await createDbConnection();
          }
          
          const success = await syncProduct(client, product);
          
          if (success) {
            synced++;
            checkpoint.syncedCount++;
            checkpoint.lastSyncedId = product.id;
            checkpoint.syncedProducts.push(product.id);
            
            // Save checkpoint after each successful sync
            saveCheckpoint(checkpoint);
          }
        } catch (error) {
          if (error.message === 'DATABASE_CONNECTION_LOST') {
            // Reconnect and retry
            if (client) {
              await client.end().catch(() => {});
            }
            client = await createDbConnection();
            i--; // Retry this batch
            continue;
          }
          
          console.error(`❌ Failed to sync ${product.title}:`, error.message);
          errors++;
        }
      }
      
      // Progress update
      const totalProcessed = checkpoint.syncedCount;
      const percentage = Math.round((totalProcessed / shopifyProducts.length) * 100);
      console.log(`📊 Progress: ${totalProcessed}/${shopifyProducts.length} (${percentage}%)`);
      
      // Rate limiting between batches
      if (i + batchSize < productsToSync.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log(`\n🎉 Sync complete!`);
    console.log(`   ✅ Successfully synced: ${synced} products`);
    console.log(`   ❌ Errors: ${errors} products`);
    console.log(`   📊 Total in database: ${checkpoint.syncedCount} products`);
    console.log(`   ⏱️  Duration: ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`);
    
    // Clear checkpoint on successful completion
    if (checkpoint.syncedCount === shopifyProducts.length) {
      fs.unlinkSync(CHECKPOINT_FILE);
      console.log('🗑️  Checkpoint cleared (all products synced)');
    }
    
  } catch (error) {
    console.error('❌ Sync failed:', error);
    throw error;
  } finally {
    if (client) {
      await client.end();
    }
  }
  
  return {
    synced,
    errors,
    duration_ms: Date.now() - startTime,
  };
}

// Run the sync
if (require.main === module) {
  console.log('🚀 Starting resilient Shopify sync...');
  console.log('   This script will automatically resume from checkpoint if interrupted\n');
  
  syncShopifyProducts()
    .then((result) => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { syncShopifyProducts };