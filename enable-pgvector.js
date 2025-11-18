require('dotenv').config();
const { Client } = require('pg');

async function enablePgVector() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Connected to Neon database...');

    // Enable pgvector extension
    console.log('Enabling pgvector extension...');
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');

    // Verify extension is installed
    console.log('Verifying pgvector installation...');
    const result = await client.query(`
      SELECT extname, extversion 
      FROM pg_extension 
      WHERE extname = 'vector';
    `);

    if (result.rows.length > 0) {
      console.log('✅ pgvector extension enabled successfully!');
      console.log(`Version: ${result.rows[0].extversion}`);
    } else {
      console.log('❌ pgvector extension not found');
      return;
    }

    // Check available vector operators
    console.log('\nAvailable vector index types:');
    const operators = await client.query(`
      SELECT 
          amname as access_method,
          opcname as operator_class
      FROM pg_am 
      JOIN pg_opclass ON pg_am.oid = pg_opclass.opcmethod
      WHERE amname IN ('ivfflat', 'hnsw')
      ORDER BY amname, opcname;
    `);

    operators.rows.forEach(row => {
      console.log(`  - ${row.access_method}: ${row.operator_class}`);
    });

    console.log('\n🎉 Database is ready for vector operations!');

  } catch (error) {
    console.error('❌ Error enabling pgvector:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

enablePgVector();