'use strict';

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const initSqlJs = require('sql.js');

// ─── App Setup ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'panchayat_issues.db');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── SQLite via sql.js (pure JS, no native compilation needed) ────────────────
let db;   // sql.js Database instance

/** Persist the in-memory DB to disk after every write */
function persistDB() {
  const data = db.export();  // Uint8Array
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/** Run one or many SQL statements that don't return rows */
function exec(sql) {
  db.run(sql);
}

/** Run a prepared statement with params; returns { changes, lastInsertRowid } */
function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.run(params);
  const changes     = db.getRowsModified();
  const lastRow     = db.exec('SELECT last_insert_rowid() AS id')[0];
  const lastId      = lastRow ? lastRow.values[0][0] : null;
  stmt.free();
  return { changes, lastInsertRowid: lastId };
}

/** Execute a SELECT and return an array of plain objects */
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

/** Execute a SELECT and return the first row object, or undefined */
function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0];
}

// ─── DB Initialization ────────────────────────────────────────────────────────
async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('🗄️  Loaded existing database from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('🗄️  Created new database at', DB_PATH);
  }

  exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id     TEXT    UNIQUE NOT NULL,
      category      TEXT    NOT NULL,
      description   TEXT,
      latitude      REAL,
      longitude     REAL,
      photo_base64  TEXT,
      status        TEXT    NOT NULL DEFAULT 'Reported',
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now'))
    )
  `);

  exec(`CREATE INDEX IF NOT EXISTS idx_status   ON reports(status)`);
  exec(`CREATE INDEX IF NOT EXISTS idx_category ON reports(category)`);
  persistDB();

  seedDatabase();
}

// ─── Ticket ID Generator ───────────────────────────────────────────────────────
function generateTicketId() {
  const num = Math.floor(1000 + Math.random() * 9000);
  const ts  = Date.now().toString(36).toUpperCase().slice(-4);
  return `TICKET-${num}-${ts}`;
}

function createUniqueTicketId() {
  let id;
  do {
    id = generateTicketId();
  } while (queryOne('SELECT id FROM reports WHERE ticket_id = ?', [id]));
  return id;
}

// ─── Seed Sample Data ─────────────────────────────────────────────────────────
function seedDatabase() {
  const count = queryOne('SELECT COUNT(*) as cnt FROM reports');
  if (count && count.cnt > 0) return;

  console.log('📦 Seeding database with sample reports...');

  const samples = [
    { ticket_id: 'TICKET-1042-DEMO', category: 'Streetlights',   description: 'Three consecutive streetlights are non-functional near the main bazaar area. Creates safety hazard at night.',                               latitude: 28.6139, longitude: 77.2090, status: 'In Progress' },
    { ticket_id: 'TICKET-1043-DEMO', category: 'Water Leaks',     description: 'Major pipe burst on the main road causing water wastage and road damage. Water has been leaking for 3 days.',                                  latitude: 28.6200, longitude: 77.2150, status: 'Reported'     },
    { ticket_id: 'TICKET-1044-DEMO', category: 'Road Damage',     description: 'Large pothole (approx 2ft wide, 8 inches deep) on the village approach road. Multiple two-wheelers have been damaged.',                       latitude: 28.6080, longitude: 77.2020, status: 'Reported'     },
    { ticket_id: 'TICKET-1045-DEMO', category: 'Public Toilets',  description: 'Community toilet block near school is broken. Doors missing and no water supply. Affecting 200+ students daily.',                             latitude: 28.6160, longitude: 77.2250, status: 'Resolved'     },
    { ticket_id: 'TICKET-1046-DEMO', category: 'Streetlights',   description: 'Overhead cable has snapped and is hanging dangerously low over the road. Poses electrocution risk.',                                           latitude: 28.6050, longitude: 77.2180, status: 'In Progress' },
    { ticket_id: 'TICKET-1047-DEMO', category: 'Water Leaks',     description: 'Underground water main leaking at the junction. Road surface has become muddy and slippery.',                                                  latitude: 28.6220, longitude: 77.1980, status: 'Resolved'     },
  ];

  for (const s of samples) {
    run(
      `INSERT OR IGNORE INTO reports (ticket_id, category, description, latitude, longitude, photo_base64, status)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [s.ticket_id, s.category, s.description, s.latitude, s.longitude, s.status]
    );
  }
  persistDB();
  console.log(`✅ Seeded ${samples.length} sample reports.`);
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// POST /api/reports
app.post('/api/reports', (req, res) => {
  try {
    const { category, description, latitude, longitude, photo_base64 } = req.body;

    if (!category) return res.status(400).json({ error: 'category is required' });

    const validCategories = ['Streetlights', 'Water Leaks', 'Public Toilets', 'Road Damage'];
    if (!validCategories.includes(category))
      return res.status(400).json({ error: `category must be one of: ${validCategories.join(', ')}` });

    const ticket_id = createUniqueTicketId();

    run(
      `INSERT INTO reports (ticket_id, category, description, latitude, longitude, photo_base64, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Reported')`,
      [
        ticket_id,
        category,
        description || null,
        latitude  != null ? parseFloat(latitude)  : null,
        longitude != null ? parseFloat(longitude) : null,
        photo_base64 || null,
      ]
    );
    persistDB();

    const created = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [ticket_id]);
    console.log(`🆕 New report: ${ticket_id} | ${category}`);
    return res.status(201).json({ success: true, report: created });

  } catch (err) {
    console.error('POST /api/reports error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/reports
app.get('/api/reports', (req, res) => {
  try {
    const { status, category } = req.query;
    let sql    = 'SELECT * FROM reports WHERE 1=1';
    const params = [];

    if (status   && status   !== 'All') { sql += ' AND status = ?';   params.push(status); }
    if (category && category !== 'All') { sql += ' AND category = ?'; params.push(category); }
    sql += ' ORDER BY created_at DESC LIMIT 500';

    const reports = query(sql, params);

    // Strip photo from list view
    const lightweight = reports.map(r => ({
      ...r,
      photo_base64: r.photo_base64 ? '[PHOTO_AVAILABLE]' : null,
    }));

    return res.json({ success: true, count: reports.length, reports: lightweight });

  } catch (err) {
    console.error('GET /api/reports error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/reports/:ticket_id — single report with full photo
app.get('/api/reports/:ticket_id', (req, res) => {
  try {
    const report = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [req.params.ticket_id]);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    return res.json({ success: true, report });
  } catch (err) {
    console.error('GET /api/reports/:ticket_id error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// PATCH /api/reports/:ticket_id
app.patch('/api/reports/:ticket_id', (req, res) => {
  try {
    const { status } = req.body;
    const { ticket_id } = req.params;

    const validStatuses = ['Reported', 'In Progress', 'Resolved'];
    if (!status || !validStatuses.includes(status))
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });

    const existing = queryOne('SELECT id FROM reports WHERE ticket_id = ?', [ticket_id]);
    if (!existing) return res.status(404).json({ error: 'Report not found' });

    run(
      `UPDATE reports SET status = ?, updated_at = datetime('now') WHERE ticket_id = ?`,
      [status, ticket_id]
    );
    persistDB();

    const updated = queryOne('SELECT * FROM reports WHERE ticket_id = ?', [ticket_id]);
    updated.photo_base64 = updated.photo_base64 ? '[PHOTO_AVAILABLE]' : null;

    console.log(`✏️  Updated: ${ticket_id} → ${status}`);
    return res.json({ success: true, report: updated });

  } catch (err) {
    console.error('PATCH /api/reports/:ticket_id error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  try {
    const total      = (queryOne("SELECT COUNT(*) as n FROM reports") || {}).n || 0;
    const reported   = (queryOne("SELECT COUNT(*) as n FROM reports WHERE status = 'Reported'") || {}).n || 0;
    const inProgress = (queryOne("SELECT COUNT(*) as n FROM reports WHERE status = 'In Progress'") || {}).n || 0;
    const resolved   = (queryOne("SELECT COUNT(*) as n FROM reports WHERE status = 'Resolved'") || {}).n || 0;
    const byCategory = query(`SELECT category, COUNT(*) as count FROM reports GROUP BY category ORDER BY count DESC`);

    return res.json({ success: true, stats: { total, reported, inProgress, resolved, byCategory } });
  } catch (err) {
    console.error('GET /api/stats error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// DELETE /api/reports/:ticket_id
app.delete('/api/reports/:ticket_id', (req, res) => {
  try {
    const { changes } = run('DELETE FROM reports WHERE ticket_id = ?', [req.params.ticket_id]);
    if (changes === 0) return res.status(404).json({ error: 'Report not found' });
    persistDB();
    return res.json({ success: true, message: 'Report deleted' });
  } catch (err) {
    console.error('DELETE /api/reports/:ticket_id error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Catch-all SPA
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
    console.log('║   🏛️  Panchayat Issue Reporter — Server Running      ║');
    console.log(`║   📡  http://localhost:${PORT}                          ║`);
    console.log('║   🗄️  Database: panchayat_issues.db                  ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');
  });
}).catch(err => {
  console.error('❌ Failed to initialize database:', err);
  process.exit(1);
});
