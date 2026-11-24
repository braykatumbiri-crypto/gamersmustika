'use strict';
/* Mustika Gamers: server game online.
   GET  /api/info    : apakah kata sandi diperlukan
   POST /api/login   : cek kata sandi (jika diperlukan), beri token sementara
   WS   /ws?token=&room= : posisi pemain, chat, sinyal WebRTC, laporan
   Pemain dipisah per ruang (kode 3-8 huruf/angka). Ruang bawaan: UMUM. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// GAME_PASSWORD kosong ("GAME_PASSWORD=") = terbuka untuk siapa saja. Tidak diatur = karuhun83.
const PASS = process.env.GAME_PASSWORD !== undefined ? process.env.GAME_PASSWORD : 'karuhun83';
const OPEN = PASS === '';
const MAX_ROOM = Number(process.env.MAX_ROOM || 40);
const PUB = path.join(__dirname, 'public');
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) ICE.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });

// ---- Akun ----
// Admin pertama dibuat dari variabel ADMIN_USER dan ADMIN_PASS. Tamu boleh masuk jika ALLOW_GUEST tidak "0".
const ALLOW_GUEST = process.env.ALLOW_GUEST !== '0';
const DATA = path.join(__dirname, 'data'); fs.mkdirSync(DATA, { recursive: true });
const USERS_F = path.join(DATA, 'users.json'), REPORTS_F = path.join(__dirname, 'reports.log');
let users = {}; try { users = JSON.parse(fs.readFileSync(USERS_F, 'utf8')); } catch (e) {}
const saveUsers = () => fs.writeFile(USERS_F, JSON.stringify(users), () => {});
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function mkUser(name, pw, role, display) {
  const salt = crypto.randomBytes(16).toString('hex');
  users[name] = { salt, hash: hashPw(pw, salt), display: display || name, role, banUntil: 0, created: Date.now() };
}
if (process.env.ADMIN_USER && process.env.ADMIN_PASS) {
  const a = process.env.ADMIN_USER.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16);
  if (a) { mkUser(a, process.env.ADMIN_PASS, 'admin', users[a] ? users[a].display : a); saveUsers(); }
}
const reports = [];
try { fs.readFileSync(REPORTS_F, 'utf8').split('\n').filter(Boolean).slice(-200).forEach(l => { try { reports.push(JSON.parse(l)); } catch (e) {} }); } catch (e) {}
const ipBans = new Map(), regs = new Map();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream' };
const sha = s => crypto.createHash('sha256').update(s).digest();
const passHash = sha(PASS);
const tokens = new Map(), fails = new Map();
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Filter kata kasar sederhana (pesan yang mengandung kata ini diblokir seluruhnya)
const BAD_LONG = ['anjing', 'bangsat', 'kontol', 'memek', 'ngentot', 'bajingan', 'jancok', 'jancuk', 'pantek', 'pepek', 'porno', 'bokep', 'fuck', 'bitch', 'goblok', 'tolol'];
const BAD_WORD = ['asu', 'babi', 'anjir', 'sex', 'seks', 'titit', 'dick', 'shit'];   // hanya sebagai kata utuh
const norm = s => s.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/@/g, 'a').replace(/\$/g, 's').replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
const LONGN = BAD_LONG.map(norm), WORDN = new Set(BAD_WORD.map(norm));
const isBad = t => LONGN.some(w => norm(t).includes(w)) || t.split(/\s+/).some(w => WORDN.has(norm(w)));

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, n);
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 2048) req.destroy(); });
  req.on('end', () => { let j = {}; try { j = JSON.parse(body) || {}; } catch (e) {} cb(j); });
}
const authOf = req => { const m = /^Bearer (\w+)$/.exec(req.headers.authorization || ''); const t = m && tokens.get(m[1]); return t && t.exp > Date.now() ? t : null; };
const isMod = t => t && (t.role === 'mod' || t.role === 'admin');
function issue(res, user, role, display) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { exp: Date.now() + 12 * 3600e3, user, role, display });
  json(res, 200, { ok: true, token, ice: ICE, role, user, display });
}
function failed(ip) { const g = fails.get(ip) || { n: 0, t: 0 }; g.n = (Date.now() - g.t > 60000 ? 0 : g.n) + 1; g.t = Date.now(); fails.set(ip, g); }
const blocked = ip => { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.t < 60000; };

const server = http.createServer((req, res) => {
  const ip = ipOf(req), url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/api/info') return json(res, 200, { needPassword: !OPEN, allowGuest: ALLOW_GUEST });

  if (req.method === 'POST' && url === '/api/register') return readBody(req, j => {
    const r = regs.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - r.t > 3600e3) { r.n = 0; r.t = Date.now(); }
    if (r.n >= 5) return json(res, 429, { ok: false, error: 'Terlalu banyak pendaftaran dari perangkat ini. Coba lagi nanti.' });
    const name = String(j.username || '').toLowerCase(), pw = String(j.password || '');
    if (!/^[a-z0-9_]{3,16}$/.test(name)) return json(res, 400, { ok: false, error: 'Nama akun 3-16 karakter: huruf kecil, angka, atau _.' });
    if (pw.length < 6 || pw.length > 64) return json(res, 400, { ok: false, error: 'Kata sandi akun minimal 6 karakter.' });
    if (users[name]) return json(res, 409, { ok: false, error: 'Nama akun sudah dipakai.' });
    const display = clean(j.display, 16).trim() || name;
    if (isBad(display) || isBad(name)) return json(res, 400, { ok: false, error: 'Nama tidak pantas. Pilih nama lain.' });
    r.n++; regs.set(ip, r);
    mkUser(name, pw, 'player', display); saveUsers();
    issue(res, name, 'player', display);
  });

  if (req.method === 'POST' && url === '/api/login') return readBody(req, j => {
    if (blocked(ip)) return json(res, 429, { ok: false, error: 'Terlalu banyak percobaan. Tunggu 1 menit.' });
    const pw = String(j.password || '');
    if (j.username) {   // masuk dengan akun
      const name = String(j.username).toLowerCase(), u = users[name];
      const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
      if (!ok) { failed(ip); return json(res, 401, { ok: false, error: 'Nama akun atau kata sandi salah.' }); }
      if (u.banUntil > Date.now()) return json(res, 403, { ok: false, error: 'Akun diblokir sampai ' + new Date(u.banUntil).toLocaleString('id-ID') + '.' });
      fails.delete(ip); return issue(res, name, u.role, u.display);
    }
    if (!ALLOW_GUEST) return json(res, 403, { ok: false, error: 'Server ini hanya untuk pemain dengan akun.' });
    if (!OPEN && !crypto.timingSafeEqual(sha(pw), passHash)) { failed(ip); return json(res, 401, { ok: false, error: 'Kata sandi salah. Coba lagi.' }); }
    if ((ipBans.get(ip) || 0) > Date.now()) return json(res, 403, { ok: false, error: 'Perangkat ini dikeluarkan sementara oleh moderator.' });
    fails.delete(ip); issue(res, null, 'guest', '');
  });

  // ---- API moderator / admin ----
  if (url.startsWith('/api/admin/')) {
    const t = authOf(req); if (!isMod(t)) return json(res, 403, { ok: false, error: 'Khusus moderator.' });
    if (req.method === 'GET' && url === '/api/admin/state') {
      const online = [...clients].map(([id, c]) => ({ id, room: c.room, name: c.p.n || '', kelas: c.p.k || '', mode: c.p.mode, user: c.user || '', role: c.role, mutedUntil: c.muteUntil || 0 }));
      const list = t.role === 'admin' ? Object.entries(users).map(([u, x]) => ({ user: u, display: x.display, role: x.role, banUntil: x.banUntil })) : [];
      return json(res, 200, { ok: true, me: { user: t.user, role: t.role }, online, reports: reports.slice(-100).reverse(), users: list });
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false });
    return readBody(req, j => {
      if (url === '/api/admin/kick' || url === '/api/admin/mute') {
        const c = clients.get(String(j.id)); if (!c) return json(res, 404, { ok: false, error: 'Pemain tidak ditemukan.' });
        if ((c.role === 'mod' || c.role === 'admin') && t.role !== 'admin') return json(res, 403, { ok: false, error: 'Tidak bisa menindak moderator.' });
        if (url === '/api/admin/mute') {
          const min = Math.max(1, Math.min(240, Number(j.minutes) || 10)); c.muteUntil = Date.now() + min * 60000;
          if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'muted', minutes: min }));
          return json(res, 200, { ok: true });
        }
        if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 'kicked' }));
        if (c.user) users[c.user].banUntil = Date.now() + 10 * 60000, saveUsers(); else ipBans.set(c.ip, Date.now() + 10 * 60000);
        setTimeout(() => c.ws.close(), 100);
        return json(res, 200, { ok: true });
      }
      const u = users[String(j.username || '').toLowerCase()];
      if (url === '/api/admin/ban') {
        if (!u) return json(res, 404, { ok: false, error: 'Akun tidak ditemukan.' });
        if (u.role !== 'player' && t.role !== 'admin') return json(res, 403, { ok: false, error: 'Tidak bisa memblokir moderator.' });
        u.banUntil = Number(j.minutes) > 0 ? Date.now() + Math.min(Number(j.minutes), 525600) * 60000 : 0; saveUsers();
        for (const [, c] of clients) if (c.user === String(j.username).toLowerCase() && u.banUntil) { c.ws.send(JSON.stringify({ t: 'kicked' })); setTimeout(() => c.ws.close(), 100); }
        return json(res, 200, { ok: true });
      }
      if (url === '/api/admin/role') {
        if (t.role !== 'admin') return json(res, 403, { ok: false, error: 'Khusus admin.' });
        if (!u || u.role === 'admin' || !['player', 'mod'].includes(j.role)) return json(res, 400, { ok: false, error: 'Permintaan tidak valid.' });
        u.role = j.role; saveUsers(); return json(res, 200, { ok: true });
      }
      json(res, 404, { ok: false });
    });
  }

  let p = decodeURIComponent(url); if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
});

const clients = new Map(); let nextId = 1;
const dirtyRooms = new Set();
const roomCount = r => { let n = 0; for (const c of clients.values()) if (c.room === r) n++; return n; };

const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
server.on('upgrade', (req, sock, head) => {
  const u = new URL(req.url, 'http://x');
  const tk = tokens.get(u.searchParams.get('token')), exp = tk && tk.exp;
  const room = String(u.searchParams.get('room') || 'UMUM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'UMUM';
  if (u.pathname !== '/ws' || !exp || exp < Date.now()) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); sock.destroy(); return; }
  if (roomCount(room) >= MAX_ROOM) { sock.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); sock.destroy(); return; }
  wss.handleUpgrade(req, sock, head, ws => { ws.room = room; ws.ip = ipOf(req); ws.tk = tk; wss.emit('connection', ws, req); });
});

const MODES = new Set(['menu', 'gang', 'rumah', 'kopdes', 'hidup', 'pancing', 'topi', 'lempar', 'kebun']);
const clampN = v => (typeof v === 'number' && isFinite(v)) ? Math.max(-200, Math.min(200, v)) : null;

wss.on('connection', ws => {
  const id = String(nextId++), room = ws.room;
  const tk = ws.tk || {}, c = { ws, room, ip: ws.ip, user: tk.user || '', role: tk.role || 'guest', display: tk.display || '', muteUntil: 0, p: { mode: 'menu' }, chatT: 0, repT: 0, msgs: 0, msgT: Date.now(), alive: true };
  clients.set(id, c); dirtyRooms.add(room);
  ws.send(JSON.stringify({ t: 'hello', id, room }));
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', buf => {
    const now = Date.now();
    if (now - c.msgT > 1000) { c.msgT = now; c.msgs = 0; }
    if (++c.msgs > 60) return;
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'presence' && m.p && typeof m.p === 'object') {
      const p = m.p, q = c.p;
      if ('n' in p) q.n = c.display || clean(p.n, 16);
      if ('k' in p) q.k = clean(p.k, 5);
      if ('g' in p) q.g = p.g === 'P' ? 'P' : 'L';
      if ('c' in p) q.c = clean(p.c, 12);
      if ('mode' in p && MODES.has(p.mode)) q.mode = p.mode;
      for (const k of ['x', 'z', 'ry']) if (k in p) { const v = p[k] === null ? null : clampN(p[k]); if (v === null) delete q[k]; else q[k] = v; }
      if ('e' in p) q.e = clean(p.e, 8);
      if ('et' in p && typeof p.et === 'number') q.et = p.et;
      dirtyRooms.add(room);
    } else if (m.t === 'chat' && m.data) {
      if (now - c.chatT < 600) return; c.chatT = now;
      const t = clean(m.data.t, 80); if (!t || isBad(t) || c.muteUntil > now) return;
      const out = JSON.stringify({ t: 'chat', from: id, data: { n: c.p.n || 'Pemain', t, m: c.p.mode } });
      for (const [i, o] of clients) if (i !== id && o.room === room && o.p.mode === c.p.mode && o.ws.readyState === 1) o.ws.send(out);
    } else if (m.t === 'sig') {
      const o = clients.get(String(m.to));
      const s = JSON.stringify(m.data || {});
      if (o && o !== c && o.room === room && c.p.mode !== 'menu' && o.p.mode === c.p.mode && o.ws.readyState === 1 && s.length < 20000)
        o.ws.send(JSON.stringify({ t: 'sig', from: id, data: m.data }));
    } else if (m.t === 'report') {
      if (now - c.repT < 5000) return; c.repT = now;
      const o = clients.get(String(m.to)); if (!o || o.room !== room) return;
      const rep = { at: new Date().toISOString(), room, by: c.p.n || '', target: o.p.n || '', targetKelas: o.p.k || '', targetId: m.to, targetUser: o.user || '' }; reports.push(rep); if (reports.length > 500) reports.shift(); const line = JSON.stringify(rep);
      console.log('LAPORAN', line);
      fs.appendFile(REPORTS_F, line + '\n', () => {});
    }
  });
  ws.on('close', () => { clients.delete(id); dirtyRooms.add(room); });
});

setInterval(() => {   // siarkan posisi pemain ke ruangnya masing-masing, 10x per detik bila ada perubahan
  if (!dirtyRooms.size) return;
  const rooms = [...dirtyRooms]; dirtyRooms.clear();
  for (const r of rooms) {
    const list = [...clients].filter(([, c]) => c.room === r);
    const s = JSON.stringify({ t: 'peers', peers: list.map(([id, c]) => ({ id, p: c.p, r: c.role === 'mod' || c.role === 'admin' ? 'mod' : '' })) });
    for (const [, c] of list) if (c.ws.readyState === 1) c.ws.send(s);
  }
}, 100);
setInterval(() => {
  for (const [id, c] of clients) { if (!c.alive) { c.ws.terminate(); clients.delete(id); dirtyRooms.add(c.room); continue; } c.alive = false; c.ws.ping(); }
  for (const [t, e] of tokens) if (e < Date.now()) tokens.delete(t);
}, 30000);

server.listen(PORT, () => console.log('Mustika Gamers berjalan di http://localhost:' + PORT + (OPEN ? ' (terbuka tanpa kata sandi)' : ' (dengan kata sandi)')));
