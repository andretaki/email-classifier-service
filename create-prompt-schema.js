require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');

async function createPromptSchema() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  
  try {
    await client.connect();
    console.log('Connected to database...');
    
    // Read the schema SQL
    const schemaSql = fs.readFileSync('sql/create-prompt-management-schema.sql', 'utf8');
    
    // Execute the entire schema as one transaction
    await client.query('BEGIN');
    
    try {
      await client.query(schemaSql);
      await client.query('COMMIT');
      console.log('✅ Prompt management schema created successfully!');
      
      // Verify tables were created
      const result = await client.query(`
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
      `);
      
      console.log('\n📋 Created tables:');
      result.rows.forEach(row => {
        console.log(`  - ${row.table_name}`);
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    
  } catch (error) {
    console.error('❌ Error creating schema:', error.message);
    throw error;
  } finally {
    await client.end();
  }
}

// Run if called directly
if (require.main === module) {
  createPromptSchema()
    .then(() => {
      console.log('\n🎉 Prompt management system ready!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Failed to create schema:', error);
      process.exit(1);
    });
}

module.exports = { createPromptSchema };