require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

async function createProductSchema() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Connected to Neon database...');

    // Read and execute the schema SQL
    console.log('Creating product schema...');
    const schemaSql = fs.readFileSync('sql/create-product-schema.sql', 'utf8');
    
    // Handle multi-line SQL statements properly
    // First, remove comments and normalize whitespace
    const cleanSql = schemaSql
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');
    
    // Split by semicolon followed by newline or end of string
    const statements = [];
    let currentStatement = '';
    let insideDollarQuote = false;
    let dollarTag = '';
    
    for (const line of cleanSql.split('\n')) {
      const trimmedLine = line.trim();
      
      // Handle dollar quoting for functions
      if (!insideDollarQuote && trimmedLine.includes('$$')) {
        insideDollarQuote = true;
        dollarTag = trimmedLine.match(/\$(\w*)\$/)?.[0] || '$$';
      } else if (insideDollarQuote && line.includes(dollarTag)) {
        insideDollarQuote = false;
      }
      
      currentStatement += line + '\n';
      
      // If we hit a semicolon at the end of a line and we're not in a dollar quote
      if (!insideDollarQuote && trimmedLine.endsWith(';')) {
        const stmt = currentStatement.trim();
        if (stmt.length > 10 && !stmt.startsWith('COMMENT')) {
          statements.push(stmt);
        }
        currentStatement = '';
      }
    }
    
    // Add any remaining statement
    if (currentStatement.trim().length > 10) {
      statements.push(currentStatement.trim());
    }

    console.log(`Executing ${statements.length} SQL statements...`);

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      
      try {
        // Skip comments and empty statements
        if (statement.startsWith('COMMENT') || statement.startsWith('--') || statement.length < 10) {
          continue;
        }
        
        await client.query(statement);
        
        // Log progress for major operations
        if (statement.includes('CREATE TABLE')) {
          const tableName = statement.match(/CREATE TABLE (\w+)/i)?.[1];
          console.log(`✅ Created table: ${tableName}`);
        } else if (statement.includes('CREATE INDEX')) {
          const indexName = statement.match(/CREATE INDEX (\w+)/i)?.[1];
          console.log(`✅ Created index: ${indexName}`);
        } else if (statement.includes('CREATE VIEW')) {
          const viewName = statement.match(/CREATE VIEW (\w+)/i)?.[1];
          console.log(`✅ Created view: ${viewName}`);
        } else if (statement.includes('CREATE TRIGGER')) {
          const triggerName = statement.match(/CREATE TRIGGER (\w+)/i)?.[1];
          console.log(`✅ Created trigger: ${triggerName}`);
        }
      } catch (error) {
        // Log but don't fail on expected errors (like table already exists)
        if (error.message.includes('already exists')) {
          console.log(`⚠️  Skipping: ${error.message.split('ERROR:')[1]?.trim()}`);
        } else {
          console.error(`❌ Error executing statement: ${statement.substring(0, 50)}...`);
          console.error(`Error: ${error.message}`);
        }
      }
    }

    // Verify tables were created
    console.log('\nVerifying schema creation...');
    const tablesResult = await client.query(`
      SELECT table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name LIKE 'alliance_%' 
        OR table_name IN ('quotes', 'quote_line_items', 'product_search_log', 'product_synonyms')
      ORDER BY table_name;
    `);

    console.log('\n📋 Created tables:');
    tablesResult.rows.forEach(row => {
      console.log(`  - ${row.table_name} (${row.table_type.toLowerCase()})`);
    });

    // Check indexes
    const indexResult = await client.query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE tablename LIKE 'alliance_%' 
        OR tablename IN ('quotes', 'quote_line_items', 'product_search_log')
      ORDER BY tablename, indexname;
    `);

    console.log('\n🔍 Created indexes:');
    const indexesByTable = {};
    indexResult.rows.forEach(row => {
      if (!indexesByTable[row.tablename]) {
        indexesByTable[row.tablename] = [];
      }
      indexesByTable[row.tablename].push(row.indexname);
    });

    Object.keys(indexesByTable).forEach(table => {
      console.log(`  ${table}:`);
      indexesByTable[table].forEach(index => {
        console.log(`    - ${index}`);
      });
    });

    console.log('\n🎉 Product schema created successfully!');
    console.log('\n📊 Schema Summary:');
    console.log('  • alliance_products - Main catalog with vector embeddings');
    console.log('  • alliance_product_variants - SKUs and pricing');
    console.log('  • alliance_variant_pricing_tiers - Volume discounts');
    console.log('  • product_search_log - Search analytics');
    console.log('  • quotes & quote_line_items - Quote management');
    console.log('  • Full-text search indexes for hybrid search');
    console.log('  • HNSW vector index for similarity search');

  } catch (error) {
    console.error('❌ Error creating schema:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

createProductSchema();