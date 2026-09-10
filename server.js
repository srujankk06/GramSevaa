'use strict';

const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');

// ─── App Setup ────────────────────────────────────────────────────────────────
const app     = express();
const PORT    = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'panchayat_issues.db');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SQLite via sql.js ────────────────────────────────────────────────────────
let db;

function persistDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function exec(sql) {
  db.run(sql);
}

function run(sql, params = []) {
  const stmt    = db.prepare(sql);
  stmt.run(params);
  const changes = db.getRowsModified();
  const lastRow = db.exec('SELECT last_insert_rowid() AS id')[0];
  const lastId  = lastRow ? lastRow.values[0][0] : null;
  stmt.free();
  return { changes, lastInsertRowid: lastId };
}

function query(sql, params = []) {
  const stmt    = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  return query(sql, params)[0];
}

// ─── DB Initialization ────────────────────────────────────────────────────────
async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    // Delete old DB to get fresh schema on restart if columns changed
    // Comment this out after first run if you want to preserve data
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('🗄️  Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('🗄️  Created new database at', DB_PATH);
  }

  // Users table — citizen and admin accounts
  exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT    UNIQUE NOT NULL,
      name       TEXT    NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'citizen',
      password   TEXT    NOT NULL,
      created_at TEXT    DEFAULT (datetime('now'))
    )
  `);

  // Departments table
  exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT    UNIQUE NOT NULL
    )
  `);

  // Main reports / issues table
  exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id          TEXT    UNIQUE NOT NULL,
      citizen_phone      TEXT,
      citizen_name       TEXT,
      category           TEXT    NOT NULL,
      description        TEXT,
      latitude           REAL,
      longitude          REAL,
      photo_base64       TEXT,
      status             TEXT    NOT NULL DEFAULT 'ವರದಿಯಾಗಿದೆ',
      dept_assigned      TEXT,
      resolution_note    TEXT,
      resolution_image   TEXT,
      alert_sent         INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    DEFAULT (datetime('now')),
      updated_at         TEXT    DEFAULT (datetime('now'))
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS idx_status   ON reports(status)`);
  exec(`CREATE INDEX IF NOT EXISTS idx_category ON reports(category)`);
  exec(`CREATE INDEX IF NOT EXISTS idx_citizen  ON reports(citizen_phone)`);

  // Feedback table
  exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id    TEXT    NOT NULL,
      citizen_name TEXT,
      rating       INTEGER NOT NULL,
      comment      TEXT,
      created_at   TEXT    DEFAULT (datetime('now'))
    )
  `);

  persistDB();
  seedDatabase();
}

// ─── Ticket ID Generator ───────────────────────────────────────────────────────
function generateTicketId() {
  const num = Math.floor(1000 + Math.random() * 9000);
  const ts  = Date.now().toString(36).toUpperCase().slice(-4);
  return `GS-${num}-${ts}`;
}

function createUniqueTicketId() {
  let id;
  do {
    id = generateTicketId();
  } while (queryOne('SELECT id FROM reports WHERE ticket_id = ?', [id]));
  return id;
}

// ─── Seed Data ────────────────────────────────────────────────────────────────
function seedDatabase() {
  // Seed default admin + test citizens
  const defaultUsers = [
    { phone: 'admin',       name: 'ಪಂಚಾಯತ್ ಅಧಿಕಾರಿ',  role: 'admin',   password: 'admin123' },
    { phone: '9900000001',  name: 'ರಾಜೇಶ್ ಕುಮಾರ್',     role: 'citizen', password: 'citizen1' },
    { phone: '9900000002',  name: 'ಸವಿತಾ ದೇವಿ',        role: 'citizen', password: 'citizen2' },
  ];
  for (const u of defaultUsers) {
    run(
      `INSERT OR IGNORE INTO users (phone, name, role, password) VALUES (?, ?, ?, ?)`,
      [u.phone, u.name, u.role, u.password]
    );
  }

  // Seed departments
  const depts = [
    'ರಸ್ತೆ ಮತ್ತು ಸೇತುವೆ ವಿಭಾಗ',
    'ಜಲ ಸಂಪನ್ಮೂಲ ವಿಭಾಗ',
    'ವಿದ್ಯುತ್ ವಿಭಾಗ',
    'ಶೌಚಾಲಯ ಮತ್ತು ನೈರ್ಮಲ್ಯ ವಿಭಾಗ',
    'ಪರಿಸರ ವಿಭಾಗ',
    'ಶಿಕ್ಷಣ ವಿಭಾಗ',
  ];
  for (const d of depts) {
    run(`INSERT OR IGNORE INTO departments (name) VALUES (?)`, [d]);
  }

  // Seed a few sample reports
  const sampleCount = queryOne('SELECT COUNT(*) as cnt FROM reports');
  if (sampleCount && sampleCount.cnt === 0) {
    const samples = [
      {
        ticket_id: 'GS-1001-DEMO', citizen_phone: '9900000001', citizen_name: 'ರಾಜೇಶ್ ಕುಮಾರ್',
        category: 'ರಸ್ತೆ ಹಾನಿ', description: 'ಮುಖ್ಯ ರಸ್ತೆಯಲ್ಲಿ ದೊಡ್ಡ ಗುಂಡಿ ಇದೆ, ವಾಹನಗಳಿಗೆ ತೊಂದರೆ ಆಗುತ್ತಿದೆ.',
        latitude: 15.3173, longitude: 75.7139, status: 'ಪರಿಹಾರವಾಗಿದೆ',
        dept_assigned: 'ರಸ್ತೆ ಮತ್ತು ಸೇತುವೆ ವಿಭಾಗ', alert_sent: 1,
      },
      {
        ticket_id: 'GS-1002-DEMO', citizen_phone: '9900000002', citizen_name: 'ಸವಿತಾ ದೇವಿ',
        category: 'ನೀರಿನ ಸೋರಿಕೆ', description: 'ಕೊಳವೆ ಒಡೆದಿದ್ದು ನೀರು ವ್ಯರ್ಥವಾಗುತ್ತಿದೆ.',
        latitude: 15.3200, longitude: 75.7200, status: 'ಪ್ರಕ್ರಿಯೆಯಲ್ಲಿದೆ',
        dept_assigned: 'ಜಲ ಸಂಪನ್ಮೂಲ ವಿಭಾಗ', alert_sent: 0,
      },
      {
        ticket_id: 'GS-1003-DEMO', citizen_phone: '9900000001', citizen_name: 'ರಾಜೇಶ್ ಕುಮಾರ್',
        category: 'ಬೀದಿ ದೀಪ', description: 'ಶಾಲೆಯ ಬಳಿ ಮೂರು ಬೀದಿ ದೀಪಗಳು ಕೆಟ್ಟಿವೆ.',
        latitude: 15.3150, longitude: 75.7100, status: 'ವರದಿಯಾಗಿದೆ',
        dept_assigned: null, alert_sent: 0,
      },
    ];
    for (const s of samples) {
      run(
        `INSERT OR IGNORE INTO reports
           (ticket_id, citizen_phone, citizen_name, category, description, latitude, longitude, status, dept_assigned, alert_sent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.ticket_id, s.citizen_phone, s.citizen_name, s.category, s.description,
         s.latitude, s.longitude, s.status, s.dept_assigned || null, s.alert_sent]
      );
    }

    // Seed one feedback entry
    run(
      `INSERT OR IGNORE INTO feedback (ticket_id, citizen_name, rating, comment) VALUES (?, ?, ?, ?)`,
      ['GS-1001-DEMO', 'ರಾಜೇಶ್ ಕುಮಾರ್', 5, 'ತುಂಬಾ ಚೆನ್ನಾಗಿ ಕೆಲಸ ಮಾಡಿದ್ದೀರಿ, ಧನ್ಯವಾದಗಳು!']
    );
  }

  persistDB();
  console.log('✅ Database seeded successfully.');
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Auth ─────────────────────────────────────────────────────────────────────

// POST /api/login
app.post('/api/login', (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password)
      return res.status(400).json({ error: 'ಫೋನ್ ಮತ್ತು ಪಾಸ್‌ವರ್ಡ್ ಅಗತ್ಯ' });

    const user = queryOne(
      'SELECT id, phone, name, role FROM users WHERE phone = ? AND password = ?',
      [phone, password]
    );

    if (!user)
      return res.status(401).json({ error: 'ತಪ್ಪಾದ ಫೋನ್ ಸಂಖ್ಯೆ ಅಥವಾ ಪಾಸ್‌ವರ್ಡ್' });

    return res.json({ success: true, user });
  } catch (err) {
    console.error('POST /api/login error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// POST /api/register  (citizen self-register)
app.post('/api/register', (req, res) => {
  try {
    const { phone, name, password } = req.body;
    if (!phone || !name || !password)
      return res.status(400).json({ error: 'ಎಲ್ಲಾ ಮಾಹಿತಿ ತುಂಬಿರಿ' });

    const existing = queryOne('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing)
      return res.status(409).json({ error: 'ಈ ಫೋನ್ ಸಂಖ್ಯೆ ಈಗಾಗಲೇ ನೋಂದಾಯಿಸಲಾಗಿದೆ' });

    run(
      `INSERT INTO users (phone, name, role, password) VALUES (?, ?, 'citizen', ?)`,
      [phone, name, password]
    );
    persistDB();

    const user = queryOne('SELECT id, phone, name, role FROM users WHERE phone = ?', [phone]);
    return res.status(201).json({ success: true, user });
  } catch (err) {
    console.error('POST /api/register error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// ─── Departments ──────────────────────────────────────────────────────────────

// GET /api/departments
app.get('/api/departments', (_req, res) => {
  try {
    const depts = query('SELECT * FROM departments ORDER BY name');
    return res.json({ success: true, departments: depts });
  } catch (err) {
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

// POST /api/reports  — citizen files a complaint
app.post('/api/reports', (req, res) => {
  try {
    const { citizen_phone, citizen_name, category, description, latitude, longitude, photo_base64 } = req.body;

    if (!category)
      return res.status(400).json({ error: 'ವರ್ಗವನ್ನು ಆಯ್ಕೆ ಮಾಡಿ' });
    if (!citizen_phone)
      return res.status(400).json({ error: 'ಫೋನ್ ಸಂಖ್ಯೆ ಅಗತ್ಯ' });

    const ticket_id = createUniqueTicketId();

    run(
      `INSERT INTO reports
         (ticket_id, citizen_phone, citizen_name, category, description, latitude, longitude, photo_base64, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ವರದಿಯಾಗಿದೆ')`,
      [
        ticket_id,
        citizen_phone,
        citizen_name || null,
        category,
        description || null,
        latitude  != null ? parseFloat(latitude)  : null,
        longitude != null ? parseFloat(longitude) : null,
        photo_base64 || null,
      ]
    );
    persistDB();

    const created = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [ticket_id]);
    console.log(`🆕 ಹೊಸ ದೂರು: ${ticket_id} | ${category}`);
    return res.status(201).json({ success: true, report: created });
  } catch (err) {
    console.error('POST /api/reports error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ', details: err.message });
  }
});

// GET /api/reports  — admin gets all; citizen filtered by phone
app.get('/api/reports', (req, res) => {
  try {
    const { status, category, citizen_phone } = req.query;
    let sql    = 'SELECT * FROM reports WHERE 1=1';
    const params = [];

    if (status        && status   !== 'All') { sql += ' AND status = ?';         params.push(status); }
    if (category      && category !== 'All') { sql += ' AND category = ?';       params.push(category); }
    if (citizen_phone)                       { sql += ' AND citizen_phone = ?';  params.push(citizen_phone); }

    sql += ' ORDER BY created_at DESC LIMIT 500';

    const reports = query(sql, params);
    const lite    = reports.map(r => ({
      ...r,
      photo_base64:      r.photo_base64      ? '[PHOTO]' : null,
      resolution_image:  r.resolution_image  ? '[PHOTO]' : null,
    }));

    return res.json({ success: true, count: lite.length, reports: lite });
  } catch (err) {
    console.error('GET /api/reports error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// GET /api/reports/:ticket_id  — single report with full photos
app.get('/api/reports/:ticket_id', (req, res) => {
  try {
    const report = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [req.params.ticket_id]);
    if (!report) return res.status(404).json({ error: 'ದೂರು ಕಂಡುಬಂದಿಲ್ಲ' });
    return res.json({ success: true, report });
  } catch (err) {
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// PATCH /api/reports/:ticket_id/assign  — admin assigns department
app.patch('/api/reports/:ticket_id/assign', (req, res) => {
  try {
    const { dept_assigned } = req.body;
    const { ticket_id }     = req.params;

    if (!dept_assigned)
      return res.status(400).json({ error: 'ವಿಭಾಗ ಆಯ್ಕೆ ಮಾಡಿ' });

    const existing = queryOne('SELECT id FROM reports WHERE ticket_id = ?', [ticket_id]);
    if (!existing) return res.status(404).json({ error: 'ದೂರು ಕಂಡುಬಂದಿಲ್ಲ' });

    run(
      `UPDATE reports SET dept_assigned = ?, status = 'ಪ್ರಕ್ರಿಯೆಯಲ್ಲಿದೆ', updated_at = datetime('now')
       WHERE ticket_id = ?`,
      [dept_assigned, ticket_id]
    );
    persistDB();

    const updated = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [ticket_id]);
    console.log(`📋 ವಿಭಾಗ ನಿಯೋಜನೆ: ${ticket_id} → ${dept_assigned}`);
    return res.json({ success: true, report: updated });
  } catch (err) {
    console.error('PATCH assign error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// PATCH /api/reports/:ticket_id/resolve  — mark resolved, attach image + note
app.patch('/api/reports/:ticket_id/resolve', (req, res) => {
  try {
    const { resolution_note, resolution_image } = req.body;
    const { ticket_id }                         = req.params;

    const existing = queryOne('SELECT id FROM reports WHERE ticket_id = ?', [ticket_id]);
    if (!existing) return res.status(404).json({ error: 'ದೂರು ಕಂಡುಬಂದಿಲ್ಲ' });

    run(
      `UPDATE reports
       SET status = 'ಪರಿಹಾರವಾಗಿದೆ', resolution_note = ?, resolution_image = ?,
           alert_sent = 1, updated_at = datetime('now')
       WHERE ticket_id = ?`,
      [resolution_note || null, resolution_image || null, ticket_id]
    );
    persistDB();

    const updated = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [ticket_id]);
    console.log(`✅ ಪರಿಹಾರ: ${ticket_id}`);
    return res.json({ success: true, report: updated });
  } catch (err) {
    console.error('PATCH resolve error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// GET /api/notifications/:phone  — citizen polls for alerts (resolved issues not seen yet)
app.get('/api/notifications/:phone', (req, res) => {
  try {
    const { phone } = req.params;
    const alerts = query(
      `SELECT ticket_id, category, resolution_note, resolution_image, updated_at
       FROM reports
       WHERE citizen_phone = ? AND status = 'ಪರಿಹಾರವಾಗಿದೆ' AND alert_sent = 1`,
      [phone]
    );
    return res.json({ success: true, notifications: alerts });
  } catch (err) {
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// ─── Feedback ─────────────────────────────────────────────────────────────────

// POST /api/feedback
app.post('/api/feedback', (req, res) => {
  try {
    const { ticket_id, citizen_name, rating, comment } = req.body;
    if (!ticket_id || !rating)
      return res.status(400).json({ error: 'ಟಿಕೆಟ್ ಮತ್ತು ರೇಟಿಂಗ್ ಅಗತ್ಯ' });

    const existing = queryOne('SELECT id FROM feedback WHERE ticket_id = ?', [ticket_id]);
    if (existing)
      return res.status(409).json({ error: 'ಈ ದೂರಿಗೆ ಈಗಾಗಲೇ ಪ್ರತಿಕ್ರಿಯೆ ನೀಡಲಾಗಿದೆ' });

    run(
      `INSERT INTO feedback (ticket_id, citizen_name, rating, comment) VALUES (?, ?, ?, ?)`,
      [ticket_id, citizen_name || 'ಅನಾಮಧೇಯ', parseInt(rating), comment || null]
    );
    persistDB();

    return res.status(201).json({ success: true, message: 'ಪ್ರತಿಕ್ರಿಯೆ ಸಲ್ಲಿಸಲಾಗಿದೆ' });
  } catch (err) {
    console.error('POST /api/feedback error:', err);
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// GET /api/feedback
app.get('/api/feedback', (req, res) => {
  try {
    const feedbacks = query(
      'SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100'
    );
    return res.json({ success: true, feedback: feedbacks });
  } catch (err) {
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// GET /api/stats
app.get('/api/stats', (_req, res) => {
  try {
    const total      = (queryOne("SELECT COUNT(*) as n FROM reports") || {}).n || 0;
    const reported   = (queryOne("SELECT COUNT(*) as n FROM reports WHERE status = 'ವರದಿಯಾಗಿದೆ'") || {}).n || 0;
    const inProgress = (queryOne("SELECT COUNT(*) as n FROM reports WHERE status = 'ಪ್ರಕ್ರಿಯೆಯಲ್ಲಿದೆ'") || {}).n || 0;
    const resolved   = (queryOne("SELECT COUNT(*) as n FROM reports WHERE status = 'ಪರಿಹಾರವಾಗಿದೆ'") || {}).n || 0;
    const byCategory = query(
      'SELECT category, COUNT(*) as count FROM reports GROUP BY category ORDER BY count DESC'
    );
    return res.json({ success: true, stats: { total, reported, inProgress, resolved, byCategory } });
  } catch (err) {
    return res.status(500).json({ error: 'ಸರ್ವರ್ ದೋಷ' });
  }
});

// Catch-all — SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown() {
  if (db) { persistDB(); db.close(); }
  console.log('\n👋 Server shut down cleanly.');
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─── Bootstrap ───────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   🌿 ಗ್ರಾಮ ಸೇವಾ — Server Running                   ║');
    console.log(`║   📡  http://localhost:${PORT}                          ║`);
    console.log('║   🗄️  Database: panchayat_issues.db                  ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
    console.log('  Login credentials:');
    console.log('  Admin  → phone: admin      | password: admin123');
    console.log('  Citizen→ phone: 9900000001 | password: citizen1');
    console.log('');
  });
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
