const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS passkey_hash VARCHAR(255);');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname VARCHAR(100) DEFAULT \'\';');
  // Departments table
  await pool.query(`CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL
  )`);
  // Seed default departments if empty
  const { rows: deptRows } = await pool.query('SELECT COUNT(*) FROM departments');
  if (parseInt(deptRows[0].count) === 0) {
    const defaults = ['บริหาร','ขาย','บัญชี','สโตร์','ฝ่ายบุคคล','ช่าง','พนักงานทั่วไป'];
    for (const name of defaults) {
      await pool.query('INSERT INTO departments (name) VALUES($1) ON CONFLICT(name) DO NOTHING', [name]);
    }
    console.log('✅ Default departments seeded');
  }
  console.log('✅ Database initialized');
}

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log('query', { text: text.substring(0,60), duration, rows: res.rowCount });
  }
  return res;
}

async function auditLog(action, username, targetId, details, ip) {
  try {
    await query(
      'INSERT INTO audit_log (action, username, target_id, details, ip) VALUES ($1,$2,$3,$4,$5)',
      [action, username, targetId, JSON.stringify(details), ip]
    );
  } catch(e) { console.error('Audit log error:', e.message); }
}

module.exports = { pool, query, initDB, auditLog };
