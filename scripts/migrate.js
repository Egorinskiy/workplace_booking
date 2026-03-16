const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  console.log('Running migrations...');

  // Создаём пул с дополнительными опциями для принудительного IPv4
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,                // форсировать IPv4
    connectionTimeoutMillis: 10000, // таймаут подключения 10 сек
    idleTimeoutMillis: 30000,
  });

  try {
    const sqlPath = path.join(__dirname, '../db/init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    console.log('Migrations completed successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();