const postgres = require('postgres');
require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL || process.argv[2];

if (!DATABASE_URL) {
  console.error('Please provide DATABASE_URL as environment variable or argument');
  process.exit(1);
}

console.log('Connecting to database...');

async function runMigration() {
  const sql = postgres(DATABASE_URL);

  try {
    console.log('Creating email_classifier_patterns table...');

    await sql`
      CREATE TABLE IF NOT EXISTS email_classifier_patterns (
        id SERIAL PRIMARY KEY,
        pattern_type TEXT,
        pattern_value TEXT,
        typical_classification TEXT,
        confidence_boost DECIMAL(3,2),
        occurrence_count INTEGER DEFAULT 1,
        last_seen TIMESTAMP DEFAULT NOW()
      )
    `;

    console.log('Creating indexes...');

    await sql`
      CREATE INDEX IF NOT EXISTS idx_patterns_type_value
      ON email_classifier_patterns(pattern_type, pattern_value)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_patterns_last_seen
      ON email_classifier_patterns(last_seen)
    `;

    console.log('✅ Migration completed successfully!');

    // Check if table was created
    const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE tablename = 'email_classifier_patterns'
    `;

    if (tables.length > 0) {
      console.log('✅ Table email_classifier_patterns exists');

      // Count rows
      const count = await sql`SELECT COUNT(*) as count FROM email_classifier_patterns`;
      console.log(`   Table has ${count[0].count} rows`);
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

runMigration();
