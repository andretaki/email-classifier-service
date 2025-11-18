require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    console.log('🚀 Starting prompt management migration...');
    await client.connect();
    
    // Read the SQL migration file
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, 'sql', 'create-prompt-management-schema.sql'),
      'utf8'
    );
    
    console.log('📝 Running migration...');
    await client.query(migrationSQL);
    
    console.log('✅ Migration completed successfully!');
    
    // Verify tables were created
    const verifyQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN (
        'prompt_templates', 
        'response_rules', 
        'response_feedback',
        'prompt_variables',
        'prompt_ab_tests',
        'response_cache'
      )
      ORDER BY table_name;
    `;
    
    const result = await client.query(verifyQuery);
    console.log('\n📊 Created tables:');
    result.rows.forEach(row => {
      console.log(`   ✓ ${row.table_name}`);
    });
    
    // Check if default templates were inserted
    const templateCount = await client.query(
      'SELECT COUNT(*) as count FROM prompt_templates'
    );
    console.log(`\n📋 Template count: ${templateCount.rows[0].count}`);
    
    if (templateCount.rows[0].count > 0) {
      const templates = await client.query(
        'SELECT name, category FROM prompt_templates ORDER BY category'
      );
      console.log('\n🎯 Default templates:');
      templates.rows.forEach(t => {
        console.log(`   - ${t.name} (${t.category})`);
      });
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    
    // If it's a duplicate error, show what exists
    if (error.message.includes('already exists')) {
      console.log('\n⚠️  Some tables already exist. Checking current state...');
      
      try {
        const existingTables = await client.query(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name LIKE 'prompt_%' 
          OR table_name LIKE 'response_%'
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