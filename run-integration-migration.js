#!/usr/bin/env node

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('🚀 Starting integration tables migration...');
    await client.connect();
    
    // Read the SQL migration file
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, 'sql', 'create-integration-tables.sql'),
      'utf8'
    );
    
    console.log('📝 Creating integration tables...');
    await client.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    
    // Verify tables were created
    const verifyQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN (
        'email_response_drafts',
        'webhook_events',
        'template_usage',
        'system_metrics'
      )
      ORDER BY table_name;
    `;
    
    const result = await client.query(verifyQuery);
    console.log('\n📊 Created tables:');
    result.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name}`);
    });
    
    // Check current metrics
    const metricsQuery = `
      SELECT COUNT(*) as draft_count FROM email_response_drafts;
    `;
    
    const metrics = await client.query(metricsQuery);
    console.log(`\n📈 Current state:`);
    console.log(`   - Response drafts: ${metrics.rows[0].draft_count}`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    
    // Check if tables already exist
    if (error.message.includes('already exists')) {
      console.log('\n⚠️  Some tables already exist. Current state:');
      
      try {
        const existingTables = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND (
            table_name LIKE 'email_%' 
            OR table_name LIKE 'webhook_%'
            OR table_name LIKE 'system_%'
            OR table_name LIKE 'template_%'
          )
          ORDER BY table_name;
        `);
        
        if (existingTables.rows.length > 0) {
          console.log('\n📊 Existing tables:');
          existingTables.rows.forEach(row => {
            console.log(`   ✓ ${row.table_name}`);
          });
        }
      } catch (checkError) {
        console.error('Failed to check existing tables:', checkError.message);
      }
    }
    
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run the migration
runMigration().catch(error => {
  console.error('Unexpected error:', error);
  process.exit(1);
});