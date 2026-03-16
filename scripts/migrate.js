const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises; // добавим DNS

async function migrate() {
  console.log('Running migrations...');

  // Диагностика: резолвим хост
  const url = new URL(process.env.DATABASE_URL);
  const hostname = url.hostname;
  console.log(`Resolving hostname: ${hostname} (IPv4 only)...`);
  try {
    const addresses = await dns.lookup(hostname, { family: 4 });
    console.log(`Resolved IPv4: ${addresses.address}`);
  } catch (err) {
    console.error('DNS lookup failed:', err);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4,
    connectionTimeoutMillis: 10000,
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