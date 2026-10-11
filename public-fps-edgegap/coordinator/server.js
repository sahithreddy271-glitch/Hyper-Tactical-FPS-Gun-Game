'use strict';
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const required = ['DATABASE_URL', 'JWT_SECRET', 'SERVER_REGISTER_TOKEN'];
for (const key of required) if (!process.env[key]) { console.error(`Missing env var ${key}`); process.exit(1); }
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } });
app.set('trust proxy', 1);
app.use(cors({ origin: (process.env.CORS_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean), methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '32kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, username VARCHAR(20) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0), level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rooms (
    room_id VARCHAR(100) PRIMARY KEY, server_address TEXT NOT NULL, server_port INTEGER NOT NULL,
    room_name VARCHAR(60) NOT NULL, map_id VARCHAR(60) NOT NULL, players INTEGER NOT NULL DEFAULT 0,
    max_players INTEGER NOT NULL DEFAULT 8, status VARCHAR(20) NOT NULL DEFAULT 'waiting',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
function makeToken(user) { return jwt.sign({ sub: String(user.id), username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d', issuer: 'tactical-fps' }); }
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { if (!token) throw new Error('missing'); req.user = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'tactical-fps' }); next(); }
  catch { res.status(401).json({ error: 'Authentication required' }); }
}
function serverAuth(req, res, next) {
  if (req.headers['x-server-token'] !== process.env.SERVER_REGISTER_TOKEN) return res.status(401).json({ error: 'Invalid server token' });
  next();
}
app.get('/health', (_req, res) => res.json({ ok: true, service: 'tactical-fps-coordinator' }));
app.post('/api/auth/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim(); const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 characters: letters, numbers, underscore.' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be 10–128 characters.' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query('INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username,xp,level', [username, hash]);
    const user = result.rows[0]; res.status(201).json({ token: makeToken(user), user });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' }); console.error(e); res.status(500).json({ error: 'Could not register account' }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim(); const password = String(req.body.password || '');
    const result = await pool.query('SELECT id,username,password_hash,xp,level FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    const user = result.rows[0]; if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid username or password' });
    res.json({ token: makeToken(user), user: { id: user.id, username: user.username, xp: user.xp, level: user.level } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not log in' }); }
});
app.get('/api/me', auth, async (req, res) => {
  try { const r = await pool.query('SELECT id,username,xp,level,created_at FROM users WHERE id=$1', [req.user.sub]); if (!r.rowCount) return res.status(404).json({ error: 'User not found' }); res.json({ user: r.rows[0] }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load profile' }); }
});
app.get('/api/rooms', async (_req, res) => {
  try {
    await pool.query("DELETE FROM rooms WHERE updated_at < NOW() - INTERVAL '30 seconds'");
    const r = await pool.query("SELECT room_id,room_name,map_id,players,max_players,status,server_address,server_port FROM rooms WHERE status IN ('waiting','playing') AND players < max_players ORDER BY players ASC, updated_at DESC");
    res.json({ rooms: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load public rooms' }); }
});
app.post('/api/servers/register', serverAuth, async (req, res) => {
  try {
    const b = req.body || {}; const roomId = String(b.roomId || ''); const address = String(b.address || ''); const port = Number(b.port);
    const roomName = String(b.roomName || 'Public Match').slice(0,60); const mapId = String(b.mapId || 'nostalgia').slice(0,60);
    const players = Number(b.players || 0); const maxPlayers = Math.min(8, Math.max(1, Number(b.maxPlayers || 8)));
    const status = b.status === 'playing' ? 'playing' : 'waiting';
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(roomId) || !address || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(players) || players < 0 || players > maxPlayers) return res.status(400).json({ error: 'Invalid room registration' });
    await pool.query(`INSERT INTO rooms(room_id,server_address,server_port,room_name,map_id,players,max_players,status,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT(room_id) DO UPDATE SET server_address=EXCLUDED.server_address,server_port=EXCLUDED.server_port,room_name=EXCLUDED.room_name,map_id=EXCLUDED.map_id,players=EXCLUDED.players,max_players=EXCLUDED.max_players,status=EXCLUDED.status,updated_at=NOW()`, [roomId,address,port,roomName,mapId,players,maxPlayers,status]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not register room' }); }
});
// Development placeholder only: production XP must be granted from verified server match results.
app.post('/api/progression/xp', auth, async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > 100) return res.status(400).json({ error: 'Invalid XP amount' });
  try { const r = await pool.query('UPDATE users SET xp=xp+$1, level=1+FLOOR((xp+$1)/100)::int WHERE id=$2 RETURNING id,username,xp,level', [amount, req.user.sub]); res.json({ user: r.rows[0] }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not update progression' }); }
});
const port = Number(process.env.PORT || 8081);
init().then(() => app.listen(port, '0.0.0.0', () => console.log(`Coordinator listening on ${port}`))).catch(e => { console.error('Startup failed', e); process.exit(1); });
