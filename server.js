require('dotenv').config();
const express    = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const { initDB, query, auditLog } = require('./db');
const nodemailer = require('nodemailer');
function getMailer() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT||'587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
async function sendDocEmail(recipientEmail, recipientName, senderName, doc, baseUrl) {
  const mailer = getMailer();
  if (!mailer || !recipientEmail) return;
  const docUrl = `${baseUrl}?doc=${doc.id}`;
  try {
    await mailer.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to: recipientEmail,
      subject: `📨 คุณได้รับเอกสารใหม่: ${doc.title}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
          <h2 style="color:#6366f1;">📨 SendFile — มีเอกสารใหม่สำหรับคุณ</h2>
          <p>สวัสดี <strong>${recipientName}</strong>,</p>
          <p><strong>${senderName}</strong> ได้ส่งเอกสารมาให้คุณ:</p>
          <div style="background:#f8f7ff;border-left:4px solid #6366f1;padding:16px;border-radius:8px;margin:16px 0;">
            <strong>${doc.title}</strong><br>
            <span style="color:#666;font-size:14px;">ความเร่งด่วน: ${doc.priority==='urgent'?'🔴 ด่วนมาก':doc.priority==='high'?'🟡 สำคัญ':'🟢 ปกติ'}</span>
          </div>
          <a href="${docUrl}" style="display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
            📄 เปิดดูเอกสาร
          </a>
          <p style="color:#999;font-size:12px;margin-top:24px;">ระบบ SendFile — PEO Thailand</p>
        </div>
      `
    });
  } catch(e) { console.warn('[Email] Failed:', e.message); }
}

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.json({ limit: '50mb' }));
// Serve static: support both public/ folder and root index.html
const fs = require('fs');
const PUBLIC_DIR = fs.existsSync(path.join(__dirname,'public')) ? path.join(__dirname,'public') : __dirname;
app.use(express.static(PUBLIC_DIR));
app.use((req, res, next) => { req.io = io; next(); });

// ─── JWT Middleware ───────────────────────────────────────────────────────────
async function auth(req, res, next) {
  const h = req.headers['authorization'];
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'ไม่ได้เข้าสู่ระบบ' });
  try {
    const payload = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    const { rows } = await query('SELECT * FROM users WHERE username=$1', [payload.username]);
    if (!rows.length) return res.status(401).json({ error: 'ไม่พบผู้ใช้' });
    req.user = rows[0]; next();
  } catch { res.status(401).json({ error: 'Token หมดอายุ กรุณาเข้าสู่ระบบใหม่' }); }
}
function admin(req, res, next) {
  if (req.user.role_id !== 'admin') return res.status(403).json({ error: 'ต้องการสิทธิ์ Admin' });
  next();
}
function tok(username) { return jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '8h' }); }

// ─── Format helpers ───────────────────────────────────────────────────────────
const fmtUser = u => ({
  username: u.username, fullName: u.full_name, email: u.email,
  department: u.department, location: u.location, role: u.role_id,
  passwordHash: u.password_hash, createdAt: Number(u.created_at)
});
const fmtDoc = d => ({
  id: d.id, title: d.title, contentType: d.content_type, content: d.content,
  senderUsername: d.sender_username, senderFullName: d.sender_full_name,
  senderDepartment: d.sender_department, senderLocation: d.sender_location,
  recipientType: d.recipient_type, recipientUsername: d.recipient_username,
  recipientDepartment: d.recipient_department, recipientFullName: d.recipient_full_name,
  priority: d.priority, attachmentNote: d.attachment_note,
  attachments: d.attachments || [], comments: d.comments || [],
  driveId: d.drive_id, driveUrl: d.drive_url,
  createdAt: Number(d.created_at), status: d.status,
  receivedAt: d.received_at ? Number(d.received_at) : null,
  receivedBy: d.received_by, storageLocation: d.storage_location, qrUrl: d.qr_url
});
const fmtNotif = n => ({
  id: n.id, type: n.type, toUsername: n.to_username,
  fromUsername: n.from_username, fromFullName: n.from_full_name,
  message: n.message, docId: n.doc_id, docTitle: n.doc_title,
  createdAt: Number(n.created_at), read: n.read
});

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, fullName, email, department, location, password } = req.body;
    if (!username || !fullName || !password) return res.status(400).json({ error: 'กรอกข้อมูลไม่ครบ' });
    const dup = await query('SELECT 1 FROM users WHERE username=$1', [username]);
    if (dup.rows.length) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
    const hash = await bcrypt.hash(password, 10);
    const now  = Date.now();
    const { rows: allUsers } = await query('SELECT COUNT(*) FROM users');
    const role = Number(allUsers[0].count) === 0 ? 'admin' : 'user'; // first user = admin
    await query(
      'INSERT INTO users (username,full_name,email,department,location,role_id,password_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [username, fullName, email||'', department||'', location||'', role, hash, now]
    );
    await auditLog('register', username, null, { fullName, department }, req.ip);
    res.json({ token: tok(username), username, role });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const { rows } = await query('SELECT * FROM users WHERE username=$1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) { await auditLog('login_fail', username, null, {}, req.ip); return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }); }
    await auditLog('login', username, null, {}, req.ip);
    res.json({ token: tok(username), username, role: rows[0].role_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', auth, (req, res) => res.json(fmtUser(req.user)));

app.post('/api/auth/passkey-setup', auth, async (req, res) => {
  try {
    const { passkey } = req.body;
    if (!passkey || !/^\d{6}$/.test(passkey)) return res.status(400).json({ error: 'Passkey ต้องเป็นตัวเลข 6 หลัก' });
    // Check duplicate: compare against all other users' passkeys
    const { rows: others } = await query('SELECT passkey_hash FROM users WHERE passkey_hash IS NOT NULL AND username!=$1', [req.user.username]);
    for (const u of others) {
      const dup = await bcrypt.compare(passkey, u.passkey_hash);
      if (dup) return res.status(409).json({ error: 'Passkey นี้ถูกใช้โดย User อื่นแล้ว กรุณาเลือก 6 หลักใหม่' });
    }
    const hash = await bcrypt.hash(passkey, 10);
    await query('UPDATE users SET passkey_hash=$1 WHERE username=$2', [hash, req.user.username]);
    await auditLog('passkey_set', req.user.username, null, {}, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Passkey-only login (no username needed) ──────────────────────────────────
app.post('/api/auth/passkey-only', async (req, res) => {
  try {
    const { passkey } = req.body;
    if (!passkey || !/^\d{6}$/.test(passkey)) return res.status(400).json({ error: 'Passkey ต้องเป็นตัวเลข 6 หลัก' });
    const { rows } = await query('SELECT * FROM users WHERE passkey_hash IS NOT NULL');
    for (const user of rows) {
      const ok = await bcrypt.compare(passkey, user.passkey_hash);
      if (ok) {
        await auditLog('login_passkey', user.username, null, {}, req.ip);
        return res.json({ token: tok(user.username), username: user.username, role: user.role_id });
      }
    }
    await auditLog('login_passkey_fail', 'unknown', null, {}, req.ip);
    return res.status(401).json({ error: 'Passkey ไม่ถูกต้อง' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Check if user has passkey set ────────────────────────────────────────────
app.get('/api/users/:username/passkey-status', auth, async (req, res) => {
  try {
    const { rows } = await query('SELECT passkey_hash FROM users WHERE username=$1', [req.params.username]);
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json({ hasPasskey: !!rows[0].passkey_hash });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin: clear a user's passkey ───────────────────────────────────────────
app.delete('/api/auth/passkey/:username', auth, admin, async (req, res) => {
  try {
    await query('UPDATE users SET passkey_hash=NULL WHERE username=$1', [req.params.username]);
    await auditLog('passkey_clear', req.user.username, req.params.username, {}, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/passkey-login', async (req, res) => {
  try {
    const { username, passkey } = req.body;
    if (!username || !passkey) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    const { rows } = await query('SELECT * FROM users WHERE username=$1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'ไม่พบผู้ใช้' });
    if (!rows[0].passkey_hash) return res.status(401).json({ error: 'ผู้ใช้นี้ยังไม่ได้ตั้ง Passkey' });
    const ok = await bcrypt.compare(passkey, rows[0].passkey_hash);
    if (!ok) return res.status(401).json({ error: 'Passkey ไม่ถูกต้อง' });
    await auditLog('passkey_login', username, null, {}, req.ip);
    res.json({ token: tok(username), username, role: rows[0].role_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════
app.get('/api/users', auth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM users ORDER BY created_at ASC');
    res.json(rows.map(fmtUser));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:username', auth, admin, async (req, res) => {
  try {
    const { fullName, email, department, location, role, password } = req.body;
    const uname = req.params.username;
    if (password?.length >= 4) {
      const hash = await bcrypt.hash(password, 10);
      await query('UPDATE users SET full_name=$1,email=$2,department=$3,location=$4,role_id=$5,password_hash=$6 WHERE username=$7',
        [fullName, email, department, location, role, hash, uname]);
    } else {
      await query('UPDATE users SET full_name=$1,email=$2,department=$3,location=$4,role_id=$5 WHERE username=$6',
        [fullName, email, department, location, role, uname]);
    }
    await auditLog('user_edit', req.user.username, uname, { fullName, role }, req.ip);
    const { rows } = await query('SELECT * FROM users WHERE username=$1', [uname]);
    res.json(fmtUser(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:username', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM users WHERE username=$1', [req.params.username]);
    await auditLog('user_delete', req.user.username, req.params.username, {}, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// DOCUMENTS
// ═══════════════════════════════════════════════════════════════════
app.get('/api/docs', auth, async (req, res) => {
  try {
    const u = req.user;
    const { rows: rr } = await query('SELECT permissions FROM roles WHERE id=$1', [u.role_id]);
    const perms = rr[0]?.permissions || {};
    let rows;
    if (perms.can_view_all || u.role_id === 'admin') {
      ({ rows } = await query('SELECT * FROM documents ORDER BY created_at DESC'));
    } else {
      ({ rows } = await query(
        `SELECT * FROM documents WHERE sender_username=$1 OR recipient_username=$1
         OR (recipient_type='department' AND recipient_department=$2) ORDER BY created_at DESC`,
        [u.username, u.department]
      ));
    }
    res.json(rows.map(fmtDoc));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs/:id', auth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM documents WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    res.json(fmtDoc(rows[0]));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/docs', auth, async (req, res) => {
  try {
    const d = req.body;
    await query(
      `INSERT INTO documents (id,title,content_type,content,sender_username,sender_full_name,
       sender_department,sender_location,recipient_type,recipient_username,recipient_department,
       recipient_full_name,priority,attachment_note,attachments,comments,created_at,status,qr_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending',$18)`,
      [d.id, d.title, d.contentType, JSON.stringify(d.content), d.senderUsername,
       d.senderFullName, d.senderDepartment, d.senderLocation, d.recipientType,
       d.recipientUsername||null, d.recipientDepartment||null, d.recipientFullName||null,
       d.priority||'normal', d.attachmentNote||null,
       JSON.stringify(d.attachments||[]), JSON.stringify(d.comments||[]),
       d.createdAt, d.qrUrl||null]
    );
    await auditLog('doc_create', req.user.username, d.id, { title: d.title }, req.ip);
    const { rows } = await query('SELECT * FROM documents WHERE id=$1', [d.id]);
    const doc = fmtDoc(rows[0]);
    req.io.emit('doc_update', { type: 'created', doc });
    // Send email notification to recipient(s)
    const origin = req.headers.origin || `https://${req.headers.host}`;
    if (d.recipientType === 'user' && d.recipientUsername) {
      const { rows: rr } = await query('SELECT email,full_name FROM users WHERE username=$1', [d.recipientUsername]);
      if (rr[0]?.email) sendDocEmail(rr[0].email, rr[0].full_name, doc.senderFullName, doc, origin);
    } else if (d.recipientType === 'department') {
      const { rows: deptUsers } = await query('SELECT email,full_name FROM users WHERE department=$1 AND username!=$2', [d.recipientDepartment, d.senderUsername]);
      for (const u of deptUsers) {
        if (u.email) sendDocEmail(u.email, u.full_name, doc.senderFullName, doc, origin);
      }
    }
    res.json(doc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/docs/:id/receive', auth, async (req, res) => {
  try {
    const { storageLocation, note } = req.body;
    const u = req.user; const now = Date.now();
    const { rows: cur } = await query('SELECT comments FROM documents WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    const comments = [...(cur[0].comments || []),
      { username: u.username, fullName: u.full_name, text: '✅ ยืนยันรับเอกสาร — ' + note, createdAt: now }];
    await query(
      'UPDATE documents SET status=$1,received_at=$2,received_by=$3,storage_location=$4,comments=$5 WHERE id=$6',
      ['received', now, u.full_name, storageLocation||'', JSON.stringify(comments), req.params.id]
    );
    await auditLog('doc_receive', u.username, req.params.id, { storageLocation }, req.ip);
    const { rows } = await query('SELECT * FROM documents WHERE id=$1', [req.params.id]);
    const doc = fmtDoc(rows[0]);
    req.io.emit('doc_update', { type: 'received', doc });
    res.json(doc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/docs/:id/comments', auth, async (req, res) => {
  try {
    const u = req.user; const now = Date.now();
    const { rows: cur } = await query('SELECT comments FROM documents WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    const comments = [...(cur[0].comments || []),
      { username: u.username, fullName: u.full_name, text: req.body.text, createdAt: now }];
    await query('UPDATE documents SET comments=$1 WHERE id=$2', [JSON.stringify(comments), req.params.id]);
    req.io.emit('doc_update', { type: 'comment', docId: req.params.id, comments });
    res.json({ ok: true, comments });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/docs/:id/drive', auth, async (req, res) => {
  try {
    const { driveId, driveUrl } = req.body;
    await query('UPDATE documents SET drive_id=$1,drive_url=$2 WHERE id=$3', [driveId, driveUrl, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Delete document (admin only) ─────────────────────────────────────────────
app.delete('/api/docs/:id', auth, admin, async (req, res) => {
  try {
    const docId = req.params.id;
    const { rows } = await query('SELECT id,title,attachments FROM documents WHERE id=$1', [docId]);
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
    await query('DELETE FROM notifications WHERE doc_id=$1', [docId]);
    await query('DELETE FROM documents WHERE id=$1', [docId]);
    await auditLog('doc_delete', req.user.username, docId, { title: rows[0].title }, req.ip);
    req.io.emit('doc_update', { type: 'deleted', docId });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Drive file IDs for expired docs (client uses these to delete from Drive) ─
app.get('/api/docs/expired-drive-ids', auth, async (req, res) => {
  try {
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const { rows } = await query('SELECT id, attachments, drive_id FROM documents WHERE created_at < $1', [cutoff]);
    const result = rows.map(r => ({
      docId: r.id,
      driveId: r.drive_id || null,
      attachmentDriveIds: (r.attachments || []).filter(a => a.driveId).map(a => a.driveId)
    }));
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// ROLES
// ═══════════════════════════════════════════════════════════════════
app.get('/api/roles', auth, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM roles ORDER BY is_default DESC, name ASC');
    res.json(rows.map(r => ({ id: r.id, name: r.name, isDefault: r.is_default, permissions: r.permissions })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/roles', auth, admin, async (req, res) => {
  try {
    const { id, name, permissions } = req.body;
    await query('INSERT INTO roles (id,name,is_default,permissions) VALUES($1,$2,false,$3)',
      [id, name, JSON.stringify(permissions)]);
    await auditLog('role_create', req.user.username, id, { name }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/roles/:id', auth, admin, async (req, res) => {
  try {
    const { name, permissions } = req.body;
    await query('UPDATE roles SET name=$1,permissions=$2 WHERE id=$3',
      [name, JSON.stringify(permissions), req.params.id]);
    await auditLog('role_edit', req.user.username, req.params.id, { name }, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/roles/:id', auth, admin, async (req, res) => {
  try {
    const { rows } = await query('SELECT is_default FROM roles WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'ไม่พบ role' });
    if (rows[0].is_default) return res.status(400).json({ error: 'ไม่สามารถลบ default role ได้' });
    await query('DELETE FROM roles WHERE id=$1', [req.params.id]);
    await auditLog('role_delete', req.user.username, req.params.id, {}, req.ip);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════
app.get('/api/notifs', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM notifications WHERE to_username=$1 OR to_username='__all__'
       ORDER BY created_at DESC LIMIT 100`, [req.user.username]);
    res.json(rows.map(fmtNotif));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notifs', auth, async (req, res) => {
  try {
    const n = req.body;
    await query(
      `INSERT INTO notifications (id,type,to_username,from_username,from_full_name,message,doc_id,doc_title,created_at,read)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
      [n.id, n.type, n.toUsername, n.fromUsername, n.fromFullName,
       n.message, n.docId||null, n.docTitle||null, n.createdAt]);
    const formatted = fmtNotif({ ...n, to_username: n.toUsername, from_username: n.fromUsername,
      from_full_name: n.fromFullName, doc_id: n.docId, doc_title: n.docTitle,
      created_at: n.createdAt, read: false });
    req.io.to(n.toUsername === '__all__' ? 'broadcast' : n.toUsername).emit('new_notif', formatted);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/notifs/read-all', auth, async (req, res) => {
  try {
    await query(
      `UPDATE notifications SET read=true WHERE (to_username=$1 OR to_username='__all__') AND read=false`,
      [req.user.username]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notifs/broadcast', auth, admin, async (req, res) => {
  try {
    const { message } = req.body;
    const id = 'N-' + Date.now(); const now = Date.now();
    await query(
      `INSERT INTO notifications (id,type,to_username,from_username,from_full_name,message,created_at,read)
       VALUES($1,'admin_broadcast','__all__',$2,$3,$4,$5,false)`,
      [id, req.user.username, req.user.full_name, message, now]);
    await auditLog('broadcast', req.user.username, null, { message }, req.ip);
    req.io.emit('new_notif', { id, type:'admin_broadcast', toUsername:'__all__',
      fromUsername: req.user.username, fromFullName: req.user.full_name,
      message, createdAt: now, read: false });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// LOCATIONS
// ═══════════════════════════════════════════════════════════════════
app.get('/api/locations', auth, async (req, res) => {
  try {
    const { rows } = await query('SELECT name FROM locations ORDER BY id ASC');
    res.json(rows.map(r => r.name));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/locations', auth, admin, async (req, res) => {
  try {
    await query('INSERT INTO locations (name) VALUES($1) ON CONFLICT (name) DO NOTHING', [req.body.name]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/locations/:name', auth, admin, async (req, res) => {
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { newName } = req.body;
    if (!newName?.trim()) return res.status(400).json({ error: 'ชื่อใหม่ต้องไม่ว่างเปล่า' });
    const n = newName.trim();
    // Check duplicate
    const dup = await query('SELECT 1 FROM locations WHERE name=$1', [n]);
    if (dup.rows.length) return res.status(409).json({ error: 'ชื่อสถานที่นี้มีอยู่แล้ว' });
    // Rename in locations table
    await query('UPDATE locations SET name=$1 WHERE name=$2', [n, oldName]);
    // Cascade: update documents.storage_location
    await query('UPDATE documents SET storage_location=$1 WHERE storage_location=$2', [n, oldName]);
    // Cascade: update users.location
    await query('UPDATE users SET location=$1 WHERE location=$2', [n, oldName]);
    await auditLog('location_rename', req.user.username, null, { oldName, newName: n }, req.ip);
    res.json({ ok: true, newName: n });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/locations/:name', auth, admin, async (req, res) => {
  try {
    await query('DELETE FROM locations WHERE name=$1', [decodeURIComponent(req.params.name)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════
app.get('/api/settings/gdrive', auth, async (req, res) => {
  try {
    const { rows } = await query("SELECT value FROM settings WHERE key='gdrive'");
    res.json(rows[0]?.value || { enabled: false, clientId: '', folderId: '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings/gdrive', auth, admin, async (req, res) => {
  try {
    await query("INSERT INTO settings(key,value) VALUES('gdrive',$1) ON CONFLICT(key) DO UPDATE SET value=$1",
      [JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings/email-status', auth, admin, async (req, res) => {
  res.json({ configured: !!process.env.SMTP_HOST, host: process.env.SMTP_HOST||'' });
});

app.get('/api/settings/audit-log', auth, admin, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════
io.on('connection', socket => {
  socket.on('join', username => {
    socket.join(username);
    socket.join('broadcast');
  });
});

// ─── SPA Fallback ─────────────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ─── Auto-cleanup expired docs (30 days) ──────────────────────────
async function cleanupExpiredDocs() {
  try {
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const expired = await query('SELECT id FROM documents WHERE created_at < $1', [cutoff]);
    if (expired.rows.length === 0) return;
    const ids = expired.rows.map(r => r.id);
    await query('DELETE FROM notifications WHERE doc_id = ANY($1)', [ids]);
    const del = await query('DELETE FROM documents WHERE created_at < $1 RETURNING id', [cutoff]);
    console.log(`[Cleanup] Deleted ${del.rowCount} expired docs (>30 days)`);
    // Notify all clients to refresh
    if (del.rowCount > 0) {
      ids.forEach(docId => {
        try { global._io?.emit('doc_update', { type: 'deleted', docId }); } catch(_) {}
      });
    }
  } catch(e) { console.error('[Cleanup] Error:', e.message); }
}

// ─── Start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
global._io = io; // expose io for cleanup function
initDB()
  .then(() => {
    httpServer.listen(PORT, () =>
      console.log(`✅ SendFile → http://localhost:${PORT}`));
    // Run cleanup immediately then every 24h
    cleanupExpiredDocs();
    setInterval(cleanupExpiredDocs, 24 * 60 * 60 * 1000);
  })
  .catch(err => { console.error('DB init failed:', err); process.exit(1); });
