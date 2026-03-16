const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');

const app = express();

// Конфигурация столов (такая же, как в server.js)
const SEATS = [
  { id: 1, block: 'left', label: 'Стол 1' },
  { id: 2, block: 'left', label: 'Стол 2' },
  { id: 3, block: 'left', label: 'Стол 3' },
  { id: 4, block: 'left', label: 'Стол 4' },
  { id: 5, block: 'right', label: 'Стол 5' },
  { id: 6, block: 'right', label: 'Стол 6' },
  { id: 7, block: 'right', label: 'Стол 7' },
  { id: 8, block: 'right', label: 'Стол 8' },
  { id: 9, block: 'glass', label: 'Кабинет 1' },
  { id: 10, block: 'glass', label: 'Кабинет 2' }
];

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Настройка пула соединений с БД для serverless-окружения
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20, // максимальное количество соединений в пуле
  idleTimeoutMillis: 30000, // время простоя соединения до закрытия
  connectionTimeoutMillis: 5000, // таймаут соединения
});

// Вспомогательная функция: получить текущее состояние мест
async function getCurrentSeats() {
  const today = new Date().toISOString().split('T')[0];
  const query = `
    SELECT s.id, s.block, s.label, o.client_id, u.name
    FROM (SELECT * FROM jsonb_to_recordset($1::jsonb) AS (id INT, block TEXT, label TEXT)) s
    LEFT JOIN occupancy o ON o.seat_id = s.id AND o.date = $2
    LEFT JOIN users u ON o.client_id = u.client_id
    ORDER BY s.id
  `;
  const values = [JSON.stringify(SEATS), today];
  const result = await pool.query(query, values);
  return result.rows.map(row => ({
    id: row.id,
    block: row.block,
    label: row.label,
    occupied: !!row.client_id,
    userName: row.name || null,
    clientId: row.client_id || null
  }));
}

// API endpoints (перенесены из server.js)
app.get('/api/user', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const result = await pool.query('SELECT name FROM users WHERE client_id = $1', [clientId]);
    res.json({ name: result.rows[0]?.name || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user', async (req, res) => {
  const { clientId, name } = req.body;
  if (!clientId || !name) return res.status(400).json({ error: 'clientId and name required' });
  try {
    await pool.query(
      'INSERT INTO users (client_id, name) VALUES ($1, $2) ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name',
      [clientId, name]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getCurrentSeats();
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/occupy', async (req, res) => {
  const { clientId, seatId, name } = req.body;
  if (!clientId || !seatId) return res.status(400).json({ error: 'clientId and seatId required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (name) {
      await client.query(
        'INSERT INTO users (client_id, name) VALUES ($1, $2) ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name',
        [clientId, name]
      );
    }

    await client.query(
      'DELETE FROM occupancy WHERE client_id = $1 AND date = CURRENT_DATE',
      [clientId]
    );

    await client.query(
      'INSERT INTO occupancy (seat_id, client_id, date) VALUES ($1, $2, CURRENT_DATE)',
      [seatId, clientId]
    );

    await client.query('COMMIT');

    const seats = await getCurrentSeats();
    res.json(seats);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      res.status(409).json({ error: 'Seat already occupied' });
    } else {
      res.status(500).json({ error: err.message });
    }
  } finally {
    client.release();
  }
});

app.delete('/api/occupy', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  try {
    await pool.query(
      'DELETE FROM occupancy WHERE client_id = $1 AND date = CURRENT_DATE',
      [clientId]
    );
    const seats = await getCurrentSeats();
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin endpoints (аналогично server.js, но с auth)
const auth = require('basic-auth');

function adminAuth(req, res, next) {
  const credentials = auth(req);
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  if (!credentials || credentials.name !== adminUser || credentials.pass !== adminPass) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.get('/api/admin/occupancy', adminAuth, async (req, res) => {
  try {
    const query = `
      SELECT o.id, o.seat_id, s.label, u.name, o.date
      FROM occupancy o
      JOIN users u ON o.client_id = u.client_id
      JOIN (SELECT * FROM jsonb_to_recordset($1::jsonb) AS (id INT, label TEXT)) s ON o.seat_id = s.id
      WHERE o.date = CURRENT_DATE
      ORDER BY o.seat_id
    `;
    const values = [JSON.stringify(SEATS.map(s => ({ id: s.id, label: s.label })))];
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/occupancy/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM occupancy WHERE id = $1', [id]);
    const seats = await getCurrentSeats();
    res.json({ success: true, seats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/clear-today', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM occupancy WHERE date = CURRENT_DATE');
    const seats = await getCurrentSeats();
    res.json({ success: true, seats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Экспортируем app для Vercel (ОЧЕНЬ ВАЖНО!)
module.exports = app;

app.post('/api/cron/reset-daily', async (req, res) => {
  // Проверка секретного ключа для безопасности
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await pool.query('DELETE FROM occupancy WHERE date = CURRENT_DATE');
    console.log('Daily reset completed');
    res.json({ success: true, message: 'All seats cleared for today' });
  } catch (err) {
    console.error('Reset failed:', err);
    res.status(500).json({ error: err.message });
  }
});