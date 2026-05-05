const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 4500;

// ─── WebSocket: broadcast para todos os clientes ligados ─────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected', payload: { msg: 'Ligado ao Pazmar Balance em tempo real' } }));
  ws.on('error', () => {});
});
const JWT_SECRET = process.env.JWT_SECRET || 'pazmar_secret_2026_key';

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ─── Base de Dados ────────────────────────────────────────────────────────────
// Suporta volume persistente no Fly.io via DB_PATH, ou usa directório local
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'pazmar.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Criar tabelas
db.exec(`
  CREATE TABLE IF NOT EXISTS agencies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#1A56DB',
    location TEXT NOT NULL DEFAULT 'Lobito',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('management','agent','accountant')),  -- accountant added
    agency_id TEXT,
    zone TEXT,
    shift TEXT CHECK(shift IN ('morning','afternoon') OR shift IS NULL),
    pin_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY(agency_id) REFERENCES agencies(id)
  );

  CREATE TABLE IF NOT EXISTS gatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_id TEXT NOT NULL,
    user_id TEXT,
    date TEXT NOT NULL,
    shift TEXT NOT NULL,
    expected_amount REAL NOT NULL,
    actual_amount REAL NOT NULL,
    difference REAL NOT NULL,
    note TEXT DEFAULT '',
    auto_registered INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(agency_id) REFERENCES agencies(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS shift_records (
    id TEXT PRIMARY KEY,
    agency_id TEXT NOT NULL,
    date TEXT NOT NULL,
    shift TEXT NOT NULL CHECK(shift IN ('morning','afternoon')),
    initial_balance REAL,
    agent_initial_balance REAL,
    agent_closing_balance REAL,
    bank_balance REAL,
    notes TEXT DEFAULT '',
    opened_at TEXT,
    opened_by TEXT,
    agent_opened_by TEXT,
    closed_at TEXT,
    closed_by TEXT,
    confirmed_at TEXT,
    confirmed_by TEXT,
    first_movement_type TEXT,
    first_movement_amount REAL,
    first_movement_notes TEXT,
    first_movement_at TEXT,
    last_movement_type TEXT,
    last_movement_amount REAL,
    last_movement_notes TEXT,
    last_movement_at TEXT,
    left_in_agency REAL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(agency_id) REFERENCES agencies(id),
    UNIQUE(agency_id, date, shift)
  );

  CREATE TABLE IF NOT EXISTS account_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_id TEXT NOT NULL,
    date TEXT NOT NULL,
    shift TEXT NOT NULL CHECK(shift IN ('morning','afternoon')),
    validated_by TEXT NOT NULL,
    counted_amount REAL,
    declared_amount REAL,
    gato_money REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    validated_at TEXT NOT NULL,
    FOREIGN KEY(agency_id) REFERENCES agencies(id),
    FOREIGN KEY(validated_by) REFERENCES users(id),
    UNIQUE(agency_id, date, shift)
  );

  CREATE TABLE IF NOT EXISTS deposit_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_date TEXT NOT NULL,
    source_shift TEXT NOT NULL CHECK(source_shift IN ('morning','afternoon','all')),
    deposit_date TEXT NOT NULL,
    deposit_slot TEXT NOT NULL,
    agency_id TEXT NOT NULL,
    expected_amount REAL NOT NULL,
    confirmed_amount REAL,
    difference REAL,
    confirmed_by TEXT,
    confirmed_at TEXT,
    notes TEXT DEFAULT '',
    FOREIGN KEY(agency_id) REFERENCES agencies(id),
    FOREIGN KEY(confirmed_by) REFERENCES users(id),
    UNIQUE(source_date, source_shift, agency_id)
  );

  CREATE TABLE IF NOT EXISTS daily_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    validated_at TEXT NOT NULL,
    validated_by TEXT NOT NULL,
    notes TEXT DEFAULT '',
    total_agencies INTEGER DEFAULT 0,
    ok_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    medium_count INTEGER DEFAULT 0,
    alert_count INTEGER DEFAULT 0,
    pending_count INTEGER DEFAULT 0,
    unlocked_at TEXT,
    unlocked_by TEXT,
    FOREIGN KEY(validated_by) REFERENCES users(id)
  );
`);

// ─── Migração: adicionar coluna tpa_amount se não existir ───────────────────
try {
  db.exec('ALTER TABLE shift_records ADD COLUMN tpa_amount REAL DEFAULT 0');
} catch(e) { /* coluna já existe */ }

// ─── Dados Iniciais ───────────────────────────────────────────────────────────
function seedData() {
  const agencyCount = db.prepare('SELECT COUNT(*) as c FROM agencies').get().c;
  if (agencyCount > 0) return;

  const agencies = [
    { id: 'p1', name: 'Pazmar 1', code: 'P1', color: '#1A56DB', location: 'Lobito' },
    { id: 'p2', name: 'Pazmar 2', code: 'P2', color: '#7C3AED', location: 'Benguela' },
    { id: 'p3', name: 'Pazmar 3', code: 'P3', color: '#0F766E', location: 'Lobito' },
    { id: 'p4', name: 'Pazmar 4', code: 'P4', color: '#D97706', location: 'Lobito' },
    { id: 'p5', name: 'Pazmar 5', code: 'P5', color: '#DC2626', location: 'Lobito' },
    { id: 'p6', name: 'Pazmar 6', code: 'P6', color: '#16A34A', location: 'Benguela' },
  ];

  const insertAgency = db.prepare(
    'INSERT INTO agencies (id, name, code, color, location, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  );
  for (const a of agencies) {
    insertAgency.run(a.id, a.name, a.code, a.color, a.location, new Date().toISOString());
  }

  // Gerência + Gestores Intermédios + Agentes
  const users = [
    { id: 'mgmt',               name: 'Gerência',              role: 'management',  agencyId: null, zone: null,       shift: null, pin: '0000' },
    { id: 'accountant_lobito',  name: 'Contabilista Lobito',  role: 'accountant',  agencyId: null, zone: 'Lobito',   shift: null, pin: '7777' },
    { id: 'accountant_benguela',name: 'Contabilista Benguela',role: 'accountant',  agencyId: null, zone: 'Benguela', shift: null, pin: '8888' },
  ];

  // 2 agentes por agência (manhã e tarde)
  for (let i = 1; i <= 6; i++) {
    users.push({
      id: `p${i}_morning`,
      name: `Agente P${i} Manhã`,
      role: 'agent',
      agencyId: `p${i}`,
      zone: null,
      shift: 'morning',
      pin: `${i}${i}${i}${i}`,
    });
    users.push({
      id: `p${i}_afternoon`,
      name: `Agente P${i} Tarde`,
      role: 'agent',
      agencyId: `p${i}`,
      zone: null,
      shift: 'afternoon',
      pin: `${i}${i}${(i % 10 + 1) % 10}${(i % 10 + 1) % 10}`,
    });
  }

  const insertUser = db.prepare(
    'INSERT INTO users (id, name, role, agency_id, zone, shift, pin_hash, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
  );
  for (const u of users) {
    const hash = bcrypt.hashSync(u.pin, 10);
    insertUser.run(u.id, u.name, u.role, u.agencyId, u.zone, u.shift, hash, new Date().toISOString());
  }

  console.log('✅ Dados iniciais criados (6 agências, 15 utilizadores)');
}
seedData();

// ─── Autenticação ─────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function managementOnly(req, res, next) {
  if (req.user.role !== 'management') return res.status(403).json({ error: 'Acesso restrito à Gerência' });
  next();
}

function managementOrAccountant(req, res, next) {
  if (!['management', 'accountant'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso restrito à Gerência ou Contabilistas' });
  }
  next();
}

function managementOrZoneManager(req, res, next) {
  if (!['management', 'zone_manager', 'accountant'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso restrito' });
  }
  next();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function calcTriangularDiff(record) {
  // Para a tarde: Saldo Inicial = Deixado Manhã + Bancário Manhã
  // Fórmula: (Deixado Manhã + Bancário Manhã) - Físico Tarde = Bancário Noite
  // Diferença = (Deixado Manhã + Bancário Manhã) - Físico Tarde - Bancário Noite
  // Para a manhã: fórmula original
  // TPA: soma ao físico para o cálculo (P2 e P6), mas NÃO entra no depósito
  const managerInitial = record.initial_balance ?? 0;
  const agentInitial = record.agent_initial_balance ?? 0;
  const expected = managerInitial + agentInitial;
  const physical = record.agent_closing_balance;
  const bank = record.bank_balance;
  const tpa = record.tpa_amount ?? 0;
  if (physical === null && bank === null) return null;
  if (record.initial_balance === null) return null;
  // Diferença = (Físico + TPA + Bancário) - Esperado
  // Positivo = sobra; Negativo = falta
  const actual = (physical ?? 0) + tpa + (bank ?? 0);
  return actual - expected;
}

function getDiffStatus(diff, warnThreshold = 2000, alertThreshold = 10000) {
  if (diff === null) return 'pending';
  const abs = Math.abs(diff);
  if (abs === 0) return 'ok';
  if (abs <= warnThreshold) return 'warning';
  if (abs <= alertThreshold) return 'medium';
  return 'alert';
}

function formatRecord(r) {
  const diff = calcTriangularDiff(r);
  const managerInitial = r.initial_balance ?? 0;
  const agentInitial = r.agent_initial_balance ?? 0;
  const expectedTotal = managerInitial + agentInitial;
  const physical = r.agent_closing_balance;
  const bank = r.bank_balance;
  const leftInAgency = r.left_in_agency ?? null;
  const tpa = r.tpa_amount ?? 0;
  const actualTotal = (physical !== null || bank !== null) ? ((physical ?? 0) + tpa + (bank ?? 0)) : null;
  // Valor a depositar = Físico - Deixado na Agência (TPA NÃO entra no depósito)
  const toDeposit = (physical !== null && leftInAgency !== null) ? physical - leftInAgency : (physical ?? null);
  const colorMap = { ok: 'green', warning: 'yellow', medium: 'orange', alert: 'red', pending: 'gray' };
  const status = getDiffStatus(diff);
  return {
    ...r,
    difference: diff,
    status,
    color: colorMap[status] || 'gray',
    expectedTotal,
    actualTotal,
    left_in_agency: leftInAgency,
    to_deposit: toDeposit,
    tpa_amount: tpa,
  };
}

// ─── Rotas: Auth ──────────────────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, name, role, agency_id, shift, zone FROM users WHERE is_active = 1 ORDER BY role DESC, name'
  ).all();
  res.json(users);
});

app.post('/api/auth/login', (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) return res.status(400).json({ error: 'userId e pin são obrigatórios' });

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
  if (!user) return res.status(401).json({ error: 'Utilizador não encontrado' });

  const valid = bcrypt.compareSync(String(pin), user.pin_hash);
  if (!valid) return res.status(401).json({ error: 'PIN incorreto' });

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role, agencyId: user.agency_id, zone: user.zone, shift: user.shift },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  const agency = user.agency_id
    ? db.prepare('SELECT * FROM agencies WHERE id = ?').get(user.agency_id)
    : null;

  res.json({ token, user: { id: user.id, name: user.name, role: user.role, agencyId: user.agency_id, zone: user.zone, shift: user.shift }, agency });
});

app.post('/api/auth/change-pin', authMiddleware, (req, res) => {
  const { targetUserId, newPin } = req.body;
  if (!newPin || String(newPin).length !== 4) return res.status(400).json({ error: 'PIN deve ter 4 dígitos' });

  // Gerência pode alterar qualquer PIN; agente só o seu
  const userId = req.user.role === 'management' ? (targetUserId || req.user.id) : req.user.id;
  const hash = bcrypt.hashSync(String(newPin), 10);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(hash, userId);
  res.json({ ok: true });
});

// ─── Rotas: Agências ──────────────────────────────────────────────────────────
// Rota pública — usada no ecrã de login (sem autenticação)
app.get('/api/agencies-public', (req, res) => {
  try {
    const agencies = db.prepare('SELECT id, name, code, color, location FROM agencies WHERE is_active = 1 ORDER BY name').all();
    res.json(agencies);
  } catch(e) { res.json([]); }
});

app.get('/api/agencies', authMiddleware, (req, res) => {
  // Gestor de zona vê apenas as agências da sua zona
  if (req.user.role === 'zone_manager' && req.user.zone) {
    const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 AND location = ? ORDER BY name').all(req.user.zone);
    return res.json(agencies);
  }
  const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 ORDER BY name').all();
  res.json(agencies);
});

app.post('/api/agencies', authMiddleware, managementOnly, (req, res) => {
  const { name, code, color, location } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name e code são obrigatórios' });
  const id = `agency_${uuidv4().slice(0, 8)}`;
  const loc = location || 'Lobito';
  db.prepare('INSERT INTO agencies (id, name, code, color, location, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(id, name, code, color || '#1A56DB', loc, new Date().toISOString());
  res.json({ id, name, code, color: color || '#1A56DB', location: loc });
});

app.put('/api/agencies/:id', authMiddleware, managementOnly, (req, res) => {
  const { name, code, color, location } = req.body;
  db.prepare('UPDATE agencies SET name = ?, code = ?, color = ?, location = ? WHERE id = ?')
    .run(name, code, color, location || 'Lobito', req.params.id);
  res.json({ ok: true });
});

// ─── Rotas: Utilizadores ──────────────────────────────────────────────────────
app.get('/api/users/all', authMiddleware, managementOnly, (req, res) => {
  const users = db.prepare(
    'SELECT id, name, role, agency_id, shift, is_active, created_at FROM users ORDER BY role DESC, name'
  ).all();
  res.json(users);
});

app.put('/api/users/:id', authMiddleware, managementOnly, (req, res) => {
  const { name } = req.body;
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

// ─── Rotas: Registos de Saldo ─────────────────────────────────────────────────
app.get('/api/records/today', authMiddleware, (req, res) => {
  const today = getTodayDate();
  let records;
  if (req.user.role === 'management') {
    records = db.prepare('SELECT * FROM shift_records WHERE date = ? ORDER BY agency_id, shift').all(today);
  } else if (req.user.role === 'zone_manager' && req.user.zone) {
    // Gestor de zona vê apenas as agências da sua zona
    const agencyIds = db.prepare('SELECT id FROM agencies WHERE location = ? AND is_active = 1').all(req.user.zone).map(a => a.id);
    if (agencyIds.length === 0) { records = []; }
    else {
      const placeholders = agencyIds.map(() => '?').join(',');
      records = db.prepare(`SELECT * FROM shift_records WHERE date = ? AND agency_id IN (${placeholders}) ORDER BY agency_id, shift`).all(today, ...agencyIds);
    }
  } else {
    records = db.prepare('SELECT * FROM shift_records WHERE date = ? AND agency_id = ?').all(today, req.user.agencyId);
  }
  res.json(records.map(formatRecord));
});

app.get('/api/records', authMiddleware, (req, res) => {
  const { agencyId, from, to } = req.query;
  let query = 'SELECT * FROM shift_records WHERE 1=1';
  const params = [];

  if (req.user.role === 'zone_manager' && req.user.zone) {
    const agencyIds = db.prepare('SELECT id FROM agencies WHERE location = ? AND is_active = 1').all(req.user.zone).map(a => a.id);
    if (agencyIds.length > 0) {
      const placeholders = agencyIds.map(() => '?').join(',');
      query += ` AND agency_id IN (${placeholders})`;
      params.push(...agencyIds);
    }
  } else if (req.user.role !== 'management') {
    query += ' AND agency_id = ?';
    params.push(req.user.agencyId);
  } else if (agencyId) {
    query += ' AND agency_id = ?';
    params.push(agencyId);
  }

  if (from) { query += ' AND date >= ?'; params.push(from); }
  if (to) { query += ' AND date <= ?'; params.push(to); }

  query += ' ORDER BY date DESC, agency_id, shift LIMIT 200';
  const records = db.prepare(query).all(...params);
  res.json(records.map(formatRecord));
});

// Obter ou criar registo para hoje
function getOrCreateRecord(agencyId, date, shift) {
  let record = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?')
    .get(agencyId, date, shift);
  if (!record) {
    const id = `${agencyId}_${date}_${shift}`;
    db.prepare(`INSERT INTO shift_records (id, agency_id, date, shift, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, agencyId, date, shift, new Date().toISOString());
    record = db.prepare('SELECT * FROM shift_records WHERE id = ?').get(id);
  }
  return record;
}

// Definir saldo inicial (Gerência)
app.post('/api/records/set-initial', authMiddleware, managementOnly, (req, res, next) => {
  try {
  const { agencyId, date, shift, initialBalance } = req.body;
  if (!agencyId || !date || !shift || initialBalance === undefined) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  }
  getOrCreateRecord(agencyId, date, shift);
  db.prepare(`UPDATE shift_records SET initial_balance = ?, opened_at = ?, opened_by = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
    .run(initialBalance, new Date().toISOString(), req.user.id, agencyId, date, shift);
  const updated = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
  broadcast('record_updated', { agencyId, date, shift });
  res.json(formatRecord(updated));
  } catch(e) { next(e); }
});

// Inserção em massa — saldo inicial de todas as agências de uma vez
app.post('/api/records/bulk-initial', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { date, entries } = req.body;
    // entries: [{ agencyId, shift, initialBalance }, ...]
    if (!date || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'date e entries[] são obrigatórios' });
    }
    const now = new Date().toISOString();
    const results = [];
    const stmt = db.prepare(`UPDATE shift_records SET initial_balance = ?, opened_at = ?, opened_by = ? WHERE agency_id = ? AND date = ? AND shift = ?`);
    const sel  = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?');

    const bulkTx = db.transaction(() => {
      for (const e of entries) {
        const { agencyId, shift, initialBalance } = e;
        if (!agencyId || !shift || initialBalance === undefined || initialBalance === null || initialBalance === '') continue;
        getOrCreateRecord(agencyId, date, shift);
        stmt.run(Number(initialBalance), now, req.user.id, agencyId, date, shift);
        const updated = sel.get(agencyId, date, shift);
        if (updated) results.push(formatRecord(updated));
      }
    });
    bulkTx();
    broadcast('record_updated', { date, bulk: true });
    res.json({ ok: true, updated: results.length, records: results });
  } catch(e) { next(e); }
});

// Definir saldo inicial do agente
app.post('/api/records/set-agent-initial', authMiddleware, (req, res, next) => {
  try {
  const { agencyId, date, shift, agentInitialBalance } = req.body;
  // Agente só pode inserir na sua agência e turno
  if (req.user.role === 'agent') {
    if (req.user.agencyId !== agencyId || req.user.shift !== shift) {
      return res.status(403).json({ error: 'Não pode inserir dados de outra agência ou turno' });
    }
  }
  getOrCreateRecord(agencyId, date, shift);
  db.prepare(`UPDATE shift_records SET agent_initial_balance = ?, agent_opened_by = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
    .run(agentInitialBalance, req.user.id, agencyId, date, shift);
  const updated = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
  broadcast('record_updated', { agencyId, date, shift });
  res.json(formatRecord(updated));
  } catch(e) { next(e); }
});

// Fechar turno — agente insere saldo físico e valor deixado na agência
app.post('/api/records/close-agent', authMiddleware, (req, res, next) => {
  try {
  const { agencyId, date, shift, agentClosingBalance, leftInAgency, notes, tpaAmount } = req.body;
  if (req.user.role === 'agent') {
    if (req.user.agencyId !== agencyId || req.user.shift !== shift) {
      return res.status(403).json({ error: 'Não pode fechar outro turno' });
    }
  }
  getOrCreateRecord(agencyId, date, shift);
  const leftVal = (leftInAgency !== undefined && leftInAgency !== null && leftInAgency !== '') ? parseFloat(leftInAgency) : null;
  // TPA: apenas para agências P2 e P6 (Benguela)
  const tpaVal = (['p2', 'p6'].includes(agencyId) && tpaAmount !== undefined && tpaAmount !== null && tpaAmount !== '') ? parseFloat(tpaAmount) : 0;
  db.prepare(`UPDATE shift_records SET agent_closing_balance = ?, left_in_agency = ?, tpa_amount = ?, notes = ?, closed_at = ?, closed_by = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
    .run(agentClosingBalance, leftVal, tpaVal, notes || '', new Date().toISOString(), req.user.id, agencyId, date, shift);

  // ── Propagação automática da manhã para a tarde ──
  // Saldo Inicial Tarde = Deixado na Agência (manhã) + Bancário Manhã
  if (shift === 'morning' && leftVal !== null) {
    const morningRecord = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, 'morning');
    const bankMorning = morningRecord?.bank_balance ?? 0;
    const afternoonInitial = leftVal + bankMorning;
    getOrCreateRecord(agencyId, date, 'afternoon');
    db.prepare(`UPDATE shift_records SET initial_balance = ?, opened_by = ?, opened_at = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
      .run(afternoonInitial, 'auto_from_morning', new Date().toISOString(), agencyId, date, 'afternoon');
    broadcast('record_updated', { agencyId, date, shift: 'afternoon' });
  }

  const updated = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
  broadcast('record_updated', { agencyId, date, shift });
  res.json(formatRecord(updated));
  } catch(e) { next(e); }
});

// Confirmar saldo bancário (Gerência)
app.post('/api/records/confirm-bank', authMiddleware, managementOnly, (req, res, next) => {
  try {
  const { agencyId, date, shift, bankBalance } = req.body;
  if (!agencyId || !date || !shift || bankBalance === undefined) {
    return res.status(400).json({ error: 'Campos obrigatórios: agencyId, date, shift, bankBalance' });
  }
  getOrCreateRecord(agencyId, date, shift);
  db.prepare(`UPDATE shift_records SET bank_balance = ?, confirmed_at = ?, confirmed_by = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
    .run(bankBalance, new Date().toISOString(), req.user.id, agencyId, date, shift);
  const updated = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);

  // ── Propagação automática: bancário da manhã + deixado manhã → inicial da tarde ──
  if (shift === 'morning') {
    const morningRec = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, 'morning');
    const leftMorning = morningRec?.left_in_agency ?? 0;
    const afternoonInitial = bankBalance + leftMorning;
    getOrCreateRecord(agencyId, date, 'afternoon');
    db.prepare(`UPDATE shift_records SET initial_balance = ?, opened_by = ?, opened_at = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
      .run(afternoonInitial, 'auto_from_morning', new Date().toISOString(), agencyId, date, 'afternoon');
  }

  // ── Registar Gato automaticamente se diferença negativa ──
  // Após confirmar o bancário, verificar se há diferença negativa (dinheiro a faltar)
  const rec = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
  const fmt = formatRecord(rec);
  if (fmt.status !== 'pending' && fmt.difference !== null && fmt.difference < 0) {
    // Verificar se já existe um gato para este turno hoje
    const existingGato = db.prepare('SELECT id FROM gatos WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
    const agentUser = db.prepare('SELECT id FROM users WHERE agency_id = ? AND shift = ? AND role = ?').get(agencyId, shift === 'morning' ? 'morning' : 'afternoon', 'agent');
    const gatoExpected = fmt.expectedTotal !== null && fmt.expectedTotal !== undefined ? fmt.expectedTotal : 0;
    const gatoActual = fmt.actualTotal !== null && fmt.actualTotal !== undefined ? fmt.actualTotal : 0;
    const gatoDiff = fmt.difference !== null ? fmt.difference : 0;
    if (existingGato) {
      // Actualizar o gato existente
      db.prepare('UPDATE gatos SET expected_amount = ?, actual_amount = ?, difference = ?, auto_registered = 1 WHERE agency_id = ? AND date = ? AND shift = ?')
        .run(gatoExpected, gatoActual, gatoDiff, agencyId, date, shift);
    } else {
      // Criar novo gato
      db.prepare('INSERT INTO gatos (agency_id, user_id, date, shift, expected_amount, actual_amount, difference, auto_registered) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(agencyId, agentUser ? agentUser.id : null, date, shift, gatoExpected, gatoActual, gatoDiff);
    }
  } else if (fmt.difference !== null && fmt.difference >= 0) {
    // Se a diferença for zero ou positiva, remover gato se existia
    db.prepare('DELETE FROM gatos WHERE agency_id = ? AND date = ? AND shift = ?').run(agencyId, date, shift);
  }

  broadcast('record_updated', { agencyId, date, shift });
  res.json(formatRecord(updated));
  } catch(e) { next(e); }
});

// Registar movimento (informativo)
app.post('/api/records/movement', authMiddleware, (req, res) => {
  const { agencyId, date, shift, which, type, amount, notes } = req.body;
  if (!['first', 'last'].includes(which)) return res.status(400).json({ error: 'which deve ser first ou last' });
  getOrCreateRecord(agencyId, date, shift);
  const prefix = which === 'first' ? 'first' : 'last';
  db.prepare(`UPDATE shift_records SET ${prefix}_movement_type = ?, ${prefix}_movement_amount = ?, ${prefix}_movement_notes = ?, ${prefix}_movement_at = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
    .run(type, amount || null, notes || '', new Date().toISOString(), agencyId, date, shift);
  const updated = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
  broadcast('record_updated', { agencyId, date, shift });
  res.json(formatRecord(updated));
});

// ─── Rotas de Gatos ──────────────────────────────────────────────────────────

// Listar gatos (com filtros opcionais: date, month=YYYY-MM, agency_id)
app.get('/api/gatos', authMiddleware, managementOnly, (req, res) => {
  const { date, month, agency_id } = req.query;
  let query = `
    SELECT g.*, a.name as agency_name, a.code as agency_code, a.location as agency_location,
           u.name as agent_name, u.shift as agent_shift
    FROM gatos g
    LEFT JOIN agencies a ON g.agency_id = a.id
    LEFT JOIN users u ON g.user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (date) { query += ' AND g.date = ?'; params.push(date); }
  if (month) { query += ' AND g.date LIKE ?'; params.push(month + '%'); }
  if (agency_id) { query += ' AND g.agency_id = ?'; params.push(agency_id); }
  query += ' ORDER BY g.date DESC, a.code, g.shift';
  const gatos = db.prepare(query).all(...params);
  res.json(gatos);
});

// Resumo mensal de gatos por agência e por agente
app.get('/api/gatos/monthly/:month', authMiddleware, managementOnly, (req, res) => {
  const { month } = req.params; // formato: YYYY-MM
  
  // Total por agência
  const byAgency = db.prepare(`
    SELECT a.id, a.name, a.code, a.location,
           COUNT(*) as total_occurrences,
           SUM(ABS(g.difference)) as total_amount,
           MIN(g.difference) as worst_difference
    FROM gatos g
    LEFT JOIN agencies a ON g.agency_id = a.id
    WHERE g.date LIKE ?
    GROUP BY g.agency_id
    ORDER BY total_amount DESC
  `).all(month + '%');

  // Total por agente
  const byAgent = db.prepare(`
    SELECT u.id, u.name, u.shift, a.name as agency_name, a.code as agency_code,
           COUNT(*) as total_occurrences,
           SUM(ABS(g.difference)) as total_amount,
           MIN(g.difference) as worst_difference
    FROM gatos g
    LEFT JOIN users u ON g.user_id = u.id
    LEFT JOIN agencies a ON g.agency_id = a.id
    WHERE g.date LIKE ?
    GROUP BY g.user_id
    ORDER BY total_amount DESC
  `).all(month + '%');

  // Lista completa do mês
  const list = db.prepare(`
    SELECT g.*, a.name as agency_name, a.code as agency_code, a.location as agency_location,
           u.name as agent_name, u.shift as agent_shift
    FROM gatos g
    LEFT JOIN agencies a ON g.agency_id = a.id
    LEFT JOIN users u ON g.user_id = u.id
    WHERE g.date LIKE ?
    ORDER BY g.date DESC, a.code, g.shift
  `).all(month + '%');

  const totalAmount = list.reduce((sum, g) => sum + Math.abs(g.difference), 0);

  res.json({ month, byAgency, byAgent, list, totalAmount });
});

// Registar gato manualmente (nota adicional)
app.patch('/api/gatos/:id/note', authMiddleware, managementOnly, (req, res) => {
  const { note } = req.body;
  db.prepare('UPDATE gatos SET note = ? WHERE id = ?').run(note || '', req.params.id);
  const gato = db.prepare('SELECT * FROM gatos WHERE id = ?').get(req.params.id);
  res.json(gato);
});

// ─── Rotas de Validação Diária ────────────────────────────────────────────────

// Obter estado de validação de um dia
app.get('/api/daily-validation/:date', authMiddleware, managementOnly, (req, res) => {
  const { date } = req.params;
  const validation = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);
  res.json(validation || null);
});

// Listar todas as validações (histórico)
app.get('/api/daily-validations', authMiddleware, managementOnly, (req, res) => {
  const validations = db.prepare('SELECT * FROM daily_validations ORDER BY date DESC LIMIT 60').all();
  res.json(validations);
});

// Validar/fechar o dia
app.post('/api/daily-validation/:date', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { date } = req.params;
    const { notes } = req.body || {};

    // Verificar se já existe validação para este dia
    const existing = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);
    if (existing && !existing.unlocked_at) {
      return res.status(409).json({ error: 'Este dia já foi validado. Desbloqueie primeiro para re-validar.' });
    }

    // Calcular estatísticas do dia
    const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1').all();
    const records = db.prepare('SELECT * FROM shift_records WHERE date = ?').all(date);
    let ok = 0, warning = 0, medium = 0, alert = 0, pending = 0;
    let totalShifts = agencies.length * 2; // 2 turnos por agência
    for (const r of records) {
      const fmt = formatRecord(r);
      if (fmt.status === 'ok') ok++;
      else if (fmt.status === 'warning') warning++;
      else if (fmt.status === 'medium') medium++;
      else if (fmt.status === 'alert') alert++;
      else pending++;
    }
    // Turnos sem registo são pendentes
    pending += totalShifts - records.length;

    const now = new Date().toISOString();
    if (existing) {
      // Re-validar após desbloqueio
      db.prepare(`UPDATE daily_validations SET validated_at = ?, validated_by = ?, notes = ?,
        total_agencies = ?, ok_count = ?, warning_count = ?, medium_count = ?, alert_count = ?, pending_count = ?,
        unlocked_at = NULL, unlocked_by = NULL WHERE date = ?`)
        .run(now, req.user.id, notes || '', agencies.length, ok, warning, medium, alert, pending, date);
    } else {
      db.prepare(`INSERT INTO daily_validations (date, validated_at, validated_by, notes, total_agencies, ok_count, warning_count, medium_count, alert_count, pending_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(date, now, req.user.id, notes || '', agencies.length, ok, warning, medium, alert, pending);
    }
    const result = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);
    res.json(result);
  } catch(e) { next(e); }
});

// Desbloquear dia validado (para corrigir erros)
app.post('/api/daily-validation/:date/unlock', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { date } = req.params;
    const existing = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);
    if (!existing) return res.status(404).json({ error: 'Validação não encontrada para este dia' });
    db.prepare('UPDATE daily_validations SET unlocked_at = ?, unlocked_by = ? WHERE date = ?')
      .run(new Date().toISOString(), req.user.id, date);
    const result = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);
    res.json(result);
  } catch(e) { next(e); }
});

// Resumo do dia
app.get('/api/records/summary/:date', authMiddleware, managementOnly, (req, res) => {
  const { date } = req.params;
  let agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 ORDER BY name').all();
  const records = db.prepare('SELECT * FROM shift_records WHERE date = ?').all(date);

  const summary = agencies.map(agency => {
    const morning = records.find(r => r.agency_id === agency.id && r.shift === 'morning') || null;
    const afternoon = records.find(r => r.agency_id === agency.id && r.shift === 'afternoon') || null;
    return {
      agency,
      morning: morning ? formatRecord(morning) : null,
      afternoon: afternoon ? formatRecord(afternoon) : null,
    };
  });

  // Agrupar por zona
  const zones = {};
  for (const item of summary) {
    const zone = item.agency.location || 'Sem Zona';
    if (!zones[zone]) zones[zone] = [];
    zones[zone].push(item);
  }

  res.json({ date, summary, zones });
});

// ─── Rotas: Ranking de Rendimento ───────────────────────────────────────────
// GET /api/ranking/daily/:date  → ranking das agências por rendimento no dia
// GET /api/ranking/alltime      → ranking histórico acumulado
app.get('/api/ranking/daily/:date', authMiddleware, (req, res, next) => {
  try {
    const { date } = req.params;
    const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1').all();
    const records = db.prepare(
      'SELECT * FROM shift_records WHERE date = ?'
    ).all(date);

    // Agrupar registos por agência
    const byAgency = {};
    for (const r of records) {
      if (!byAgency[r.agency_id]) byAgency[r.agency_id] = [];
      byAgency[r.agency_id].push(r);
    }

    const ranking = agencies.map(ag => {
      const recs = byAgency[ag.id] || [];
      // Rendimento = soma dos saldos físicos fechados (agent_closing_balance)
      let totalClosing = 0;
      let totalInitial = 0;
      let hasData = false;
      for (const r of recs) {
        if (r.agent_closing_balance !== null) {
          totalClosing += r.agent_closing_balance;
          hasData = true;
        }
        if (r.initial_balance !== null) {
          totalInitial += r.initial_balance;
        }
        if (r.agent_initial_balance !== null) {
          totalInitial += r.agent_initial_balance;
        }
      }
      const rendimento = hasData ? totalClosing : null;
      return {
        agencyId: ag.id,
        agencyName: ag.name,
        agencyCode: ag.code,
        agencyColor: ag.color,
        location: ag.location,
        rendimento,
        totalClosing: hasData ? totalClosing : null,
        totalInitial: hasData ? totalInitial : null,
        shiftsCount: recs.length,
      };
    });

    // Ordenar: agências com dados primeiro (por rendimento desc), depois sem dados
    ranking.sort((a, b) => {
      if (a.rendimento === null && b.rendimento === null) return 0;
      if (a.rendimento === null) return 1;
      if (b.rendimento === null) return -1;
      return b.rendimento - a.rendimento;
    });

    res.json({ date, ranking });
  } catch (e) { next(e); }
});

app.get('/api/ranking/alltime', authMiddleware, (req, res, next) => {
  try {
    const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1').all();

    // Calcular rendimento acumulado: soma de (closing - initial) por agência
    const rows = db.prepare(`
      SELECT
        agency_id,
        SUM(COALESCE(agent_closing_balance, 0)) as total_closing,
        SUM(COALESCE(initial_balance, 0) + COALESCE(agent_initial_balance, 0)) as total_initial,
        COUNT(*) as total_shifts,
        COUNT(DISTINCT date) as total_days,
        MAX(date) as last_date
      FROM shift_records
      WHERE agent_closing_balance IS NOT NULL
      GROUP BY agency_id
    `).all();

    const dataMap = {};
    for (const r of rows) {
      dataMap[r.agency_id] = r;
    }

    const ranking = agencies.map(ag => {
      const d = dataMap[ag.id];
      const rendimento = d ? d.total_closing : null;
      return {
        agencyId: ag.id,
        agencyName: ag.name,
        agencyCode: ag.code,
        agencyColor: ag.color,
        location: ag.location,
        rendimento,
        totalClosing: d ? d.total_closing : null,
        totalInitial: d ? d.total_initial : null,
        totalShifts: d ? d.total_shifts : 0,
        totalDays: d ? d.total_days : 0,
        lastDate: d ? d.last_date : null,
      };
    });

    ranking.sort((a, b) => {
      if (a.rendimento === null && b.rendimento === null) return 0;
      if (a.rendimento === null) return 1;
      if (b.rendimento === null) return -1;
      return b.rendimento - a.rendimento;
    });

    res.json({ ranking });
  } catch (e) { next(e); }
});

// ─── Edição de Registos Históricos pelo Gerente ────────────────────────────────
// PUT /api/records/edit  → editar qualquer campo de um registo de dia anterior
// Bloqueado se o dia estiver validado (daily_validations.unlocked_at IS NULL e validated_at IS NOT NULL)
app.put('/api/records/edit', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { agencyId, date, shift, field, value } = req.body;
    if (!agencyId || !date || !shift || !field) {
      return res.status(400).json({ error: 'Campos obrigatórios: agencyId, date, shift, field' });
    }

    // Verificar se o dia está validado e bloqueado
    const validation = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);
    if (validation && validation.validated_at && !validation.unlocked_at) {
      return res.status(403).json({ error: 'Este dia está validado e bloqueado. Não é possível editar.' });
    }

    // Campos permitidos para edição
    const allowedFields = {
      initial_balance: 'initial_balance',
      agent_initial_balance: 'agent_initial_balance',
      agent_closing_balance: 'agent_closing_balance',
      bank_balance: 'bank_balance',
      tpa_amount: 'tpa_amount',
      notes: 'notes',
    };
    if (!allowedFields[field]) {
      return res.status(400).json({ error: 'Campo não permitido para edição: ' + field });
    }

    // Garantir que o registo existe
    getOrCreateRecord(agencyId, date, shift);

    // Actualizar o campo
    const col = allowedFields[field];
    db.prepare(`UPDATE shift_records SET ${col} = ?, edited_at = ?, edited_by = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
      .run(value === '' ? null : value, new Date().toISOString(), req.user.id, agencyId, date, shift);

    // Se editou o bancário da manhã, propagar para inicial da tarde
    if (field === 'bank_balance' && shift === 'morning' && value !== '' && value !== null) {
      getOrCreateRecord(agencyId, date, 'afternoon');
      db.prepare(`UPDATE shift_records SET initial_balance = ?, opened_by = ?, opened_at = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
        .run(value, 'auto_from_morning_edit', new Date().toISOString(), agencyId, date, 'afternoon');
    }

    const updated = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
    broadcast('record_updated', { agencyId, date, shift });
    res.json(formatRecord(updated));
  } catch(e) { next(e); }
});

// GET /api/records/date/:date  → obter todos os registos de um dia específico
app.get('/api/records/date/:date', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { date } = req.params;
    const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 ORDER BY name').all();
    const records = db.prepare('SELECT * FROM shift_records WHERE date = ?').all(date);
    const validation = db.prepare('SELECT * FROM daily_validations WHERE date = ?').get(date);

    const isLocked = !!(validation && validation.validated_at && !validation.unlocked_at);

    const data = agencies.map(ag => {
      const morning = records.find(r => r.agency_id === ag.id && r.shift === 'morning') || null;
      const afternoon = records.find(r => r.agency_id === ag.id && r.shift === 'afternoon') || null;
      return {
        agency: ag,
        morning: morning ? formatRecord(morning) : null,
        afternoon: afternoon ? formatRecord(afternoon) : null,
      };
    });

    res.json({ date, data, validation: validation || null, isLocked });
  } catch(e) { next(e); }
});

// ─── Calendário Bancário ──────────────────────────────────────────────────────
// Regras de depósito:
//  - Seg a Qui (manhã+tarde) → dia seguinte (1 slot: 'all')
//  - Quinta (manhã+tarde) → sexta (slot: 'morning_thu')
//  - Sexta manhã → sexta às 12h (slot: 'noon_fri')
//  - Sexta tarde + Sábado + Feriados → segunda-feira (slot: 'monday')

// Lista de feriados angolanos (formato MM-DD, anuais)
const ANGOLA_HOLIDAYS = [
  '01-01', // Ano Novo
  '02-04', // Dia da Libertação
  '03-08', // Dia da Mulher
  '04-04', // Dia da Paz
  '05-01', // Dia do Trabalho
  '06-01', // Dia da Criança
  '09-17', // Dia do Herói Nacional
  '11-02', // Dia dos Finados
  '11-11', // Dia da Independência
  '12-25', // Natal
];

function isHoliday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const mmdd = dateStr.slice(5); // MM-DD
  return ANGOLA_HOLIDAYS.includes(mmdd);
}

function isWeekendOrHoliday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const dow = d.getDay(); // 0=Dom, 6=Sáb
  return dow === 0 || dow === 6 || isHoliday(dateStr);
}

function nextBankingDay(dateStr) {
  let d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  while (isWeekendOrHoliday(d.toISOString().split('T')[0])) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split('T')[0];
}

function nextMonday(dateStr) {
  let d = new Date(dateStr + 'T12:00:00');
  // Avançar até segunda-feira
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== 1);
  // Se segunda for feriado, avançar mais
  while (isHoliday(d.toISOString().split('T')[0])) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split('T')[0];
}

// Calcula os slots de depósito para um dado dia de origem
// Retorna array de: { sourceShift, depositDate, depositSlot, label }
function calcDepositSlots(sourceDateStr) {
  const d = new Date(sourceDateStr + 'T12:00:00');
  const dow = d.getDay(); // 0=Dom, 1=Seg, ..., 5=Sex, 6=Sáb
  const isHol = isHoliday(sourceDateStr);
  const slots = [];

  if (isHol || dow === 0 || dow === 6) {
    // Feriado ou fim de semana → tudo para segunda
    const mon = nextMonday(sourceDateStr);
    slots.push({ sourceShift: 'morning',   depositDate: mon, depositSlot: 'monday', label: 'Seg-feira (manhã)' });
    slots.push({ sourceShift: 'afternoon', depositDate: mon, depositSlot: 'monday', label: 'Seg-feira (tarde)' });
  } else if (dow === 4) {
    // Quinta-feira → manhã+tarde depositam na sexta (1.º depósito)
    const fri = nextBankingDay(sourceDateStr);
    slots.push({ sourceShift: 'morning',   depositDate: fri, depositSlot: 'morning_thu', label: 'Sexta (1.º dep.)' });
    slots.push({ sourceShift: 'afternoon', depositDate: fri, depositSlot: 'morning_thu', label: 'Sexta (1.º dep.)' });
  } else if (dow === 5) {
    // Sexta-feira:
    //   manhã → sexta às 12h (2.º depósito)
    //   tarde → segunda
    const mon = nextMonday(sourceDateStr);
    slots.push({ sourceShift: 'morning',   depositDate: sourceDateStr, depositSlot: 'noon_fri', label: 'Sexta 12h (2.º dep.)' });
    slots.push({ sourceShift: 'afternoon', depositDate: mon,           depositSlot: 'monday',   label: 'Seg-feira (tarde sex.)' });
  } else {
    // Seg a Qui (normal) → dia seguinte
    const next = nextBankingDay(sourceDateStr);
    slots.push({ sourceShift: 'morning',   depositDate: next, depositSlot: 'next_day', label: 'Dia seguinte (manhã)' });
    slots.push({ sourceShift: 'afternoon', depositDate: next, depositSlot: 'next_day', label: 'Dia seguinte (tarde)' });
  }
  return slots;
}

// ─── Rota: Contabilidade dos Depósitos ──────────────────────────────────────
// GET /api/records/deposits/:date → saldos físicos de fecho por agência com slots de depósito
app.get('/api/records/deposits/:date', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { date } = req.params;
    const agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 ORDER BY name').all();
    const records = db.prepare('SELECT * FROM shift_records WHERE date = ?').all(date);

    // Calcular os slots de depósito para este dia
    const slots = calcDepositSlots(date);
    const morningSlot = slots.find(s => s.sourceShift === 'morning');
    const afternoonSlot = slots.find(s => s.sourceShift === 'afternoon');

    let grandTotal = 0;
    const agencyData = agencies.map(ag => {
      const morning = records.find(r => r.agency_id === ag.id && r.shift === 'morning') || null;
      const afternoon = records.find(r => r.agency_id === ag.id && r.shift === 'afternoon') || null;

      const morningPhysical = morning?.agent_closing_balance ?? null;
      const afternoonPhysical = afternoon?.agent_closing_balance ?? null;

      // Agentes
      const morningAgent = db.prepare('SELECT name FROM users WHERE agency_id = ? AND shift = ? AND role = ? AND is_active = 1').get(ag.id, 'morning', 'agent');
      const afternoonAgent = db.prepare('SELECT name FROM users WHERE agency_id = ? AND shift = ? AND role = ? AND is_active = 1').get(ag.id, 'afternoon', 'agent');

      // Confirmações de depósito existentes
      const morningConf = db.prepare('SELECT * FROM deposit_confirmations WHERE source_date = ? AND source_shift = ? AND agency_id = ?').get(date, 'morning', ag.id);
      const afternoonConf = db.prepare('SELECT * FROM deposit_confirmations WHERE source_date = ? AND source_shift = ? AND agency_id = ?').get(date, 'afternoon', ag.id);

      // Total a depositar = soma dos físicos disponíveis
      const total = (morningPhysical !== null ? morningPhysical : 0) + (afternoonPhysical !== null ? afternoonPhysical : 0);
      const hasAnyData = morningPhysical !== null || afternoonPhysical !== null;
      if (hasAnyData) grandTotal += total;

      return {
        agency: ag,
        morningPhysical,
        afternoonPhysical,
        morningAgentName: morningAgent?.name || null,
        afternoonAgentName: afternoonAgent?.name || null,
        total: hasAnyData ? total : null,
        morningStatus: morning ? formatRecord(morning).status : 'pending',
        afternoonStatus: afternoon ? formatRecord(afternoon).status : 'pending',
        morningDepositDate: morningSlot?.depositDate || null,
        afternoonDepositDate: afternoonSlot?.depositDate || null,
        morningDepositSlot: morningSlot?.depositSlot || null,
        afternoonDepositSlot: afternoonSlot?.depositSlot || null,
        morningDepositLabel: morningSlot?.label || null,
        afternoonDepositLabel: afternoonSlot?.label || null,
        morningConfirmation: morningConf || null,
        afternoonConfirmation: afternoonConf || null,
      };
    });

    // Info do calendário para o cabeçalho
    const depositInfo = {
      morningDepositDate: morningSlot?.depositDate || null,
      morningDepositLabel: morningSlot?.label || null,
      afternoonDepositDate: afternoonSlot?.depositDate || null,
      afternoonDepositLabel: afternoonSlot?.label || null,
      sameDay: morningSlot?.depositDate === afternoonSlot?.depositDate,
    };

    res.json({ date, agencies: agencyData, grandTotal, depositInfo });
  } catch(e) { next(e); }
});

// POST /api/records/deposits/confirm → confirmar depósito de um turno de uma agência
app.post('/api/records/deposits/confirm', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const { sourceDate, sourceShift, agencyId, confirmedAmount, notes } = req.body;
    if (!sourceDate || !sourceShift || !agencyId || confirmedAmount === undefined) {
      return res.status(400).json({ error: 'Campos obrigatórios em falta' });
    }

    // Buscar o valor esperado (físico declarado pelo agente)
    const record = db.prepare('SELECT agent_closing_balance FROM shift_records WHERE date = ? AND shift = ? AND agency_id = ?').get(sourceDate, sourceShift, agencyId);
    const expectedAmount = record?.agent_closing_balance ?? 0;
    const difference = confirmedAmount - expectedAmount;

    // Calcular data e slot de depósito
    const slots = calcDepositSlots(sourceDate);
    const slot = slots.find(s => s.sourceShift === sourceShift);

    const existing = db.prepare('SELECT id FROM deposit_confirmations WHERE source_date = ? AND source_shift = ? AND agency_id = ?').get(sourceDate, sourceShift, agencyId);
    if (existing) {
      db.prepare('UPDATE deposit_confirmations SET confirmed_amount = ?, difference = ?, confirmed_by = ?, confirmed_at = ?, notes = ? WHERE id = ?')
        .run(confirmedAmount, difference, req.user.id, new Date().toISOString(), notes || '', existing.id);
    } else {
      db.prepare('INSERT INTO deposit_confirmations (source_date, source_shift, deposit_date, deposit_slot, agency_id, expected_amount, confirmed_amount, difference, confirmed_by, confirmed_at, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sourceDate, sourceShift, slot?.depositDate || nextBankingDay(sourceDate), slot?.depositSlot || 'next_day', agencyId, expectedAmount, confirmedAmount, difference, req.user.id, new Date().toISOString(), notes || '');
    }

    broadcast('deposit_confirmed', { sourceDate, sourceShift, agencyId });
    const conf = db.prepare('SELECT * FROM deposit_confirmations WHERE source_date = ? AND source_shift = ? AND agency_id = ?').get(sourceDate, sourceShift, agencyId);
    res.json(conf);
  } catch(e) { next(e); }
});

// ─── Rotas: Aba Contas (Contabilistas) ───────────────────────────────────────────────────────────────

// GET /api/accounts/:date — dados de contas para o dia (Gerência ou Contabilista)
app.get('/api/accounts/:date', authMiddleware, managementOrAccountant, (req, res, next) => {
  try {
    const { date } = req.params;
    const user = req.user;

    // Filtrar agências pela zona do contabilista
    let agencies;
    if (user.role === 'accountant' && user.zone) {
      agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 AND location = ? ORDER BY name').all(user.zone);
    } else {
      agencies = db.prepare('SELECT * FROM agencies WHERE is_active = 1 ORDER BY name').all();
    }
    const agencyIds = agencies.map(a => a.id);
    if (agencyIds.length === 0) return res.json({ date, agencies: [] });

    const placeholders = agencyIds.map(() => '?').join(',');
    const records = db.prepare(`SELECT * FROM shift_records WHERE date = ? AND agency_id IN (${placeholders})`).all(date, ...agencyIds);
    const validations = db.prepare(`SELECT * FROM account_validations WHERE date = ? AND agency_id IN (${placeholders})`).all(date, ...agencyIds);

    const result = agencies.map(ag => {
      const morning = records.find(r => r.agency_id === ag.id && r.shift === 'morning') || null;
      const afternoon = records.find(r => r.agency_id === ag.id && r.shift === 'afternoon') || null;
      const mVal = morning ? formatRecord(morning) : null;
      const aVal = afternoon ? formatRecord(afternoon) : null;

      // Agentes
      const morningAgent = db.prepare('SELECT id, name FROM users WHERE agency_id = ? AND shift = ? AND role = ? AND is_active = 1').get(ag.id, 'morning', 'agent');
      const afternoonAgent = db.prepare('SELECT id, name FROM users WHERE agency_id = ? AND shift = ? AND role = ? AND is_active = 1').get(ag.id, 'afternoon', 'agent');

      // Validações existentes
      const mValidation = validations.find(v => v.agency_id === ag.id && v.shift === 'morning') || null;
      const aValidation = validations.find(v => v.agency_id === ag.id && v.shift === 'afternoon') || null;

      return {
        agency: ag,
        morning: mVal,
        afternoon: aVal,
        morningAgent,
        afternoonAgent,
        morningValidation: mValidation,
        afternoonValidation: aValidation,
      };
    });

    res.json({ date, agencies: result });
  } catch(e) { next(e); }
});

// POST /api/accounts/validate — contabilista valida um turno
app.post('/api/accounts/validate', authMiddleware, managementOrAccountant, (req, res, next) => {
  try {
    const { agencyId, date, shift, countedAmount, notes } = req.body;
    if (!agencyId || !date || !shift || countedAmount === undefined) {
      return res.status(400).json({ error: 'Campos obrigatórios: agencyId, date, shift, countedAmount' });
    }

    // Verificar que o contabilista tem acesso a esta agência
    if (req.user.role === 'accountant') {
      const agency = db.prepare('SELECT location FROM agencies WHERE id = ?').get(agencyId);
      if (!agency || agency.location !== req.user.zone) {
        return res.status(403).json({ error: 'Sem acesso a esta agência' });
      }
    }

    // Obter o registo do turno para calcular o valor declarado
    const record = db.prepare('SELECT * FROM shift_records WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
    const declaredAmount = record?.agent_closing_balance ?? null;
    const counted = parseFloat(countedAmount);
    const gatoMoney = (declaredAmount !== null) ? (counted - declaredAmount) : 0;

    // Inserir ou actualizar a validação
    const existing = db.prepare('SELECT id FROM account_validations WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
    if (existing) {
      db.prepare(`UPDATE account_validations SET counted_amount = ?, declared_amount = ?, gato_money = ?, notes = ?, validated_by = ?, validated_at = ? WHERE agency_id = ? AND date = ? AND shift = ?`)
        .run(counted, declaredAmount, gatoMoney, notes || '', req.user.id, new Date().toISOString(), agencyId, date, shift);
    } else {
      db.prepare(`INSERT INTO account_validations (agency_id, date, shift, validated_by, counted_amount, declared_amount, gato_money, notes, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(agencyId, date, shift, req.user.id, counted, declaredAmount, gatoMoney, notes || '', new Date().toISOString());
    }

    // Se houver diferença (positiva ou negativa), registar na tabela gatos como "Gato Conta"
    const agentUser = db.prepare('SELECT id FROM users WHERE agency_id = ? AND shift = ? AND role = ? AND is_active = 1').get(agencyId, shift === 'morning' ? 'morning' : 'afternoon', 'agent');
    const existingGatoConta = db.prepare("SELECT id FROM gatos WHERE agency_id = ? AND date = ? AND shift = ? AND note LIKE 'Gato Conta%'").get(agencyId, date, shift);
    if (gatoMoney !== 0) {
      const gatoNote = notes ? `Gato Conta: ${notes}` : 'Gato Conta';
      if (existingGatoConta) {
        db.prepare('UPDATE gatos SET expected_amount = ?, actual_amount = ?, difference = ?, note = ?, auto_registered = 0 WHERE id = ?')
          .run(declaredAmount ?? 0, counted, gatoMoney, gatoNote, existingGatoConta.id);
      } else {
        db.prepare('INSERT INTO gatos (agency_id, user_id, date, shift, expected_amount, actual_amount, difference, note, auto_registered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)')
          .run(agencyId, agentUser?.id || null, date, shift, declaredAmount ?? 0, counted, gatoMoney, gatoNote);
      }
    } else {
      // Diferença zero: remover gato conta se existia
      if (existingGatoConta) {
        db.prepare('DELETE FROM gatos WHERE id = ?').run(existingGatoConta.id);
      }
    }

    broadcast('account_validated', { agencyId, date, shift });
    const val = db.prepare('SELECT * FROM account_validations WHERE agency_id = ? AND date = ? AND shift = ?').get(agencyId, date, shift);
    res.json(val);
  } catch(e) { next(e); }
});

// DELETE /api/accounts/validate — remover validação (Gerência ou próprio contabilista)
app.delete('/api/accounts/validate', authMiddleware, managementOrAccountant, (req, res, next) => {
  try {
    const { agencyId, date, shift } = req.body;
    db.prepare('DELETE FROM account_validations WHERE agency_id = ? AND date = ? AND shift = ?').run(agencyId, date, shift);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// ─── Backup / Exportação de Dados ────────────────────────────────────────────
// GET /api/backup/export — exportar todos os dados em JSON (apenas Gerência)
app.get('/api/backup/export', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const agencies = db.prepare('SELECT * FROM agencies').all();
    const users = db.prepare('SELECT id, name, role, agency_id, zone, shift, is_active, created_at FROM users').all();
    const records = db.prepare('SELECT * FROM shift_records ORDER BY date DESC, agency_id, shift').all();
    const gatos = db.prepare('SELECT * FROM gatos ORDER BY date DESC').all();
    const accountValidations = db.prepare('SELECT * FROM account_validations ORDER BY date DESC').all();
    const depositConfirmations = db.prepare('SELECT * FROM deposit_confirmations ORDER BY deposit_date DESC').all();
    const dailyValidations = db.prepare('SELECT * FROM daily_validations ORDER BY date DESC').all();
    const backup = {
      version: '1.0',
      exported_at: new Date().toISOString(),
      agencies,
      users,
      shift_records: records,
      gatos,
      account_validations: accountValidations,
      deposit_confirmations: depositConfirmations,
      daily_validations: dailyValidations,
    };
    const filename = `pazmar-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(backup);
  } catch(e) { next(e); }
});

// GET /api/backup/export-csv — exportar registos em CSV para Excel (apenas Gerência)
app.get('/api/backup/export-csv', authMiddleware, managementOnly, (req, res, next) => {
  try {
    const records = db.prepare(`
      SELECT sr.*, a.name as agency_name
      FROM shift_records sr
      LEFT JOIN agencies a ON sr.agency_id = a.id
      ORDER BY sr.date DESC, sr.agency_id, sr.shift
    `).all();
    const gatos = db.prepare(`
      SELECT g.*, a.name as agency_name, u.name as user_name
      FROM gatos g
      LEFT JOIN agencies a ON g.agency_id = a.id
      LEFT JOIN users u ON g.user_id = u.id
      ORDER BY g.date DESC
    `).all();
    const deposits = db.prepare(`
      SELECT dc.*, a.name as agency_name, u.name as confirmed_by_name
      FROM deposit_confirmations dc
      LEFT JOIN agencies a ON dc.agency_id = a.id
      LEFT JOIN users u ON dc.confirmed_by = u.id
      ORDER BY dc.deposit_date DESC
    `).all();
    const csvHeaders = ['Data','Agência','Turno','Inicial Gerência','Inicial Agente','Físico Fecho','TPA','Bancário','Deixado Agência','A Depositar','Diferença','Estado','Notas'];
    const csvRows = records.map(r => [
      r.date,
      r.agency_name || r.agency_id,
      r.shift === 'morning' ? 'Manhã' : 'Tarde',
      r.initial_balance ?? '',
      r.agent_initial_balance ?? '',
      r.agent_closing_balance ?? '',
      r.tpa_amount ?? 0,
      r.bank_balance ?? '',
      r.left_in_agency ?? '',
      r.to_deposit ?? '',
      r.difference ?? '',
      r.status || '',
      (r.notes || '').replace(/,/g, ';'),
    ]);
    const gatoHeaders = ['Data','Agência','Turno','Esperado','Real','Diferença','Nota','Auto','Criado em'];
    const gatoRows = gatos.map(g => [
      g.date, g.agency_name || g.agency_id,
      g.shift === 'morning' ? 'Manhã' : 'Tarde',
      g.expected_amount, g.actual_amount, g.difference,
      (g.note || '').replace(/,/g, ';'),
      g.auto_registered ? 'Sim' : 'Não',
      g.created_at || '',
    ]);
    const depHeaders = ['Data Origem','Turno','Data Depósito','Agência','Esperado','Confirmado','Diferença','Confirmado por','Notas'];
    const depRows = deposits.map(d => [
      d.source_date,
      d.source_shift === 'morning' ? 'Manhã' : (d.source_shift === 'afternoon' ? 'Tarde' : 'Todos'),
      d.deposit_date, d.agency_name || d.agency_id,
      d.expected_amount, d.confirmed_amount ?? '',
      d.difference ?? '', d.confirmed_by_name || '',
      (d.notes || '').replace(/,/g, ';'),
    ]);
    const toCSV = (headers, rows) => [headers, ...rows].map(r => r.join(',')).join('\n');
    const fullCSV = `=== REGISTOS DE TURNOS ===\n${toCSV(csvHeaders, csvRows)}\n\n=== GATOS ===\n${toCSV(gatoHeaders, gatoRows)}\n\n=== DEPÓSITOS ===\n${toCSV(depHeaders, depRows)}`;
    const filename = `pazmar-dados-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + fullCSV);
  } catch(e) { next(e); }
});

// ─── Error Handler Global (deve vir antes do wildcard) ──────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Erro interno do servidor' });
});

// ─── Servir o frontend ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`🚀 Pazmar Balance Server a correr em http://localhost:${PORT}`);
});
