'use strict';
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const PORT = Number(process.env.PORT || 8080);
const MAX_PLAYERS = Math.min(8, Math.max(1, Number(process.env.MAX_PLAYERS || 8)));
const ROOM_ID = process.env.ROOM_ID || `room-${crypto.randomBytes(5).toString('hex')}`;
const COORDINATOR_URL = process.env.COORDINATOR_URL;
const REGISTER_TOKEN = process.env.SERVER_REGISTER_TOKEN;
const ADDRESS = process.env.PUBLIC_SERVER_ADDRESS || '';
const PUBLIC_PORT = Number(process.env.PUBLIC_SERVER_PORT || PORT);
const players = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true, roomId:ROOM_ID, players:players.size, maxPlayers:MAX_PLAYERS})); }
  res.writeHead(404); res.end('not found');
});
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });
function send(ws, data) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function snapshot() { return { type:'snapshot', players:[...players.values()].map(p => ({id:p.id, username:p.username, x:p.x, y:p.y, z:p.z, yaw:p.yaw, pitch:p.pitch})) }; }
function broadcast(data, except) { const text = JSON.stringify(data); for (const client of wss.clients) if (client !== except && client.readyState === WebSocket.OPEN) client.send(text); }
wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { send(ws, {type:'error', message:'Room full'}); ws.close(1008, 'Room full'); return; }
  const id = crypto.randomUUID();
  const p = {id, username:`Guest-${id.slice(0,4)}`, x:0, y:1.7, z:0, yaw:0, pitch:0};
  players.set(id,p); ws.playerId = id;
  send(ws,{type:'welcome', playerId:id, roomId:ROOM_ID, maxPlayers:MAX_PLAYERS});
  send(ws,snapshot()); broadcast({type:'playerJoined', player:{...p}},ws);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const player = players.get(id); if (!player) return;
    if (m.type === 'hello' && typeof m.username === 'string') player.username = m.username.replace(/[^a-zA-Z0-9_ -]/g,'').slice(0,20) || player.username;
    // Temporary movement relay only. Production must validate speed, collisions and actions server-side.
    if (m.type === 'move') {
      for (const k of ['x','y','z','yaw','pitch']) if (!Number.isFinite(m[k])) return;
      if (Math.abs(m.x)>500 || Math.abs(m.y)>100 || Math.abs(m.z)>500 || Math.abs(m.yaw)>1000 || Math.abs(m.pitch)>1000) return;
      Object.assign(player,{x:m.x,y:m.y,z:m.z,yaw:m.yaw,pitch:m.pitch});
      broadcast({type:'playerMoved', player:{...player}},ws);
    }
    if (m.type === 'ping') send(ws,{type:'pong',at:Date.now()});
  });
  ws.on('close', () => { const old = players.get(id); players.delete(id); if (old) broadcast({type:'playerLeft', playerId:id}); });
  ws.on('error', () => {});
});
async function registerRoom() {
  if (!COORDINATOR_URL || !REGISTER_TOKEN || !ADDRESS) return;
  const payload = {roomId:ROOM_ID,address:ADDRESS,port:PUBLIC_PORT,roomName:process.env.ROOM_NAME||'Public Match',mapId:process.env.MAP_ID||'nostalgia',players:players.size,maxPlayers:MAX_PLAYERS,status:players.size ? 'playing':'waiting'};
  try { const r = await fetch(new URL('/api/servers/register', COORDINATOR_URL), {method:'POST',headers:{'content-type':'application/json','x-server-token':REGISTER_TOKEN},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)}); if (!r.ok) console.error('Room registration failed:',r.status,await r.text()); }
  catch (e) { console.error('Room registration failed:',e.message); }
}
setInterval(registerRoom, 8000).unref();
server.listen(PORT,'0.0.0.0',() => { console.log(`Game server ${ROOM_ID} listening on ${PORT}; max players ${MAX_PLAYERS}`); registerRoom(); });
