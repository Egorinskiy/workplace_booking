const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const cron = require('node-cron');
const path = require('path');
const auth = require('basic-auth');
const cors = require('cors');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Настройка подключения к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:123QAZwsx@localhost:5432/workplace_booking',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Конфигурация столов (можно вынести в БД при необходимости)
const SEATS = [
  // Блок 1: столы 1-4
  { id: 1, block: 'left', label: 'Стол 1' },
  { id: 2, block: 'left', label: 'Стол 2' },
  { id: 3, block: 'left', label: 'Стол 3' },
  { id: 4, block: 'left', label: 'Стол 4' },
  // Блок 2: столы 5-8
  { id: 5, block: 'right', label: 'Стол 5' },
  { id: 6, block: 'right', label: 'Стол 6' },
  { id: 7, block: 'right', label: 'Стол 7' },
  { id: 8, block: 'right', label: 'Стол 8' },
  // Кабинет-стекляшка: столы 9-10
  { id: 9, block: 'glass', label: 'Кабинет 1' },
  { id: 10, block: 'glass', label: 'Кабинет 2' }
];

// Вспомогательная функция: получить текущее состояние мест с именами
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

// Функция для аутентификации админа
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

// ----- API endpoints -----

// Получить имя пользователя по clientId
app.get('/api/user', async (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const result = await pool.query('SELECT name FROM users WHERE client_id = $1', [clientId]);
    if (result.rows.length > 0) {
      res.json({ name: result.rows[0].name });
    } else {
      res.json({ name: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Сохранить имя пользователя
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

// Получить текущее состояние всех мест
app.get('/api/seats', async (req, res) => {
  try {
    const seats = await getCurrentSeats();
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Занять стол
app.post('/api/occupy', async (req, res) => {
  const { clientId, seatId, name } = req.body;
  if (!clientId || !seatId) return res.status(400).json({ error: 'clientId and seatId required' });

  // Проверим, существует ли стол
  const seat = SEATS.find(s => s.id === seatId);
  if (!seat) return res.status(400).json({ error: 'Invalid seatId' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Если имя передано, сохраняем/обновляем пользователя
    if (name) {
      await client.query(
        'INSERT INTO users (client_id, name) VALUES ($1, $2) ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name',
        [clientId, name]
      );
    }

    // Освобождаем предыдущее место пользователя сегодня (если есть)
    await client.query(
      'DELETE FROM occupancy WHERE client_id = $1 AND date = CURRENT_DATE',
      [clientId]
    );

    // Пытаемся занять новое место (уникальность seat_id+date защитит от двойного бронирования)
    await client.query(
      'INSERT INTO occupancy (seat_id, client_id, date) VALUES ($1, $2, CURRENT_DATE)',
      [seatId, clientId]
    );

    await client.query('COMMIT');

    // Рассылаем обновление всем клиентам
    const seats = await getCurrentSeats();
    io.emit('seats-updated', seats);
    res.json(seats);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    // Если нарушено уникальное ограничение, значит стол уже занят
    if (err.code === '23505') { // PostgreSQL unique violation
      res.status(409).json({ error: 'Seat already occupied' });
    } else {
      res.status(500).json({ error: err.message });
    }
  } finally {
    client.release();
  }
});

// Освободить свой стол
app.delete('/api/occupy', async (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  try {
    await pool.query(
      'DELETE FROM occupancy WHERE client_id = $1 AND date = CURRENT_DATE',
      [clientId]
    );
    const seats = await getCurrentSeats();
    io.emit('seats-updated', seats);
    res.json(seats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Административные endpoints (с аутентификацией) -----
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Получить список занятых сегодня мест (для админки)
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

// Удалить конкретную запись о занятости
app.delete('/api/admin/occupancy/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM occupancy WHERE id = $1', [id]);
    const seats = await getCurrentSeats();
    io.emit('seats-updated', seats);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Очистить все занятия за сегодня
app.post('/api/admin/clear-today', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM occupancy WHERE date = CURRENT_DATE');
    const seats = await getCurrentSeats();
    io.emit('seats-updated', seats);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- Планировщик сброса в полночь -----
cron.schedule('0 0 * * *', async () => {
  console.log('Сброс занятости в полночь');
  try {
    await pool.query('DELETE FROM occupancy WHERE date = CURRENT_DATE');
    const seats = await getCurrentSeats();
    io.emit('seats-updated', seats);
  } catch (err) {
    console.error('Ошибка при сбросе:', err);
  }
}, {
  timezone: "Europe/Moscow" // Укажите ваш часовой пояс
});

// ----- Запуск сервера -----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});