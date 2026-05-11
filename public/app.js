// ===================================================================
// ERROR HANDLER — shows errors visibly so bugs are caught in prod
// ===================================================================
window.onerror = function(msg, src, line, col, err) {
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;top:0;left:0;right:0;background:#dc2626;color:#fff;padding:10px 16px;font-size:13px;z-index:9999;font-family:monospace;word-break:break-all;";
  div.textContent = "⚠️ JS Error: " + msg + " (" + src + ":" + line + ")";
  document.body && document.body.appendChild(div);
  setTimeout(()=>div.remove(), 8000);
  return false;
};
window.addEventListener("unhandledrejection", function(e) {
  console.error("Unhandled promise rejection:", e.reason);
});

// ===================================================================
// CONSTANTS & STORAGE
// ===================================================================
// URL is built dynamically so QR codes work on file://, localhost, and production
const BASE_URL = (()=>{
  if(window.location.protocol === 'file:') return 'http://localhost:8080';
  return window.location.href.replace(/[?#].*$/, '').replace(/\/$/, '');
})();
const K = { users:'sendfile_users', session:'sendfile_session', docs:'sendfile_documents', locs:'sendfile_locations', depts:'sendfile_departments', roles:'sendfile_roles', gdrive:'sendfile_gdrive', notifs:'sendfile_notifs' };
const REMEMBER_KEY = 'sf_doc_session';     // 24h remembered doc-preview session
const REMEMBER_AUTH_KEY = 'sf_remember_auth'; // 24h remember-me for regular login

// ── 24h Doc-preview session helpers ─────────────────────────────
function saveDocSession(token, username) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({
      token, username,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    }));
  } catch(_) {}
}
function getDocSession() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.token || !s.expiresAt) return null;
    if (Date.now() > s.expiresAt) { localStorage.removeItem(REMEMBER_KEY); return null; }
    return s;
  } catch(_) { return null; }
}
function clearDocSession() {
  localStorage.removeItem(REMEMBER_KEY);
}

// ── 24h Remember-me helpers (regular login) ──────────────────────
function saveRememberAuth(token, username) {
  try {
    localStorage.setItem(REMEMBER_AUTH_KEY, JSON.stringify({
      token, username,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    }));
  } catch(_) {}
}
function getRememberAuth() {
  try {
    const raw = localStorage.getItem(REMEMBER_AUTH_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.token || !s.expiresAt) return null;
    if (Date.now() > s.expiresAt) { localStorage.removeItem(REMEMBER_AUTH_KEY); return null; }
    return s;
  } catch(_) { return null; }
}
function clearRememberAuth() {
  localStorage.removeItem(REMEMBER_AUTH_KEY);
}

// ── Cache Version Check ─────────────────────────────────────────
// When APP_VERSION changes (new deploy), automatically clears all
// stale K.* localStorage keys so mobile browsers don't show old data
const APP_VERSION = 'v8-20260511c'; // bump → clears stale hardcoded locations/depts
(function clearCacheOnVersionChange() {
  const stored = localStorage.getItem('sf_app_version');
  if (stored !== APP_VERSION) {
    // New deploy detected — wipe all data caches (keep JWT session)
    const keysToKeep = ['sf_jwt']; // sessionStorage key, but kept for safety
    Object.values(K).forEach(k => localStorage.removeItem(k));
    localStorage.setItem('sf_app_version', APP_VERSION);
    console.log('[Cache] Version changed', stored, '→', APP_VERSION, '— localStorage cleared');
  }
})();

// ===================================================================
// API LAYER — replaces localStorage writes with server calls
// ===================================================================
const _JWT_KEY = 'sf_jwt';
let _jwt = sessionStorage.getItem(_JWT_KEY);

async function apiCall(method, path, body=null) {
  const opts = { method, headers: {} };
  if (_jwt) opts.headers['Authorization'] = 'Bearer ' + _jwt;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  try {
    const r = await fetch(path, opts);
    if (r.status === 401) { _jwt=null; sessionStorage.removeItem(_JWT_KEY); showAuth(); return null; }
    if (r.status === 503) {
      // DB/server temporarily unavailable — show toast but do NOT logout
      let errMsg = 'ระบบชั่วคราวไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง';
      try { const e = await r.json(); errMsg = e.error || errMsg; } catch(_){}
      showToast(errMsg, 'error');
      return null;
    }
    if (!r.ok) {
      let errMsg = 'Server error ' + r.status;
      try { const e = await r.json(); errMsg = e.error || errMsg; } catch(_){}
      console.error('API error:', path, errMsg);
      return null;
    }
    return await r.json();
  } catch(e) { console.error('API error:', e); showToast('เชื่อมต่อ server ไม่ได้','error'); return null; }
}

// Always keep the logged-in user in K.users so getCurrentUser() never returns null
// even if syncFromServer() fails (Render sleeping / Neon DB cold start)
function seedCurrentUser(user) {
  if (!user || !user.username) return;
  try {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === user.username);
    if (idx >= 0) users[idx] = { ...users[idx], ...user };
    else users.unshift(user);
    localStorage.setItem(K.users, JSON.stringify(users));
  } catch(_) {}
}

async function syncFromServer() {
  // Single /api/sync call replaces 6 separate API calls — much faster
  const data = await apiCall('GET', '/api/sync');
  if (!data) return;
  _lastSyncTime = Date.now();
  const isArr = v => Array.isArray(v);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (isArr(data.users))     localStorage.setItem(K.users,  JSON.stringify(data.users));
  if (isArr(data.docs))      localStorage.setItem(K.docs,   JSON.stringify(data.docs));
  if (isArr(data.roles))     localStorage.setItem(K.roles,  JSON.stringify(data.roles));
  if (isArr(data.locations))   localStorage.setItem(K.locs,   JSON.stringify(data.locations));
  if (isArr(data.departments)) localStorage.setItem(K.depts,  JSON.stringify(data.departments));
  if (isArr(data.notifs))      localStorage.setItem(K.notifs, JSON.stringify(data.notifs));
  if (isObj(data.gdrive) || isArr(data.gdrive)) localStorage.setItem(K.gdrive, JSON.stringify(data.gdrive));
}

// Fire-and-forget API sync — never blocks UI
function _apiSync(method, path, body) {
  apiCall(method, path, body).catch(e => console.warn("_apiSync failed:", path, e));
}


function showAuth() {
  localStorage.removeItem(K.session);
  document.getElementById('dashboard').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
  const _mbnav=document.getElementById('mobile-bottom-nav');if(_mbnav)_mbnav.style.display='none';
  switchTab('login');
}

// Socket.io — connect after DOM ready
let _socket = null;
// ── Polling fallback: sync every 15s (Socket.io handles real-time; poll is safety net) ──
let _pollInterval = null;
let _lastSyncTime = 0;
const _refreshCooldowns = {}; // keyed by page name, value = last refresh timestamp
function canRefreshPage(page){ return Date.now() - (_refreshCooldowns[page]||0) > 30000; }
function markRefreshed(page){ _refreshCooldowns[page]=Date.now(); startRefreshCountdown(page); }
function refreshCooldownSecs(page){ return Math.max(0,30-Math.round((Date.now()-(_refreshCooldowns[page]||0))/1000)); }

// ── Live countdown on refresh buttons ──────────────────────────────
let _countdownInterval = null;
function startRefreshCountdown(page){
  if(_countdownInterval) clearInterval(_countdownInterval);
  _countdownInterval = setInterval(()=>{
    const secs = refreshCooldownSecs(page);
    const btn = document.getElementById('page-refresh-btn') ||
                document.getElementById('inbox-refresh-btn') ||
                document.getElementById('notifs-refresh-btn');
    if(!btn){ clearInterval(_countdownInterval); return; }
    if(secs <= 0){
      clearInterval(_countdownInterval);
      btn.disabled = false;
      // restore icon+text
      const svgPart = btn.querySelector('svg') ? '' : '';
      btn.innerHTML = btn.innerHTML.replace(/รออีก\s*\d+\s*วิ|รีเฟรช/,'รีเฟรช');
      btn.disabled = false;
      return;
    }
    // update countdown text — find text node and replace
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const n = walker.currentNode;
      if(/รออีก|วิ|รีเฟรช/.test(n.textContent)){
        n.textContent = 'รออีก '+secs+' วิ';
        break;
      }
    }
    btn.disabled = true;
  }, 1000);
}
async function forceRefreshPage(page){
  if(!canRefreshPage(page)){ showToast('กรุณารอ '+refreshCooldownSecs(page)+' วินาที ก่อนรีเฟรชอีกครั้ง','error'); return; }
  markRefreshed(page);
  const btn=document.getElementById('page-refresh-btn');
  if(btn){ btn.disabled=true; btn.textContent='\u{1F504} กำลังโหลด...'; }
  try {
    const data=await apiCall('GET','/api/docs/all-meta');
    if(Array.isArray(data)){ localStorage.setItem(K.docs,JSON.stringify(data)); _lastSyncTime=Date.now(); }
    const notifData=await apiCall('GET','/api/notifs');
    if(Array.isArray(notifData)){ localStorage.setItem(K.notifs,JSON.stringify(notifData)); }
    const userData=await apiCall('GET','/api/users');
    if(Array.isArray(userData)){ localStorage.setItem(K.users,JSON.stringify(userData)); }
  } catch(e){}
  if(page==='home') await renderHome();
  else if(page==='outbox') renderOutbox();
  else if(page==='inbox') renderInbox();
  else if(page==='admin') renderAdmin();
  else if(page==='notifs') renderNotifs();
  updateNotifBadge();
}
function startPolling() {
  if (_pollInterval) clearInterval(_pollInterval);
  _pollInterval = setInterval(async () => {
    if (!getCurrentUser()) return;
    // Smart interval: 5s on inbox/outbox (user expects live updates), 15s elsewhere
    const activePage = currentPage;
    const isLivePage = ['inbox','outbox'].includes(activePage);
    const elapsed = Date.now() - _lastSyncTime;
    if (!isLivePage && elapsed < 15000) return; // skip if polled recently on non-live page
    await syncFromServer();
    _lastSyncTime = Date.now();
    updateInboxBadge(); updateNotifBadge();
    if (['home','inbox','outbox','admin','notifs'].includes(activePage)) {
      navigate(activePage);
    }
  }, 5000); // 5s tick — smart interval logic above controls actual sync frequency
}
function stopPolling() { if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null; } }

// ── Page Visibility: sync immediately when user returns to tab ───────────────
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && getCurrentUser()) {
    await syncFromServer();
    updateInboxBadge(); updateNotifBadge();
    if (['inbox','outbox','home','notifs','admin'].includes(currentPage)) {
      navigate(currentPage);
    }
  }
});

function connectSocket(username) {
  if (typeof io === 'undefined') return; // socket.io ยังไม่โหลด — ใช้ polling แทน
  if (_socket) _socket.disconnect();
  try {
    _socket = io({
      transports: ['websocket','polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000
    });

    // join room immediately
    _socket.emit('join', username);

    // 'connect' fires on BOTH initial connect AND every reconnect in Socket.io v4
    // Note: socket.on('reconnect') does NOT fire in v4 — must use 'connect' instead
    let _isFirstConnect = true;
    _socket.on('connect', async () => {
      _socket.emit('join', username);
      if (_isFirstConnect) {
        // Initial connect — data already synced at login, skip re-sync
        _isFirstConnect = false;
        console.log('[socket] initial connect, room:', username);
      } else {
        // Reconnect after server sleep or network drop — must re-fetch to get missed events
        console.log('[socket] reconnected, syncing fresh data...');
        // Force-fetch docs directly (faster than full sync for inbox)
        apiCall('GET','/api/docs/all-meta').then(d=>{
          if(Array.isArray(d)){localStorage.setItem(K.docs,JSON.stringify(d));_lastSyncTime=Date.now();}
        }).catch(()=>{});
        await syncFromServer();
        updateInboxBadge(); updateNotifBadge();
        if (['inbox','outbox','admin','home','notifs','profile'].includes(currentPage))
          navigate(currentPage);
      }
    });
    _socket.on('disconnect', (reason) => {
      console.warn('[socket] disconnected:', reason);
    });

    _socket.on('doc_update', async (data) => {
      if(data?.type==='deleted'){
        // Instant local cache update — no server round-trip needed
        const docs=getDocs().filter(d=>String(d.id)!==String(data.docId));
        localStorage.setItem(K.docs,JSON.stringify(docs));
        if(typeof adminSelectedDoc!=='undefined' && String(adminSelectedDoc)===String(data.docId)) adminSelectedDoc=null;
      } else if(data?.type==='clear_all'){
        // Clear cache immediately for instant UI, then confirm from DB
        localStorage.setItem(K.docs, JSON.stringify([]));
        localStorage.setItem(K.notifs, JSON.stringify([]));
        await syncFromServer(); // confirm empty state from DB
      } else if(data?.doc) {
        // Merge incoming doc into cache AND sync to ensure recipient has full data
        const docs=getDocs();
        const idx=docs.findIndex(d=>d.id===data.doc.id);
        if(idx>=0) docs[idx]=data.doc; else docs.unshift(data.doc);
        localStorage.setItem(K.docs,JSON.stringify(docs));
        // Also trigger a background sync to make sure inbox/outbox filter state is fresh
        syncFromServer().catch(()=>{});
      } else {
        await syncFromServer();
      }
      updateInboxBadge(); updateNotifBadge();
      const pages=['inbox','outbox','admin','home','notifs','profile'];
      if(pages.includes(currentPage)) navigate(currentPage);
    });
    _socket.on('new_notif', async (notif) => {
      // Merge notification into cache instantly
      if(notif) {
        const notifs=getNotifs();
        if(!notifs.find(n=>n.id===notif.id)) notifs.unshift(notif);
        localStorage.setItem(K.notifs,JSON.stringify(notifs));
        // Show popup alert for important notifications
        showNotifPopup(notif);
      } else {
        await syncFromServer();
      }
      updateNotifBadge(); updateInboxBadge();
      const pages=['inbox','outbox','admin','home','notifs','profile'];
      if(pages.includes(currentPage)) navigate(currentPage);
    });
    // clear_all handled in main doc_update handler above
    _socket.on('notifs_cleared', () => {
      localStorage.setItem(K.notifs, JSON.stringify([]));
      updateNotifBadge(); updateInboxBadge();
      if(currentPage==='notifs') navigate('notifs');
    });
    // force_sync: server tells ALL clients to re-fetch from DB (used after admin clears data)
    _socket.on('force_sync', async () => {
      await syncFromServer();
      updateNotifBadge(); updateInboxBadge();
      if(['inbox','outbox','home','notifs','admin'].includes(currentPage)) navigate(currentPage);
    });
  } catch(e) { console.warn('Socket.io connect failed, using polling only:', e); }
}

const store = {
  get:(k)=>JSON.parse(localStorage.getItem(k)||'[]'),
  set:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),
  getObj:(k)=>JSON.parse(localStorage.getItem(k)||'null'),
  setObj:(k,v)=>localStorage.setItem(k,JSON.stringify(v))
};

// ===================================================================
// UTILITIES
// ===================================================================
async function hashPassword(pw){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function escapeHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function formatDate(ts){ if(!ts)return'—'; const d=new Date(ts); return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()+543} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')} น.`; }
function formatDateShort(ts){ if(!ts)return'—'; const d=new Date(ts); return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${(d.getFullYear()+543).toString().slice(-2)}`; }
function generateDocId(){ const docs=store.get(K.docs); const n=(docs.length+1).toString().padStart(4,'0'); return `DOC-${new Date().getFullYear()}-${n}`; }
// ─── Notification popup (real-time alert) ─────────────────────────────────────
function showNotifPopup(notif){
  // Suppress popup only for received_log (redundant self-log), but show sent_log as confirmation
  const selfTypes=['doc_received_log'];
  if(selfTypes.includes(notif.type)) return;
  const icon=notifIcon(notif.type)||'🔔';
  const label=notifTypeLabel(notif.type)||'แจ้งเตือน';
  const existing=document.getElementById('notif-popup');
  if(existing) existing.remove();
  const pop=document.createElement('div');
  pop.id='notif-popup';
  pop.style.cssText=`position:fixed;bottom:80px;right:20px;z-index:9998;
    background:var(--card);border:1px solid var(--border);border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,0.4);padding:14px 18px;max-width:320px;min-width:240px;
    animation:slideInRight .3s ease;cursor:pointer;`;
  pop.innerHTML=`
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="font-size:22px;line-height:1;">${icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:700;color:var(--accent-light);margin-bottom:2px;">${label}</div>
        <div style="font-size:13px;color:var(--text);line-height:1.4;word-break:break-word;">${escapeHtml(notif.message||'')}</div>
        ${notif.fromFullName?`<div style="font-size:11px;color:var(--muted);margin-top:4px;">จาก: ${escapeHtml(notif.fromFullName)}</div>`:''}
      </div>
      <div style="font-size:18px;color:var(--muted);padding-left:4px;line-height:1;" onclick="document.getElementById('notif-popup')?.remove()">×</div>
    </div>`;
  pop.onclick=(e)=>{ if(e.target.textContent==='×')return; navigate('notifs'); pop.remove(); };
  document.body.appendChild(pop);
  // Auto-dismiss after 6 seconds
  setTimeout(()=>{ if(pop.parentNode){ pop.style.animation='slideOutRight .3s ease'; setTimeout(()=>pop.remove(),280); } },6000);
}

// ─── Admin: clear all data with passkey confirmation ────────────────────────
function openClearDataModal(type){
  const isDocs = type==='docs';
  const title = isDocs ? '🗑 ล้างเอกสารทั้งหมด' : '📭 ล้างประวัติกล่องจดหมาย';
  const warning = isDocs
    ? 'เอกสารทุกฉบับในระบบ รวมถึงไฟล์แนบ จะถูกลบถาวร ไม่สามารถกู้คืนได้'
    : 'ประวัติกล่องจดหมายของทุก User จะถูกล้าง';
  openModal(title,`
    <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:10px;padding:14px;margin-bottom:16px;">
      <div style="font-size:13px;color:#fca5a5;font-weight:600;">⚠️ คำเตือน</div>
      <div style="font-size:13px;color:var(--muted);margin-top:4px;">${warning}</div>
    </div>
    <div class="form-group">
      <label>ยืนยันด้วย Passkey ของคุณ</label>
      <input type="password" id="clear-passkey-input" inputmode="numeric" maxlength="6"
        placeholder="กรอก Passkey 6 หลัก"
        style="letter-spacing:0.3em;font-size:18px;text-align:center;"
        onkeydown="if(event.key==='Enter')confirmClearData('${type}')">
    </div>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button>
     <button class="btn-danger" onclick="confirmClearData('${type}')" style="background:var(--red);color:#fff;border:none;border-radius:var(--r);padding:8px 20px;cursor:pointer;font-weight:600;">🗑 ยืนยันลบ</button>`,
    ()=>setTimeout(()=>document.getElementById('clear-passkey-input')?.focus(),100)
  );
}
async function confirmClearData(type){
  const passkey=(document.getElementById('clear-passkey-input')?.value||'').trim();
  if(!passkey){showToast('กรุณากรอก Passkey','error');return;}
  const btn=document.querySelector('#modal-footer .btn-danger');
  if(btn){btn.disabled=true;btn.textContent='กำลังดำเนินการ...';}
  const endpoint = type==='docs' ? '/api/admin/clear-docs' : '/api/admin/clear-notifs';
  const res=await apiCall('POST', endpoint, {passkey});
  if(btn){btn.disabled=false;btn.textContent='🗑 ยืนยันลบ';}
  if(res?.ok){
    closeModal();
    showToast(type==='docs'?'ล้างเอกสารทั้งหมดแล้ว ✓':'ล้างกล่องจดหมายแล้ว ✓');
    if(type==='docs'){
      localStorage.setItem(K.docs, JSON.stringify([]));
      localStorage.setItem(K.notifs, JSON.stringify([]));
    } else {
      localStorage.setItem(K.notifs, JSON.stringify([]));
    }
    updateInboxBadge(); updateNotifBadge();
    if(['inbox','outbox','admin','home','notifs'].includes(currentPage)) navigate(currentPage);
  } else {
    showToast(res?.error||'ดำเนินการไม่สำเร็จ','error');
  }
}

function showToast(msg,type='success'){
  const t=document.getElementById('toast'); t.textContent=msg; t.className=type; t.style.display='block';
  clearTimeout(window._toastTimer); window._toastTimer=setTimeout(()=>t.style.display='none',3000);
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme')||'light';
  const next=cur==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  localStorage.setItem('sendfile_theme',next);
  updateThemeBtn(next);
}
function updateThemeBtn(theme){
  const btn=document.getElementById('theme-toggle-btn');
  if(btn) btn.innerHTML=theme==='dark'?'☀️ Light Mode':'🌙 Dark Mode';
}
function closeMobileSidebar(){
  const sb=document.getElementById('sidebar');
  const ov=document.getElementById('mobile-overlay');
  if(sb) sb.classList.remove('open');
  if(ov) ov.classList.remove('open');
}
function toggleMobileSidebar(){
  const sb=document.getElementById('sidebar');
  const ov=document.getElementById('mobile-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('open');
}
function togglePw(id,btn){const el=document.getElementById(id);el.type=el.type==='password'?'text':'password';btn.textContent=el.type==='password'?'👁':'🙈';}
function timeAgo(ts){
  if(!ts) return '—';
  const diff = Date.now() - new Date(ts).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if(mins  <  1)  return 'เพิ่งส่ง';
  if(mins  < 60)  return `${mins} นาทีที่แล้ว`;
  if(hours < 24)  return `${hours} ชม. ที่แล้ว`;
  if(days  < 30)  return `${days} วันที่แล้ว`;
  const months = Math.floor(days / 30);
  if(months < 12) return `${months} เดือนที่แล้ว`;
  return `${Math.floor(months/12)} ปีที่แล้ว`;
}
function priorityLabel(p){ return {normal:'ปกติ',urgent:'ด่วน',very_urgent:'ด่วนมาก'}[p]||p; }
function priorityBadge(p){
  if(p==='very_urgent') return '<span class="badge badge-urgent">ด่วนมาก</span>';
  if(p==='urgent') return '<span class="badge badge-pending">ด่วน</span>';
  return '<span class="badge badge-normal">ปกติ</span>';
}

// ===================================================================
// LOCATIONS
// ===================================================================
function getLocations(){
  return store.get(K.locs) || [];
}
function getDepartments(){
  return store.get(K.depts) || [];
}

// ── Force-fetch users directly if cache looks incomplete ─────────────────────
// Called when admin panel shows fewer users than expected (e.g. only seeded user)
let _usersFetchInProgress = false;
async function ensureUsersLoaded(onDone) {
  if (_usersFetchInProgress) return;
  _usersFetchInProgress = true;
  try {
    const data = await apiCall('GET', '/api/users');
    if (Array.isArray(data) && data.length > 0) {
      localStorage.setItem(K.users, JSON.stringify(data));
      if (onDone) onDone();
    }
  } catch(_) {}
  finally { _usersFetchInProgress = false; }
}

// ── Ensure locations/departments are loaded before showing dropdowns ──────────
// If cache is empty (sync not yet complete), fetch direct from API and re-render
async function ensureLocsLoaded() {
  if (getLocations().length > 0 && getDepartments().length > 0) return;
  try {
    // Use public endpoints when no JWT (e.g. register form before login)
    const usePublic = !_jwt;
    const locPath  = usePublic ? '/api/public/locations'    : '/api/locations';
    const deptPath = usePublic ? '/api/public/departments'  : '/api/departments';
    const fetchRaw = (path) => fetch(path).then(r=>r.json()).catch(()=>null);
    const [l, d] = usePublic
      ? await Promise.all([fetchRaw(locPath), fetchRaw(deptPath)])
      : await Promise.all([apiCall('GET', locPath), apiCall('GET', deptPath)]);
    if (Array.isArray(l) && l.length) localStorage.setItem(K.locs, JSON.stringify(l));
    if (Array.isArray(d) && d.length) localStorage.setItem(K.depts, JSON.stringify(d));
  } catch(_) {}
}

// ===================================================================
// ROLES
// ===================================================================
const DEFAULT_ROLES=[
  {id:'user',name:'User',isDefault:true,permissions:{can_send:true,can_receive:true,can_view_all:false,can_manage_users:false,can_export:false,can_admin:false,can_preview_docs:false}},
  {id:'admin',name:'Admin',isDefault:true,permissions:{can_send:true,can_receive:true,can_view_all:true,can_manage_users:true,can_export:true,can_preview_docs:true}}
];
function getRoles(){let r=store.get(K.roles);return(!r||r.length===0)?DEFAULT_ROLES:r;}
function saveRoles(r){store.set(K.roles,r);}
function getRoleById(id){return getRoles().find(r=>r.id===id)||DEFAULT_ROLES[0];}
function getRoleName(roleId){
  if(!roleId) return 'User';
  const role=getRoles().find(r=>r.id===roleId);
  return role ? role.name : roleId;
}
function hasAdminAccess(u){
  if(!u) return false;
  return u.role==='admin'; // Only built-in admin role
}
function permLabel(p){return{can_send:'ส่งเอกสาร',can_receive:'รับเอกสาร',can_view_all:'ดูเอกสารทั้งหมด',can_manage_users:'จัดการ User',can_export:'Export ข้อมูล',can_preview_docs:'Preview เนื้อหาเอกสาร'}[p]||p;}

// ===================================================================
// GOOGLE DRIVE CONFIG
// ===================================================================
function getGDriveConfig(){return store.getObj(K.gdrive)||{enabled:false,clientId:'',folderId:'',folderName:''};}
function saveGDriveConfig(cfg){store.setObj(K.gdrive,cfg);}

async function uploadDocToGoogleDrive(doc){
  const cfg=getGDriveConfig();
  if(!cfg.enabled||!cfg.clientId){showToast('ยังไม่ได้ตั้งค่า Google Drive','error');return;}
  showToast('กำลังเชื่อมต่อ Google Drive...');
  try{
    const token=await new Promise((resolve,reject)=>{
      if(typeof google==='undefined'){reject(new Error('Google API ยังโหลดไม่เสร็จ'));return;}
      google.accounts.oauth2.initTokenClient({
        client_id:cfg.clientId,
        scope:'https://www.googleapis.com/auth/drive.file',
        callback:(resp)=>{if(resp.error)reject(new Error(resp.error));else resolve(resp.access_token);}
      }).requestAccessToken();
    });
    const docJson=JSON.stringify(doc,null,2);
    const blob=new Blob([docJson],{type:'application/json'});
    const meta={name:`${doc.id}_${doc.title}.json`,parents:cfg.folderId?[cfg.folderId]:[]};
    const form=new FormData();
    form.append('metadata',new Blob([JSON.stringify(meta)],{type:'application/json'}));
    form.append('file',blob);
    const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{
      method:'POST',headers:{Authorization:'Bearer '+token},body:form});
    const data=await res.json();
    if(data.id){
      showToast('อัพโหลดไปยัง Google Drive เรียบร้อย ✓');
      const docs=getDocs();const idx=docs.findIndex(d=>d.id===doc.id);
      if(idx>=0){docs[idx].driveId=data.id;docs[idx].driveUrl=data.webViewLink;saveDocs(docs);_apiSync('PATCH','/api/docs/'+doc.id+'/drive',{driveId:data.id,driveUrl:data.webViewLink});}
      if(data.webViewLink)window.open(data.webViewLink,'_blank');
    } else {showToast('อัพโหลดไม่สำเร็จ: '+(data.error?.message||'ไม่ทราบสาเหตุ'),'error');}
  }catch(e){showToast('เกิดข้อผิดพลาด: '+e.message,'error');}
}

// ─── Drive helper: get OAuth token ────────────────────────────────
async function getDriveToken(clientId){
  return new Promise((resolve,reject)=>{
    if(typeof google==='undefined'){reject(new Error('Google API ยังโหลดไม่เสร็จ'));return;}
    google.accounts.oauth2.initTokenClient({
      client_id:clientId,
      scope:'https://www.googleapis.com/auth/drive.file',
      callback:(resp)=>{if(resp.error)reject(new Error(resp.error));else resolve(resp.access_token);}
    }).requestAccessToken();
  });
}

// ─── Drive helper: upload single file ─────────────────────────────
async function uploadFileToDrive(att, token, cfg){
  // att = {name, type, size, base64}
  const res = await fetch(att.base64);
  const blob = await res.blob();
  const meta = {name: att.name, parents: cfg.folderId ? [cfg.folderId] : []};
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)],{type:'application/json'}));
  form.append('file', blob);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{
    method:'POST', headers:{Authorization:'Bearer '+token}, body:form
  });
  const data = await r.json();
  return data.id ? {id:data.id, webViewLink:data.webViewLink} : null;
}

// ─── Cleanup expired Drive files (called on login) ─────────────────
async function cleanupExpiredDriveFiles(){
  const cfg = getGDriveConfig();
  if(!cfg.enabled||!cfg.clientId) return;
  try {
    const expired = await apiCall('GET','/api/docs/expired-drive-ids');
    if(!expired||!expired.length) return;
    // Collect all Drive file IDs to delete
    const toDelete = [];
    expired.forEach(e=>{
      if(e.driveId) toDelete.push(e.driveId);
      if(e.attachmentDriveIds) toDelete.push(...e.attachmentDriveIds);
    });
    if(!toDelete.length) return;
    const token = await getDriveToken(cfg.clientId);
    for(const fileId of toDelete){
      try {
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`,{
          method:'DELETE', headers:{Authorization:'Bearer '+token}
        });
      } catch(_){}
    }
    console.log(`[Drive Cleanup] Deleted ${toDelete.length} Drive files`);
  } catch(e){ console.warn('[Drive Cleanup]', e.message); }
}

// ─── Admin: delete a document ──────────────────────────────────────
async function deleteDoc(id){
  const doc = getDocById(id);
  if(!confirm(`ลบเอกสาร "${doc?.title||id}" ?
ไม่สามารถกู้คืนได้`)) return;
  // Try delete Drive files first (if user has token)
  if(doc?.attachments?.some(a=>a.driveId)){
    const cfg = getGDriveConfig();
    if(cfg.enabled&&cfg.clientId){
      try {
        const token = await getDriveToken(cfg.clientId);
        for(const att of doc.attachments){
          if(att.driveId){
            await fetch(`https://www.googleapis.com/drive/v3/files/${att.driveId}`,{
              method:'DELETE', headers:{Authorization:'Bearer '+token}
            });
          }
        }
      } catch(_){}
    }
  }
  const r = await apiCall('DELETE','/api/docs/'+id);
  if(r?.ok){
    showToast('ลบเอกสารเรียบร้อย');
    adminSelectedDoc=null;
    // Socket will push doc_update → cache update → re-render automatically
    // Only do manual sync+render if socket is offline
    if(!_socket?.connected){
      await syncFromServer();
      renderAdminTab('docs');
    }
  } else {
    showToast(r?.error||'ลบไม่สำเร็จ — กรุณาลองใหม่','error');
  }
}

// ─── Admin: clear another user's passkey ──────────────────────────
// ─── Admin: set passkey for another user ──────────────────────────
function adminSetPasskeyModal(username){
  openModal('🔑 ตั้ง Passkey ให้ '+username,
    `<div class="form-group"><label>Passkey ใหม่ (6 หลัก)</label>
     <input id="admin-new-passkey" type="password" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center;font-size:20px;"></div>
     <div style="font-size:12px;color:var(--muted);margin-top:4px;">Admin สามารถตั้ง Passkey ให้ผู้ใช้ได้โดยไม่ต้องยืนยัน</div>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button>
     <button class="btn-primary" onclick="doAdminSetPasskey('${username}')">🔑 ตั้ง Passkey</button>`);
}
async function doAdminSetPasskey(username){
  const newPasskey=(document.getElementById('admin-new-passkey')?.value||'').trim();
  if(!newPasskey||!/^\d{6}$/.test(newPasskey)){ showToast('Passkey ต้องเป็นตัวเลข 6 หลัก','error'); return; }
  const res=await apiCall('PUT',`/api/users/${username}/admin-reset-passkey`,{newPasskey});
  closeModal();
  if(res?.ok){ showToast(`ตั้ง Passkey ให้ ${username} เรียบร้อย ✅`,'success'); }
  else { showToast('ไม่สำเร็จ','error'); }
}

async function adminClearPasskey(username){
  if(!confirm(`ล้าง Passkey ของ @${username} ?
ผู้ใช้จะต้องตั้งใหม่เอง`)) return;
  const r = await apiCall('DELETE','/api/auth/passkey/'+username);
  if(r?.ok){ showToast('ล้าง Passkey เรียบร้อย'); renderAdminTab('members'); }
  else showToast('ล้างไม่สำเร็จ','error');
}

// ─── Check passkey status via API (has_passkey field) ─────────────
async function checkPasskeyStatus(username, elId){
  const el = document.getElementById(elId);
  if(!el) return;
  const r = await apiCall('GET','/api/users/'+username+'/passkey-status');
  if(!r) return;
  el.innerHTML = r.hasPasskey
    ? '<span class="passkey-chip set">✅ ตั้งแล้ว</span>'
    : '<span class="passkey-chip unset">❌ ยังไม่ได้ตั้ง</span>';
}

// ===================================================================
// FILE ATTACHMENTS
// ===================================================================
// ─── Cloudinary upload helper ────────────────────────────────────────────────
async function uploadToCloudinary(att) {
  // att = { name, type, size, base64 }  (base64 is a data URI)
  try {
    const res = await apiCall('POST', '/api/upload', { dataUri: att.base64, fileName: att.name });
    if (res && res.cloudinaryUrl) {
      return { name: att.name, type: att.type, size: att.size,
               cloudinaryUrl: res.cloudinaryUrl, cloudinaryPublicId: res.cloudinaryPublicId };
    }
  } catch(e) { console.warn('[uploadToCloudinary]', e); }
  // Fallback: keep base64 if Cloudinary unavailable
  return { name: att.name, type: att.type, size: att.size, base64: att.base64 };
}

let wzAttachments=[];

function handleFileDrop(e){
  e.preventDefault();
  document.getElementById('upload-zone')?.classList.remove('dragover');
  handleFileSelect(e.dataTransfer.files);
}
function handleFileSelect(files){
  const allowedExts=['png','bmp','jpg','jpeg','xls','xlsx','pdf','md','txt'];
  const MAX=10*1024*1024;
  const fileArr=Array.from(files);
  let loaded=0;
  const total=fileArr.length;
  if(total===0) return;
  if(total>1) showToast(`กำลังโหลด ${total} ไฟล์...`);
  fileArr.forEach(file=>{
    const ext=(file.name.split('.').pop()||'').toLowerCase();
    if(!allowedExts.includes(ext)){
      showToast(`ไม่รองรับ .${ext}`,'error');
      loaded++;return;
    }
    if(file.size>MAX){
      showToast(`${file.name} ใหญ่เกิน 10MB`,'error');
      loaded++;return;
    }
    const reader=new FileReader();
    reader.onload=ev=>{
      wzAttachments.push({name:file.name,type:file.type||'application/octet-stream',size:file.size,base64:ev.target.result});
      loaded++;
      renderAttachmentList('attachment-list');
      if(loaded===total){
        showToast(total===1?`แนบไฟล์ ${file.name} แล้ว`:`แนบไฟล์ ${total} ไฟล์เรียบร้อย`);
      }
    };
    reader.onerror=()=>{showToast(`อ่านไฟล์ ${file.name} ไม่สำเร็จ`,'error');loaded++;};
    reader.readAsDataURL(file);
  });
}
function formatFileSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB';}
function fileTypeIcon(name){const e=(name.split('.').pop()||'').toLowerCase();return{png:'🖼️',bmp:'🖼️',jpg:'🖼️',jpeg:'🖼️',xls:'📊',xlsx:'📊',pdf:'📄',md:'📝',txt:'📄'}[e]||'📎';}
function removeAttachment(i){wzAttachments.splice(i,1);renderAttachmentList('attachment-list');}
function renderAttachmentList(elId){
  const el=document.getElementById(elId);if(!el)return;
  el.innerHTML=wzAttachments.length===0?'':`<div style="font-size:11px;color:var(--muted);margin-bottom:4px;">ไฟล์แนบ (${wzAttachments.length} ไฟล์)</div>`+wzAttachments.map((a,i)=>`
  <div class="attachment-item">
    <span class="att-icon">${fileTypeIcon(a.name)}</span>
    <span class="att-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
    <span class="att-size">${formatFileSize(a.size)}</span>
    <button class="att-remove" onclick="removeAttachment(${i})" title="ลบ">✕</button>
  </div>`).join('');
}

function renderDocAttachments(doc){
  if(!doc.attachments||doc.attachments.length===0)return'';
  const items=doc.attachments.map(a=>{
    const actionBtn = a.cloudinaryUrl
      ? `<a class="att-view" href="${escapeHtml(a.cloudinaryUrl)}" target="_blank" download="${escapeHtml(a.name)}" onclick="event.stopPropagation()">⬇ ดาวน์โหลด</a>`
      : a.driveId
        ? `<a class="att-view" href="${escapeHtml(a.driveUrl||'#')}" target="_blank" onclick="event.stopPropagation()">🔗 Drive</a>`
        : a.base64
          ? `<a class="att-view" href="${escapeHtml(a.base64)}" download="${escapeHtml(a.name)}" onclick="event.stopPropagation()">⬇ ดาวน์โหลด</a>`
          : '';
    return `<div class="attachment-item">
    <span class="att-icon">${fileTypeIcon(a.name)}</span>
    <span class="att-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
    <span class="att-size">${formatFileSize(a.size)}</span>
    ${actionBtn}
  </div>`;
  }).join('');
  return`<div class="doc-content-area" style="margin-top:12px;">
    <div class="doc-content-header">📎 ไฟล์แนบ (${doc.attachments.length})</div>
    <div class="doc-content-body" style="padding:12px;"><div class="attachment-list">${items}</div></div>
  </div>`;
}

// ===================================================================
// COMMENTS
// ===================================================================
async function addComment(docId,text){
  if(!text.trim()){showToast('กรุณาพิมพ์ข้อความ','error');return;}
  const res=await apiCall('POST','/api/docs/'+docId+'/comments',{text:text.trim()});
  if(!res){showToast('ส่ง comment ไม่สำเร็จ','error');return;}
  await syncFromServer();
  const doc=getDocById(docId);
  const sec=document.getElementById('comment-section-'+docId);
  if(sec&&doc)sec.outerHTML=renderCommentSection(doc);
  showToast('ส่ง comment เรียบร้อย');
}

function renderCommentSection(doc){
  const comments=doc.comments||[];
  const threadHtml=comments.length===0?`<div class="no-comment">ยังไม่มีความคิดเห็น</div>`:
    comments.map(cm=>{
      const words=(cm.fullName||'?').trim().split(/\s+/).filter(Boolean);
      const ini=(words.length>=2?words[0][0]+words[words.length-1][0]:words[0]?words[0].slice(0,2):'??').toUpperCase();
      return`<div class="comment-item">
        <div class="comment-avatar">${escapeHtml(ini)}</div>
        <div class="comment-bubble">
          <div class="comment-meta">${escapeHtml(cm.fullName)} · ${formatDate(cm.createdAt)}</div>
          <div class="comment-text">${escapeHtml(cm.text)}</div>
        </div>
      </div>`;}).join('');
  return`<div class="comment-section" id="comment-section-${doc.id}">
    <div class="comment-section-title">💬 ความคิดเห็น${comments.length>0?' ('+comments.length+')':''}</div>
    <div class="comment-thread">${threadHtml}</div>
    <div class="comment-input-area">
      <textarea id="comment-input-${doc.id}" placeholder="พิมพ์ความคิดเห็น / ตอบกลับ..." rows="2" onkeydown="if(event.ctrlKey&&event.key==='Enter'){addComment('${doc.id}',this.value);this.value='';}"></textarea>
      <button class="btn-primary btn-sm" onclick="addComment('${doc.id}',document.getElementById('comment-input-${doc.id}').value);document.getElementById('comment-input-${doc.id}').value=''">ส่ง</button>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:4px;">Ctrl+Enter เพื่อส่ง</div>
  </div>`;
}

// ===================================================================
// NOTIFICATION SYSTEM
// ===================================================================
function getNotifs(){ return store.get(K.notifs); }
function saveNotifs(n){ store.set(K.notifs,n); }
function getMyNotifs(username){
  return getNotifs().filter(n=>n.toUsername===username||n.toUsername==='__all__')
    .sort((a,b)=>b.createdAt-a.createdAt);
}
function getUnreadCount(username){
  return getMyNotifs(username).filter(n=>!n.read).length;
}
async function addNotif({type,toUsername,fromUsername,fromFullName,message,docId,docTitle}){
  await apiCall('POST','/api/notifs',{id:'N-'+Date.now()+Math.random().toString(36).slice(2,5),
    type,toUsername,fromUsername,fromFullName,message,docId:docId||null,docTitle:docTitle||null,createdAt:Date.now()});
  await syncFromServer(); updateNotifBadge();
}
function markNotifRead(id){
  const notifs=getNotifs();const idx=notifs.findIndex(n=>n.id===id);
  if(idx>=0){notifs[idx].read=true;saveNotifs(notifs);}
}
async function markAllNotifsRead(){
  await apiCall('PATCH','/api/notifs/read-all');
  await syncFromServer(); updateNotifBadge();
}
function displayName(u){
  if(!u) return '';
  if(u.nickname) return '<strong>'+escapeHtml(u.nickname)+'</strong> <span style="font-size:0.85em;color:var(--muted);">'+escapeHtml(u.fullName)+'</span>';
  return escapeHtml(u.fullName);
}
function displayNamePlain(u){
  if(!u) return '';
  return u.nickname ? u.nickname+' '+u.fullName : u.fullName;
}

function notifIcon(type){return{admin_broadcast:'📢',doc_sent:'📨',doc_sent_log:'📤',doc_received:'✅',doc_received_log:'📥',doc_deleted:'🗑️',system:'ℹ️'}[type]||'🔔';}
function notifTypeLabel(type){return{admin_broadcast:'ประกาศจาก Admin',doc_sent:'ได้รับเอกสารใหม่',doc_sent_log:'คุณส่งเอกสาร',doc_received:'ผู้รับยืนยันรับแล้ว',doc_received_log:'คุณรับเอกสาร',doc_deleted:'เอกสารถูกลบ',system:'แจ้งเตือนระบบ'}[type]||'แจ้งเตือน';}

// Track which notif is currently open (email-style)
let _openNotifId = null;

async function forceRefreshNotifs(){
  const btn = document.getElementById('notifs-refresh-btn');
  if(btn){ btn.disabled=true; btn.textContent='🔄 โหลด...'; }
  try {
    const data = await apiCall('GET','/api/notifs');
    if(Array.isArray(data)){
      localStorage.setItem(K.notifs, JSON.stringify(data));
      _lastSyncTime = Date.now();
    }
  } catch(e){}
  renderNotifs();
}
function renderNotifs(){
  setPageTitle('กล่องจดหมาย','🔔');
  const _nstale = Date.now() - _lastSyncTime > 8000;
  if(_nstale){
    apiCall('GET','/api/notifs').then(data=>{
      if(Array.isArray(data)){
        localStorage.setItem(K.notifs, JSON.stringify(data));
        _lastSyncTime = Date.now();
        renderNotifs();
      }
    }).catch(()=>{});
  }
  const user = getCurrentUser();
  if(!user){ document.getElementById('page-body').innerHTML='<div class="empty-state">กรุณา Login ใหม่</div>'; return; }
  const myNotifs = getMyNotifs(user.username);
  const unreadCount = myNotifs.filter(n=>!n.read).length;
  const isAdmin = hasAdminAccess(user);
  // DO NOT auto-mark-all-read — only mark when user clicks

  function notifRowHtml(n){
    const isOpen = _openNotifId === n.id;
    const readBadge = n.read
      ? `<span class="notif-read-badge">✓ อ่านแล้ว</span>`
      : `<span class="notif-unread-badge">● ใหม่</span>`;
    const detailHtml = isOpen ? `
      <div class="notif-detail-panel">
        <div class="notif-detail-meta">
          ${notifIcon(n.type)} <strong>${notifTypeLabel(n.type)}</strong>
          <span style="margin-left:auto;font-size:11px;color:var(--muted);">${formatDate(n.createdAt)}</span>
        </div>
        ${n.fromFullName?`<div class="notif-detail-from">จาก: <strong>${escapeHtml(n.fromFullName)}</strong></div>`:''}
        <div class="notif-detail-body">${escapeHtml(n.message)}</div>
        ${n.docId?`<div style="margin-top:12px;"><button class="btn-primary btn-sm" onclick="event.stopPropagation();openDocPreviewModal('${n.docId}')">👁 ดูเอกสาร</button></div>`:''}
      </div>` : '';
    return `<div class="notif-item${n.read?' read':' unread'}${isOpen?' notif-open':''}" id="notif-row-${n.id}" onclick="openNotifItem('${n.id}')">
      <div class="notif-row-top">
        <div class="notif-icon-wrap">${notifIcon(n.type)}</div>
        <div class="notif-body">
          <div class="notif-row-header">
            <span class="notif-type-label">${notifTypeLabel(n.type)}</span>
            ${readBadge}
          </div>
          <div class="notif-message${n.read?'':' notif-message-bold'}">${escapeHtml(n.message)}</div>
          <div class="notif-time">${formatDate(n.createdAt)}${n.fromFullName?' · '+escapeHtml(n.fromFullName):''}</div>
        </div>
        <div class="notif-chevron">${isOpen?'▲':'▼'}</div>
      </div>
      ${detailHtml}
    </div>`;
  }

  const listHtml = myNotifs.length===0
    ? '<div class="empty-state"><p>ยังไม่มีการแจ้งเตือน</p></div>'
    : `<div class="notif-list">${myNotifs.map(notifRowHtml).join('')}</div>`;

  document.getElementById('page-body').innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <span style="font-size:13px;color:var(--muted);">
        ทั้งหมด <strong style="color:var(--text)">${myNotifs.length}</strong> รายการ
        ${unreadCount>0?`· <strong style="color:var(--accent-light)">ยังไม่อ่าน ${unreadCount}</strong>`:''}
      </span>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        ${unreadCount>0?`<button class="btn-outline btn-sm" onclick="markAllAndRender()">✓ อ่านทั้งหมด</button>`:''}
        ${isAdmin?'<button class="btn-primary btn-sm" onclick="openBroadcastModal()">📢 ส่งประกาศ</button>':''}
        <button onclick="forceRefreshNotifs()" id="notifs-refresh-btn" class="refresh-pill-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          ${_lastSyncTime>0?Math.round((Date.now()-_lastSyncTime)/1000)+' วิที่แล้ว':'รีเฟรช'}
        </button>
      </div>
    </div>${listHtml}`;
}

async function openNotifItem(id){
  const wasOpen = _openNotifId === id;
  _openNotifId = wasOpen ? null : id;
  // Mark as read in DB + local cache
  if(!wasOpen){
    const notifs = getNotifs();
    const idx = notifs.findIndex(n=>n.id===id);
    if(idx>=0 && !notifs[idx].read){
      notifs[idx].read = true;
      localStorage.setItem(K.notifs, JSON.stringify(notifs));
      updateNotifBadge();
      // Fire-and-forget API call
      apiCall('PATCH', '/api/notifs/'+id+'/read').catch(()=>{});
    }
  }
  renderNotifs();
}

async function markAllAndRender(){
  const notifs = getNotifs();
  notifs.forEach(n=>{ n.read=true; });
  localStorage.setItem(K.notifs, JSON.stringify(notifs));
  updateNotifBadge();
  await apiCall('PATCH','/api/notifs/read-all');
  renderNotifs();
}

function openBroadcastModal(){
  openModal('📢 ส่งประกาศถึงทุกคน',
    `<div class="form-group"><label>ข้อความประกาศ</label>
     <textarea id="broadcast-msg" class="recv-note-area" rows="4" placeholder="พิมพ์ข้อความประกาศ..."></textarea></div>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button>
     <button class="btn-primary" onclick="sendBroadcast()">📢 ส่งประกาศ</button>`);
}
async function sendBroadcast(){
  const msg=(document.getElementById('broadcast-msg')?.value||'').trim();
  if(!msg){showToast('กรุณาพิมพ์ข้อความ','error');return;}
  const res=await apiCall('POST','/api/notifs/broadcast',{message:msg});
  if(!res||res.error){showToast(res?.error||'ส่งประกาศไม่สำเร็จ','error');return;}
  await syncFromServer(); closeModal(); showToast('ส่งประกาศเรียบร้อย ✓'); renderNotifs();
}

// ===================================================================
// PREVIEW & STAT MODALS
// ===================================================================
function canPreviewDocs(u){
  if(!u) return false;
  if(u.role==='admin') return true;
  const role=getRoleById(u.role);
  return !!(role&&role.permissions&&role.permissions.can_preview_docs);
}

async function openDocPreviewModal(docId){
  let doc = await apiCall('GET', '/api/docs/'+docId);
  if(!doc) doc = getDocById(docId);
  if(!doc){ showToast('ไม่พบเอกสาร หรืออาจถูกลบไปแล้ว','error'); return; }

  // ── Avatar initials helper ────────────────────────────────────────────────
  function avatarHtml(name, color='blue'){
    const init=(name||'?').split(' ').map(w=>w[0]).filter(Boolean).join('').slice(0,2).toUpperCase();
    const bg={blue:'#6366f1',green:'#10b981',amber:'#f59e0b',red:'#ef4444',muted:'#94a3b8'}[color]||'#6366f1';
    return `<span class="tl-avatar" style="background:${bg};">${init}</span>`;
  }
  // ── Format date/time split ────────────────────────────────────────────────
  function fmtDT(ts){
    if(!ts) return '';
    const d=new Date(ts);
    const date=`${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()+543}`;
    const time=`${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    return `<span class="tl-date-row"><span class="tl-date-icon">📅</span>${date}<span class="tl-date-icon" style="margin-left:8px;">🕐</span>${time}</span>`;
  }

  // ── Build timeline steps ──────────────────────────────────────────────────
  const received = doc.status === 'received';
  const comments = doc.comments || [];

  // Collect timeline events: created, [comments], received
  const events = [];

  // Step 1: ส่งเอกสาร (always done)
  events.push({
    state: 'done',
    title: 'ส่งเอกสาร',
    dept:  escapeHtml(doc.senderDepartment || ''),
    name:  escapeHtml(doc.senderFullName || ''),
    color: 'blue',
    note:  `รหัส: <code style="font-size:11px;color:var(--blue)">${escapeHtml(doc.id)}</code> · ${priorityBadge(doc.priority)}`,
    ts:    doc.createdAt
  });

  // Step 2: ผู้รับได้รับการแจ้งเตือน (always done once sent)
  const recipientName = doc.recipientFullName || doc.recipientDepartment || '—';
  events.push({
    state: 'done',
    title: 'แจ้งผู้รับ',
    dept:  doc.recipientType==='department' ? '(ทั้งแผนก)' : '',
    name:  escapeHtml(recipientName),
    color: 'amber',
    note:  '',
    ts:    doc.createdAt
  });

  // Intermediate comments (filter out the auto "ยืนยันรับเอกสาร" one)
  const midComments = comments.filter(c => !c.text.startsWith('✅ ยืนยันรับเอกสาร'));
  midComments.forEach(c => {
    events.push({
      state: 'done',
      title: 'ความคิดเห็น',
      dept:  '',
      name:  escapeHtml(c.fullName || c.username || ''),
      color: 'muted',
      note:  `<em style="color:var(--text);">"${escapeHtml(c.text)}"</em>`,
      ts:    c.createdAt
    });
  });

  // Step 3: รับเอกสาร
  if(received){
    const recComment = comments.find(c => c.text.startsWith('✅ ยืนยันรับเอกสาร'));
    const note2 = recComment ? `<em>"${escapeHtml(recComment.text)}"</em>` : '';
    events.push({
      state: 'done',
      title: 'รับเอกสารแล้ว',
      dept:  doc.storageLocation ? `📦 เก็บที่: ${escapeHtml(doc.storageLocation)}` : '',
      name:  escapeHtml(doc.receivedBy || recipientName),
      color: 'green',
      note:  note2,
      ts:    doc.receivedAt
    });
  } else {
    events.push({
      state: 'active',
      title: 'รอรับเอกสาร',
      dept:  '',
      name:  escapeHtml(recipientName),
      color: 'amber',
      note:  '<span style="font-size:11px;color:var(--muted);">ยังไม่ได้รับการยืนยัน</span>',
      ts:    null
    });
  }

  const timelineHtml = `<div class="doc-timeline">` +
    events.map((ev, i) => {
      const isLast = i === events.length - 1;
      const dotHtml = ev.state === 'done'
        ? `<div class="tl-dot tl-done-dot"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20,6 9,17 4,12"/></svg></div>`
        : `<div class="tl-dot tl-active-dot"><div class="tl-dot-inner"></div></div>`;
      return `<div class="tl-step${ev.state==='active'?' tl-step-active':''}">
        <div class="tl-node">
          ${dotHtml}
          ${!isLast?'<div class="tl-line"></div>':''}
        </div>
        <div class="tl-body">
          <div class="tl-title">${ev.title}</div>
          ${ev.dept?`<div class="tl-dept">${ev.dept}</div>`:''}
          <div class="tl-person">${avatarHtml(ev.name,ev.color)} <span>${ev.name}</span></div>
          ${ev.note?`<div class="tl-note">${ev.note}</div>`:''}
          ${ev.ts?fmtDT(ev.ts):''}
        </div>
      </div>`;
    }).join('') + `</div>`;

  // ── Attachments ───────────────────────────────────────────────────────────
  const attHtml = doc.attachments?.length ? `
    <div class="preview-section-block">
      <div class="preview-section-label">📎 ไฟล์แนบ (${doc.attachments.length})</div>
      <div class="attachment-list">${doc.attachments.map(a=>{
        const u=a.cloudinaryUrl||a.base64||a.driveUrl||'#';
        const extra=a.cloudinaryUrl||a.base64?`download="${escapeHtml(a.name)}"`:' target="_blank"';
        return `<div class="attachment-item"><span class="att-icon">${fileTypeIcon(a.name)}</span><span class="att-name">${escapeHtml(a.name)}</span><span class="att-size">${formatFileSize(a.size)}</span><a class="att-view" href="${escapeHtml(u)}" ${extra}>⬇</a></div>`;
      }).join('')}</div>
    </div>` : '';

  // ── Tabs layout ───────────────────────────────────────────────────────────
  const modalContent = `<div class="modal-scroll-body">
    <div class="preview-tabs">
      <button class="prev-tab active" onclick="switchPreviewTab('status',this)">📍 สถานะ</button>
      <button class="prev-tab" onclick="switchPreviewTab('content',this)">📄 เนื้อหา</button>
    </div>
    <div id="ptab-status">
      <div style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 0 8px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border);margin-bottom:14px;">
        <span>📋 <strong style="color:var(--text);">${escapeHtml(doc.id)}</strong></span>
        <span>${priorityBadge(doc.priority)}</span>
        <span>${received?'<span class="badge badge-received">รับแล้ว ✓</span>':'<span class="badge badge-pending">รอรับ</span>'}</span>
      </div>
      ${timelineHtml}
    </div>
    <div id="ptab-content" style="display:none;">
      <div class="preview-section-block">
        <div class="preview-section-label">📄 เนื้อหาเอกสาร</div>
        ${renderDocContent(doc)}
      </div>
      ${attHtml}
    </div>
  </div>`;

  openModal(escapeHtml(doc.title), modalContent,
    `<button class="btn-outline" onclick="closeModal()">ปิด</button>
     <button class="btn-primary" onclick="closeModal();navigate('qr',{docId:'${doc.id}'})">🔗 ดูเต็ม / QR →</button>`, 'lg');
}

function switchPreviewTab(tab, btn){
  document.querySelectorAll('.prev-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('ptab-status').style.display = tab==='status'?'':'none';
  document.getElementById('ptab-content').style.display = tab==='content'?'':'none';
}

function openStatModal(type){
  const user=getCurrentUser(); if(!canPreviewDocs(user)) return;
  const allDocs=getDocs();const allUsers=getUsers();const now=new Date();
  let title='',content='';
  if(type==='members'){
    title=`👥 สมาชิกทั้งหมด (${allUsers.length} คน)`;
    const rows=allUsers.map(u=>`<tr>
      <td><div style="font-weight:600;font-size:13px;">${escapeHtml(u.fullName)}</div><div style="font-size:11px;color:var(--muted)">@${escapeHtml(u.username)}</div></td>
      <td>${escapeHtml(u.department)}</td>
      <td style="font-size:12px;">${escapeHtml(u.location||'—')}</td>
      <td><span class="badge ${hasAdminAccess(u)?'badge-admin':'badge-user'}">${getRoleName(u.role)}</span></td>
      <td style="font-size:11px;color:var(--muted)">${formatDateShort(u.createdAt)}</td>
    </tr>`).join('');
    content=`<div class="modal-scroll-body"><table class="data-table"><thead><tr><th>ชื่อ</th><th>แผนก</th><th>สถานที่</th><th>Role</th><th>สมัครเมื่อ</th></tr></thead><tbody>${rows||'<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">ไม่มีสมาชิก</td></tr>'}</tbody></table></div>`;
  } else if(type==='pending'){
    const pd=allDocs.filter(d=>d.status==='pending').sort((a,b)=>b.createdAt-a.createdAt);
    title=`⏳ รอรับเอกสาร (${pd.length} รายการ)`;
    content=`<div class="modal-scroll-body">${pd.length===0?'<div style="text-align:center;color:var(--muted);padding:30px;">✅ ไม่มีเอกสารค้าง</div>':
      pd.map(d=>`<div class="doc-card" style="margin-bottom:8px;">
        <div class="doc-icon warn"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>
        <div class="doc-info"><div class="doc-title">${escapeHtml(d.title)}</div>
        <div class="doc-meta">จาก: ${escapeHtml(d.senderFullName)} → ${escapeHtml(d.recipientFullName||d.recipientDepartment||'')} · ${formatDateShort(d.createdAt)}</div></div>
        ${priorityBadge(d.priority)}
        <button class="btn-outline btn-sm" onclick="openDocPreviewModal('${d.id}')">👁 ดู</button>
      </div>`).join('')}</div>`;
  } else if(type==='sent'){
    const sd=allDocs.filter(d=>{const dm=new Date(d.createdAt);return dm.getMonth()===now.getMonth()&&dm.getFullYear()===now.getFullYear();}).sort((a,b)=>b.createdAt-a.createdAt);
    title=`✅ ส่งแล้วเดือนนี้ (${sd.length} รายการ)`;
    content=`<div class="modal-scroll-body">${sd.length===0?'<div style="text-align:center;color:var(--muted);padding:30px;">ยังไม่มีเอกสารเดือนนี้</div>':
      sd.map(d=>`<div class="doc-card" style="margin-bottom:8px;">
        <div class="doc-icon${d.status==='received'?' ok':' warn'}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>
        <div class="doc-info"><div class="doc-title">${escapeHtml(d.title)}</div>
        <div class="doc-meta">${escapeHtml(d.senderFullName)} → ${escapeHtml(d.recipientFullName||d.recipientDepartment||'')} · ${formatDateShort(d.createdAt)}</div></div>
        ${d.status==='received'?'<span class="badge badge-received">รับแล้ว</span>':'<span class="badge badge-pending">รอรับ</span>'}
        <button class="btn-outline btn-sm" onclick="openDocPreviewModal('${d.id}')">👁 ดู</button>
      </div>`).join('')}</div>`;
  } else if(type==='all'){
    const sorted=[...allDocs].sort((a,b)=>b.createdAt-a.createdAt);
    title=`📁 เอกสารทั้งหมด (${sorted.length} รายการ)`;
    content=`<div class="modal-scroll-body">${sorted.length===0?'<div style="text-align:center;color:var(--muted);padding:30px;">ยังไม่มีเอกสาร</div>':
      sorted.map(d=>`<div class="doc-card" style="margin-bottom:8px;">
        <div class="doc-icon${d.status==='received'?' ok':' warn'}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg></div>
        <div class="doc-info"><div class="doc-title">${escapeHtml(d.title)}</div>
        <div class="doc-meta">${escapeHtml(d.senderFullName)} → ${escapeHtml(d.recipientFullName||d.recipientDepartment||'')} · ${formatDateShort(d.createdAt)}</div></div>
        ${d.status==='received'?'<span class="badge badge-received">รับแล้ว</span>':'<span class="badge badge-pending">รอรับ</span>'}
        <button class="btn-outline btn-sm" onclick="openDocPreviewModal('${d.id}')">👁 ดู</button>
      </div>`).join('')}</div>`;
  }
  openModal(title,content,'<button class="btn-outline" onclick="closeModal()">ปิด</button>','lg');
}

// ===================================================================
// AUTH
// ===================================================================
function getUsers(){ return store.get(K.users); }
function saveUsers(u){ store.set(K.users,u); }
function findUser(username){ return getUsers().find(u=>u.username===username.toLowerCase().trim()); }
function getSession(){ return store.getObj(K.session); }
function getCurrentUser(){ const s=getSession(); return s?findUser(s.username):null; }

async function handleRegister(){
  const username=document.getElementById('r-username').value.trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  const email=document.getElementById('r-email').value.trim();
  const fullName=document.getElementById('r-fullname').value.trim();
  const nickname=document.getElementById('r-nickname')?.value.trim()||'';
  const department=document.getElementById('r-dept').value.trim();
  const location=document.getElementById('r-location').value;
  const password=document.getElementById('r-password').value;
  const confirm=document.getElementById('r-confirm').value;
  showAuthAlert('','');
  if(!username||!email||!fullName||!department||!location||!password){ showAuthAlert('กรุณากรอกข้อมูลให้ครบทุกช่อง','error'); return; }
  if(username.length<3||username.length>32||!/^[a-z0-9]+$/.test(username)){ showAuthAlert('ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษและตัวเลขเท่านั้น (a-z, 0-9) ความยาว 3-32 ตัว','error'); return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ showAuthAlert('รูปแบบอีเมลไม่ถูกต้อง','error'); return; }
  if(password.length<6){ showAuthAlert('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร','error'); return; }
  if(password!==confirm){ showAuthAlert('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน','error'); return; }
  const regBtn=document.querySelector('#form-register .btn-primary');
  if(regBtn){regBtn.disabled=true;regBtn.textContent='กำลังสมัคร...';}
  showAuthAlert('กำลังสมัคร...','');
  // Use raw fetch to properly capture server error messages (apiCall returns null on error)
  let res, regErrMsg;
  try {
    const r = await fetch('/api/auth/register', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username,fullName,nickname,email,department,location,password})
    });
    const data = await r.json();
    if(!r.ok){ regErrMsg = data.error || 'สมัครไม่สำเร็จ'; } else { res = data; }
  } catch(e){ regErrMsg = 'เชื่อมต่อ server ไม่ได้'; }
  if(regBtn){regBtn.disabled=false;regBtn.textContent='สมัครสมาชิก';}
  if(regErrMsg||!res){ showAuthAlert(regErrMsg||'สมัครไม่สำเร็จ','error'); return; }
  // Auto-login after registration
  _jwt = res.token; sessionStorage.setItem(_JWT_KEY, _jwt);
  // Seed K.users immediately — getCurrentUser() must never return null even if sync fails
  const regUserData = res.user || { username, fullName, nickname, email, department, location, role: res.role };
  seedCurrentUser(regUserData);
  showAuthAlert('กำลังโหลดข้อมูล...','');
  await syncFromServer();
  // Build user from cache (may be richer after sync); fall back to seeded data
  const regUser = getUsers().find(u=>u.username===username) || regUserData;
  store.setObj(K.session,{username:regUser.username,loginAt:Date.now()});
  saveRememberAuth(_jwt, regUser.username); // remember this device for 24h
  connectSocket(username);
  enterDashboard(regUser);
  // Show passkey setup modal after dashboard loads
  setTimeout(()=>openPasskeySetupModal(), 500);
}

async function handleLogin(){
  const username=document.getElementById('l-username').value.trim().toLowerCase();
  const password=document.getElementById('l-password').value;
  showAuthAlert('','');
  if(!username||!password){ showAuthAlert('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน','error'); return; }
  const loginBtn=document.querySelector('#form-login .btn-primary');
  if(loginBtn){loginBtn.disabled=true;loginBtn.textContent='กำลังเข้าสู่ระบบ...';}
  showAuthAlert('กำลังเข้าสู่ระบบ...','');
  // Raw fetch to capture exact server error message
  let res, loginErr;
  try {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username,password})
    });
    const data = await r.json();
    if(!r.ok){ loginErr = data.error || 'เข้าสู่ระบบไม่สำเร็จ'; } else { res = data; }
  } catch(e){ loginErr = 'เชื่อมต่อ server ไม่ได้'; }
  if(loginBtn){loginBtn.disabled=false;loginBtn.textContent='เข้าสู่ระบบ';}
  if(loginErr||!res){ showAuthAlert(loginErr||'เข้าสู่ระบบไม่สำเร็จ','error'); return; }
  _jwt = res.token; sessionStorage.setItem(_JWT_KEY, _jwt);
  // Seed K.users immediately — getCurrentUser() must never return null even if sync fails
  if (res.user) seedCurrentUser(res.user);
  showAuthAlert('กำลังโหลดข้อมูล...','');
  await syncFromServer();
  // Build user from cache (richer after sync); fall back to server response
  const user = getUsers().find(u=>u.username===username) || res.user;
  if(!user){ showAuthAlert('ไม่พบข้อมูลผู้ใช้ กรุณาลองใหม่อีกครั้ง','error'); return; }
  store.setObj(K.session,{username:user.username,loginAt:Date.now()});
  saveRememberAuth(_jwt, user.username); // remember this device for 24h
  connectSocket(username);
  enterDashboard(user);
}

function openPasskeySetupModal(){
  openModal('ตั้ง Passkey สำหรับเข้าระบบ',
    `<p style="font-size:13px;color:var(--muted);margin-bottom:14px;">Passkey 6 หลัก ใช้แทนรหัสผ่านสำหรับยืนยันตัวตนได้อย่างรวดเร็ว</p>
     <div class="form-group">
       <label>Passkey 6 หลัก</label>
       <input type="number" id="passkey-input" maxlength="6" placeholder="กรอกตัวเลข 6 หลัก" oninput="if(this.value.length>6)this.value=this.value.slice(0,6)" style="letter-spacing:4px;font-size:18px;text-align:center;">
     </div>
     <div class="form-group">
       <label>ยืนยัน Passkey</label>
       <input type="number" id="passkey-confirm" maxlength="6" placeholder="กรอกซ้ำอีกครั้ง" oninput="if(this.value.length>6)this.value=this.value.slice(0,6)" style="letter-spacing:4px;font-size:18px;text-align:center;">
     </div>`,
    `<button class="btn-outline" onclick="closeModal()">ข้ามไปก่อน</button>
     <button class="btn-primary" onclick="setupPasskey()">🔑 ตั้ง Passkey</button>`);
}

async function setupPasskey(){
  const val = (document.getElementById('passkey-input')?.value||'').trim();
  const confirm = (document.getElementById('passkey-confirm')?.value||'').trim();
  if(!/^\d{6}$/.test(val)){ showToast('Passkey ต้องเป็นตัวเลข 6 หลักเท่านั้น','error'); return; }
  if(val!==confirm){ showToast('Passkey ทั้งสองช่องไม่ตรงกัน','error'); return; }
  const res = await apiCall('POST','/api/auth/passkey-setup',{passkey:val});
  if(!res||res.error){ showToast(res?.error||'ตั้ง Passkey ไม่สำเร็จ','error'); return; }
  closeModal();
  showToast('ตั้ง Passkey เรียบร้อยแล้ว ✓');
}

async function handlePasskeyLogin(){
  const passkey = (document.getElementById('pk-passkey')?.value||'').trim();
  if(!passkey||passkey.length!==6){ showAuthAlert('กรุณากรอก Passkey 6 หลักให้ครบ','error'); return; }
  if(!/^\d{6}$/.test(passkey)){ showAuthAlert('Passkey ต้องเป็นตัวเลข 6 หลัก','error'); return; }
  // Clear any stale session/remember-me before fresh passkey login
  _jwt = null; sessionStorage.removeItem(_JWT_KEY);
  localStorage.removeItem(K.session);
  clearRememberAuth();
  const btn = document.querySelector('#passkey-section .btn-outline');
  // visual feedback on pin digits
  document.querySelectorAll('.pin-digit').forEach(el=>{ el.style.opacity='0.5'; });
  const res = await apiCall('POST','/api/auth/passkey-only',{passkey});
  document.querySelectorAll('.pin-digit').forEach(el=>{ el.style.opacity='1'; });
  if(!res||res.error){
    showAuthAlert(res?.error||'Passkey ไม่ถูกต้อง','error');
    // shake animation + clear
    document.querySelectorAll('.pin-digit').forEach(el=>{ el.value=''; el.classList.remove('filled'); });
    document.getElementById('pk-passkey').value='';
    document.querySelectorAll('.pin-digit')[0]?.focus();
    return;
  }
  _jwt = res.token;
  sessionStorage.setItem(_JWT_KEY, _jwt);
  // Seed K.users with passkey login response so getCurrentUser() works even if sync fails
  if (res.user) seedCurrentUser(res.user);
  await syncFromServer();
  const user = getUsers().find(u=>u.username===res.username) || res.user;
  if(!user){ showAuthAlert('ไม่พบข้อมูลผู้ใช้','error'); return; }
  store.setObj(K.session,{username:user.username,loginAt:Date.now()});
  saveRememberAuth(_jwt, user.username); // remember this device for 24h
  connectSocket(res.username);
  enterDashboard(user);
}

function handleLogout(){
  stopPolling();
  clearDocSession();
  clearRememberAuth();
  _jwt=null; sessionStorage.removeItem(_JWT_KEY);
  if(_socket){ _socket.disconnect(); _socket=null; }
  localStorage.removeItem(K.session);
  document.getElementById('dashboard').style.display='none';
  document.getElementById('auth-screen').style.display='flex';
  const _mbn=document.getElementById('mobile-bottom-nav');if(_mbn)_mbn.style.display='none';
  switchTab('login');
}

function showAuthAlert(msg,type){
  const el=document.getElementById('auth-alert');
  if(!msg){ el.style.display='none'; return; }
  el.textContent=msg; el.className='auth-alert '+type; el.style.display='block';
}
function switchTab(tab){
  // Passkey is default login method; password is secondary
  const pkSec=document.getElementById('passkey-section');
  const loginForm=document.getElementById('form-login');
  const regForm=document.getElementById('form-register');
  if(tab==='login'){
    pkSec.style.display='block';
    loginForm.style.display='none';
    regForm.style.display='none';
  } else {
    pkSec.style.display='none';
    loginForm.style.display='none';
    regForm.style.display='block';
    // Populate department dropdown from cache
    // Load dept + location from public API (no JWT needed on register screen)
    ensureLocsLoaded().then(()=>{
      const deptSel=document.getElementById('r-dept');
      if(deptSel){
        const depts=getDepartments();
        const cur=deptSel.value;
        deptSel.innerHTML=`<option value="">-- เลือกแผนก --</option>`+
          depts.map(d=>`<option value="${escapeHtml(d)}"${cur===d?' selected':''}>${escapeHtml(d)}</option>`).join('');
      }
      const locSel=document.getElementById('r-location');
      if(locSel){
        const locs=getLocations();
        const curL=locSel.value;
        locSel.innerHTML=`<option value="">-- เลือกสถานที่ --</option>`+
          locs.map(l=>`<option value="${escapeHtml(l)}"${curL===l?' selected':''}>${escapeHtml(l)}</option>`).join('');
      }
    });
  }
  document.getElementById('tab-login').className='tab-btn'+(tab==='login'?' active':'');
  document.getElementById('tab-register').className='tab-btn'+(tab==='register'?' active':'');
  document.getElementById('auth-alert').innerHTML='';
  // Reset PIN
  document.querySelectorAll('.pin-digit').forEach(el=>{ el.value=''; el.classList.remove('filled'); });
  const hid=document.getElementById('pk-passkey'); if(hid) hid.value='';
}

function togglePasskeySection(){
  const pkSec=document.getElementById('passkey-section');
  const loginForm=document.getElementById('form-login');
  const isPasskey = pkSec.style.display!=='none';
  if(isPasskey){
    // switch to password
    pkSec.style.display='none';
    loginForm.style.display='block';
    // clear PIN inputs
    document.querySelectorAll('.pin-digit').forEach(el=>{ el.value=''; el.classList.remove('filled'); });
    document.getElementById('pk-passkey').value='';
    setTimeout(()=>document.getElementById('l-username')?.focus(), 50);
  } else {
    // switch to passkey
    pkSec.style.display='block';
    loginForm.style.display='none';
    // pre-fill username if typed
    const uname=document.getElementById('l-username')?.value||'';
    if(uname) document.getElementById('pk-username').value=uname;
    setTimeout(()=>document.getElementById('pk-username')?.focus(), 50);
  }
}

// PIN digit input handler — auto-advance, collect into hidden field, auto-submit
function pinInput(el, idx){
  const v = el.value.replace(/[^0-9]/g,'');
  el.value = v.slice(-1);
  el.classList.toggle('filled', el.value!=='');
  if(el.value && idx < 5){
    const next = document.querySelectorAll('.pin-digit')[idx+1];
    if(next) next.focus();
  }
  const digits = Array.from(document.querySelectorAll('.pin-digit')).map(d=>d.value).join('');
  const hidden = document.getElementById('pk-passkey');
  if(hidden) hidden.value = digits;
  if(digits.length===6) setTimeout(handlePasskeyLogin, 180);
}

// Backspace: move to previous digit
function pinKeydown(el, idx){
  // Note: called as onkeydown so 'event' is the KeyboardEvent, el is the input
  const ev = event || window.event;
  if(ev?.key==='Backspace'&&!el.value&&idx>0){
    const prev = document.querySelectorAll('.pin-digit')[idx-1];
    if(prev){ prev.value=''; prev.classList.remove('filled'); prev.focus(); }
  }
}
document.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const t=document.getElementById('form-login').style.display!=='none'?'login':'register'; if(t==='login')handleLogin(); else handleRegister(); }});

// ===================================================================
// DOCUMENTS
// ===================================================================
function getDocs(){ return store.get(K.docs); }
function saveDocs(d){ store.set(K.docs,d); }
function getDocById(id){ return getDocs().find(d=>d.id===id); }

async function createDocument(data){
  const user=getCurrentUser();
  const id=generateDocId();
  const doc={
    id, title:data.title, contentType:data.contentType, content:data.content,
    senderUsername:user.username, senderFullName:user.fullName, senderDepartment:user.department, senderLocation:user.location,
    recipientType:data.recipientType, recipientUsername:data.recipientUsername||null,
    recipientDepartment:data.recipientDepartment||null, recipientFullName:data.recipientFullName||null,
    priority:data.priority||'normal', attachmentNote:data.attachmentNote||null,
    attachments:data.attachments||[], comments:[], driveId:null, driveUrl:null,
    createdAt:Date.now(), status:'pending', receivedAt:null, receivedBy:null, storageLocation:null,
    qrUrl:BASE_URL+'?doc='+id
  };
  const saved = await apiCall('POST','/api/docs',doc);
  if(!saved){ showToast('สร้างเอกสารไม่สำเร็จ กรุณาลองใหม่','error'); return null; }
  // OPTIMISTIC: เพิ่ม doc ใน cache ทันที → outbox/home แสดงผลไว
  try {
    const cur = getDocs();
    if(Array.isArray(cur) && !cur.find(d=>d.id===saved.id)){
      saveDocs([saved, ...cur]);
    }
  } catch(_){}
  updateInboxBadge();
  // Notify + sync ใน background (ไม่ block การแสดง success screen)
  (async () => {
    const allU = getUsers();
    if(doc.recipientType==='user'&&doc.recipientUsername){
      // Notification now created server-side in POST /api/docs
    } else if(doc.recipientType==='department'&&doc.recipientDepartment){
      for(const u2 of allU.filter(u=>u.department===doc.recipientDepartment&&u.username!==user.username)){
        // Notification now created server-side
      }
    }
    await syncFromServer();
    updateInboxBadge();
  })();
  return saved;
}

async function receiveDocument(id,location,note=''){
  const res = await apiCall('PATCH','/api/docs/'+id+'/receive',{storageLocation:location,note});
  if(!res){ showToast('บันทึกการรับเอกสารไม่สำเร็จ','error'); return; }
  await syncFromServer(); updateInboxBadge();
  navigate(currentPage);
}

function getInboxDocs(user){
  return getDocs().filter(d=>{
    if(d.recipientType==='user') return d.recipientUsername===user.username;
    if(d.recipientType==='department') return d.recipientDepartment===user.department;
    return false;
  });
}
function getOutboxDocs(user){ return getDocs().filter(d=>d.senderUsername===user.username); }

function updateInboxBadge(){
  const user=getCurrentUser(); if(!user)return;
  const pending=getInboxDocs(user).filter(d=>d.status==='pending').length;
  ['inbox-badge','mob-inbox-badge'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.style.display=pending>0?'inline':'none';el.textContent=pending;}
  });
}
function updateNotifBadge(){
  const user=getCurrentUser(); if(!user)return;
  const count=getUnreadCount(user.username);
  ['notif-badge','mob-notif-badge'].forEach(id=>{
    const el=document.getElementById(id);
    if(el){el.style.display=count>0?'inline':'none';el.textContent=count>9?'9+':count;}
  });
}

// ===================================================================
// DASHBOARD
// ===================================================================
function enterDashboard(user){
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('dashboard').style.display='flex';
  const mbnav=document.getElementById('mobile-bottom-nav');if(mbnav)mbnav.style.display='flex';
  const _dispName = user.nickname || user.fullName || '?';
  const initials = _dispName.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const _subName = user.nickname ? user.fullName : '';
  document.getElementById('sb-user-info').innerHTML=`
    <div class="sb-avatar">${initials}</div>
    <div class="sb-user-info">
      <div class="sb-user-name">${escapeHtml(_dispName)}</div>
      ${_subName ? `<div style="font-size:11px;color:var(--muted);margin-top:-2px;">${escapeHtml(_subName)}</div>` : ''}
      <div class="sb-user-meta">${escapeHtml(user.department||'')}</div>
      <span class="role-badge">${getRoleName(user.role)}</span>
    </div>`;
  document.getElementById('nav-admin').style.display=hasAdminAccess(user)?'flex':'none';
  updateInboxBadge();
  // Redirect to pending doc from QR link
  // init mobile bottom nav active state
  document.querySelectorAll('.mob-nav-item').forEach(el=>el.classList.remove('active'));
  const mhome=document.getElementById('mnav-home');if(mhome)mhome.classList.add('active');
  // init notification badge
  updateNotifBadge();
  // Cleanup expired Drive files in background (silent)
  setTimeout(()=>cleanupExpiredDriveFiles(), 3000);
  if(window._pendingDoc){
    const docId=window._pendingDoc; window._pendingDoc=null;
    navigate('qr',{docId}); return;
  }
  navigate('home');
}

let currentPage='home';
function navigate(page,params={}){
  currentPage=page;
  // Clear any running refresh countdown on page navigation
  if(_countdownInterval){ clearInterval(_countdownInterval); _countdownInterval=null; }
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  const navEl=document.getElementById('nav-'+page);
  if(navEl) navEl.classList.add('active');
  // update mobile bottom nav active state
  document.querySelectorAll('.mob-nav-item').forEach(el=>el.classList.remove('active'));
  const mNavMap={home:'mnav-home',inbox:'mnav-inbox',create:null,notifs:'mnav-notifs',outbox:null,profile:'mnav-profile'};
  const mEl=document.getElementById(mNavMap[page]||'');
  if(mEl) mEl.classList.add('active');
  document.getElementById('page-actions').innerHTML='';
  switch(page){
    case 'home':    renderHome(); break;
    case 'create':  initWizard(); break;
    case 'inbox':
      renderInbox(); // instant from cache
      if (getDocs().length === 0) {
        apiCall('GET','/api/docs/all-meta').then(data => {
          if (Array.isArray(data) && data.length > 0) {
            localStorage.setItem(K.docs, JSON.stringify(data));
            renderInbox();
          }
        }).catch(()=>{});
      }
      syncFromServer().then(()=>renderInbox()).catch(()=>{});
      break;
    case 'outbox':
      renderOutbox();
      // If K.docs is empty, fetch directly — don't wait for full sync
      if (getDocs().length === 0) {
        apiCall('GET','/api/docs/all-meta').then(data => {
          if (Array.isArray(data) && data.length > 0) {
            localStorage.setItem(K.docs, JSON.stringify(data));
            renderOutbox();
          }
        }).catch(()=>{});
      }
      syncFromServer().then(()=>renderOutbox()).catch(()=>{});
      break;
    case 'profile': renderProfile(); break;
    case 'admin':
      renderAdmin(); // render cache immediately (no blank wait)
      // Fetch fresh user list directly (not just sync) to avoid cold-start gaps
      apiCall('GET', '/api/users').then(data => {
        if (Array.isArray(data) && data.length > 0) {
          localStorage.setItem(K.users, JSON.stringify(data));
          if (adminTab === 'members') renderAdminTab('members');
        }
      }).catch(()=>{});
      syncFromServer().then(()=>renderAdmin()).catch(()=>{});
      break;
    case 'notifs':
      renderNotifs();
      apiCall('GET','/api/notifs').then(data=>{
        if(Array.isArray(data)){
          localStorage.setItem(K.notifs, JSON.stringify(data));
          _lastSyncTime = Date.now();
          renderNotifs();
        }
      }).catch(()=>{ syncFromServer().then(()=>renderNotifs()).catch(()=>{}); });
      break;
    case 'qr':      renderQRViewer(params.docId); break;
  }
}

function setPageTitle(title,icon=''){
  document.getElementById('page-title').innerHTML=icon?`${icon} ${escapeHtml(title)}`:escapeHtml(title);
}

// ===================================================================
// HOME PAGE
// ===================================================================
async function renderHome(){
  setPageTitle('หน้าหลัก','🏠');
  const user=getCurrentUser();
  const isAdmin=hasAdminAccess(user);
  const inbox=getInboxDocs(user);
  const outbox=getOutboxDocs(user);
  const pending=inbox.filter(d=>d.status==='pending').length;
  const sentThisMonth=outbox.filter(d=>{ const dm=new Date(d.createdAt); const now=new Date(); return dm.getMonth()===now.getMonth()&&dm.getFullYear()===now.getFullYear(); }).length;
  const canPreview=canPreviewDocs(user);
  const cs=canPreview?'clickable':'';
  const totalUsers=getUsers().length;
  const sa=(type)=>canPreview?`onclick="openStatModal('${type}')" title="คลิกเพื่อดูรายละเอียด"`:' ';

  // ดึง ALL docs metadata จาก server (ทุก user เห็นทุก doc)
  const allMeta = await apiCall('GET','/api/docs/all-meta') || getDocs();
  // Save to K.docs so outbox/inbox cache is always up-to-date
  if (Array.isArray(allMeta) && allMeta.length > 0) {
    localStorage.setItem(K.docs, JSON.stringify(allMeta));
  }
  const totalDocs=allMeta.length;

  // ทุก user เห็นเอกสารทั้งหมด — แต่เปิด popup ได้เฉพาะที่เกี่ยวข้อง
  const logDocs = [...allMeta].sort((a,b)=>b.createdAt-a.createdAt);

  // เช็คว่า user มีสิทธิ์ดูเอกสารนั้นไหม
  function canViewDoc(doc){
    if(isAdmin) return true;
    return doc.senderUsername===user.username ||
           doc.recipientUsername===user.username ||
           (doc.recipientType==='department'&&doc.recipientDepartment===user.department);
  }

  const adminCols = '<th style="width:40px;"></th>';

  // ── helper ──────────────────────────────────────────────────────────────────
  function buildDocRow(doc){
    const allowed   = canViewDoc(doc);
    const searchStr = (doc.title+' '+doc.senderFullName+' '+doc.senderDepartment+' '+(doc.recipientFullName||doc.recipientDepartment||'')+' '+(doc.storageLocation||'')).toLowerCase();
    const attChip   = doc.attachments?.length ? `<span class="att-chip" style="margin-left:4px;">📎${doc.attachments.length}</span>` : '';
    const storageCell = doc.storageLocation ? `📦 ${escapeHtml(doc.storageLocation)}` : '<span style="color:var(--muted);">—</span>';
    const pBadge    = doc.priority==='very_urgent'
      ? '<span class="badge" style="background:rgba(239,68,68,.1);color:var(--red);font-size:10px;margin-left:3px;">ด่วนมาก</span>'
      : doc.priority==='urgent'
        ? '<span class="badge" style="background:rgba(239,68,68,.1);color:var(--red);font-size:10px;margin-left:3px;">ด่วน</span>' : '';
    const statusCell = doc.status==='received'
      ? '<span class="badge badge-received">รับแล้ว ✓</span>'
      : '<span class="badge badge-pending">รอรับ</span>';
    const elapsed   = `<span class="home-elapsed">${timeAgo(doc.createdAt)}</span>`;
    const actionCell = allowed
      ? `<td onclick="event.stopPropagation();"><button class="btn-icon" title="ดูเนื้อหา" onclick="openDocPreviewModal('${doc.id}')">👁</button></td>`
      : `<td><span title="ไม่มีสิทธิ์ดูเอกสารนี้" style="color:var(--border);font-size:14px;">🔒</span></td>`;
    const rowClick  = allowed ? `onclick="openDocPreviewModal('${doc.id}')" style="cursor:pointer;"` : `style="opacity:0.7;"`;
    const rowClass  = allowed ? 'log-row-home log-row-clickable' : 'log-row-home';
    return { allowed, searchStr, attChip, storageCell, pBadge, statusCell, elapsed, actionCell, rowClick, rowClass };
  }

  const rowsHtml = logDocs.length===0
    ? '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--muted);">ยังไม่มีเอกสาร</td></tr>'
    : logDocs.map(doc=>{
        const r = buildDocRow(doc);
        return `<tr class="${r.rowClass}" ${r.rowClick} data-search="${r.searchStr}">
          <td><span style="font-weight:600;font-size:13px;">${escapeHtml(doc.title)}</span>${r.attChip}</td>
          <td>${escapeHtml(doc.senderFullName)}<br><span style="font-size:11px;color:var(--muted);">${escapeHtml(doc.senderDepartment||'')}${doc.senderLocation?' · '+escapeHtml(doc.senderLocation):''}</span></td>
          <td>${escapeHtml(doc.recipientFullName||doc.recipientDepartment||'—')}</td>
          <td>${r.statusCell}${r.pBadge}</td>
          <td style="font-size:12px;" class="col-storage">${r.storageCell}</td>
          <td style="font-size:12px;white-space:nowrap;" class="col-date">${formatDate(doc.createdAt)}</td>
          <td style="font-size:12px;white-space:nowrap;">${r.elapsed}</td>
          ${r.actionCell}
        </tr>`;
      }).join('');

  // ── Mobile card list ─────────────────────────────────────────────────────────
  const cardsHtml = logDocs.length===0
    ? '<p style="text-align:center;padding:24px 0;color:var(--muted);font-size:13px;">ยังไม่มีเอกสาร</p>'
    : logDocs.map(doc=>{
        const r = buildDocRow(doc);
        const cardClick = r.allowed ? `onclick="openDocPreviewModal('${doc.id}')"` : '';
        const lockIcon  = r.allowed ? '' : '<span style="font-size:11px;color:var(--muted);">🔒</span>';
        return `<div class="home-doc-card ${r.allowed?'hdc-clickable':''}" ${cardClick} data-search="${r.searchStr}">
          <div class="hdc-top">
            <span class="hdc-title">${escapeHtml(doc.title)}${r.attChip}</span>
            <span>${r.statusCell}${r.pBadge}${lockIcon}</span>
          </div>
          <div class="hdc-meta">
            <span>📤 ${escapeHtml(doc.senderFullName)} <span class="hdc-dept">${escapeHtml(doc.senderDepartment||'')}</span></span>
            <span>📥 ${escapeHtml(doc.recipientFullName||doc.recipientDepartment||'—')}</span>
          </div>
          <div class="hdc-footer">
            <span class="home-elapsed">🕐 ${timeAgo(doc.createdAt)}</span>
            <span class="hdc-date">${formatDateShort(doc.createdAt)}</span>
            ${doc.storageLocation?`<span class="hdc-storage">📦 ${escapeHtml(doc.storageLocation)}</span>`:''}
          </div>
        </div>`;
      }).join('');

  document.getElementById('page-body').innerHTML=`
    <div class="page-toolbar" style="margin-bottom:8px;">
      <span class="page-toolbar-label">ภาพรวมระบบ</span>
      <button id="page-refresh-btn" onclick="forceRefreshPage('home')" class="refresh-pill-btn"
        ${canRefreshPage('home')?'':'disabled'}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        ${canRefreshPage('home')?'รีเฟรช':'รออีก '+refreshCooldownSecs('home')+' วิ'}
      </button>
    </div>
  <div class="stats-grid">
    <div class="stat-card c-blue ${cs}" ${sa('members')}>
      <div class="stat-icon">👥</div><div class="stat-num">${totalUsers}</div>
      <div class="stat-label">สมาชิกทั้งหมด${canPreview?'<span style="font-size:9px;opacity:.55;margin-left:4px;">▶</span>':''}</div>
    </div>
    <div class="stat-card c-amber ${cs}" ${sa('pending')}>
      <div class="stat-icon">⏳</div><div class="stat-num warn">${pending}</div>
      <div class="stat-label">รอรับเอกสาร${canPreview?'<span style="font-size:9px;opacity:.55;margin-left:4px;">▶</span>':''}</div>
    </div>
    <div class="stat-card c-green ${cs}" ${sa('sent')}>
      <div class="stat-icon">✅</div><div class="stat-num ok">${sentThisMonth}</div>
      <div class="stat-label">ส่งแล้วเดือนนี้${canPreview?'<span style="font-size:9px;opacity:.55;margin-left:4px;">▶</span>':''}</div>
    </div>
    <div class="stat-card c-muted ${cs}" ${sa('all')}>
      <div class="stat-icon">📁</div><div class="stat-num" style="color:var(--muted)">${totalDocs}</div>
      <div class="stat-label">เอกสารทั้งหมด${canPreview?'<span style="font-size:9px;opacity:.55;margin-left:4px;">▶</span>':''}</div>
    </div>
  </div>
  <div class="card-section" style="margin-top:18px;">
    <div class="card-section-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <span>📋 Log การส่งเอกสาร <span style="font-size:12px;color:var(--muted);font-weight:400;">(${logDocs.length} รายการ)</span></span>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" id="home-log-search" placeholder="🔍 ค้นหา..." oninput="filterHomeLog(this.value)"
          style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--r);font-size:12px;background:var(--white);color:var(--text);width:150px;">
        <button class="btn-outline btn-sm" onclick="navigate('create')">+ สร้างเอกสาร</button>
      </div>
    </div>
    <!-- Desktop table -->
    <div class="home-table-desktop" style="overflow-x:auto;">
      <table class="data-table" id="home-log-table">
        <thead><tr>
          <th>ชื่อเอกสาร</th>
          <th>ผู้ส่ง / แผนก</th>
          <th>ผู้รับ</th>
          <th>สถานะ</th>
          <th class="col-storage">เก็บที่</th>
          <th class="col-date">วันที่ส่ง</th>
          <th>นานแค่ไหน</th>
          <th></th>
        </tr></thead>
        <tbody id="home-log-body">${rowsHtml}</tbody>
      </table>
    </div>
    ${!isAdmin?'<div style="font-size:11px;color:var(--muted);padding:8px 12px;">🔒 = เอกสารที่ไม่เกี่ยวข้องกับคุณ ไม่สามารถเปิดดูได้</div>':''}
  </div>
  <!-- Mobile card list -->
  <div class="home-cards-mobile">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-size:13px;font-weight:700;">📋 Log การส่งเอกสาร <span style="font-size:11px;color:var(--muted);font-weight:400;">(${logDocs.length} รายการ)</span></span>
      <input type="text" id="home-card-search" placeholder="🔍 ค้นหา..." oninput="filterHomeCards(this.value)"
        style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--r);font-size:12px;background:var(--white);color:var(--text);width:130px;">
    </div>
    <div id="home-cards-list">${cardsHtml}</div>
    ${!isAdmin?'<div style="font-size:11px;color:var(--muted);padding:4px 0 8px;">🔒 = เอกสารที่ไม่เกี่ยวข้องกับคุณ ไม่สามารถเปิดดูได้</div>':''}
  </div>`;
}

function filterHomeLog(q){
  const rows=document.querySelectorAll('#home-log-body tr.log-row-home');
  const lq=q.toLowerCase().trim();
  rows.forEach(r=>{ r.style.display=(!lq||r.dataset.search?.includes(lq))?'':'none'; });
}
function filterHomeCards(q){
  const cards=document.querySelectorAll('#home-cards-list .home-doc-card');
  const lq=q.toLowerCase().trim();
  cards.forEach(c=>{ c.style.display=(!lq||c.dataset.search?.includes(lq))?'':'none'; });
}

// ===================================================================
// WIZARD — สร้างเอกสาร
// ===================================================================
let wz = { step:1, mode:'form', blocks:[], tableHeading:'', columns:['รายการ','จำนวน','หน่วย','หมายเหตุ'], rows:[['','','','']], title:'', recipient:'', recipientType:'', priority:'normal', attachmentNote:'' };

function initWizard(){
  wz={step:1,mode:'form',blocks:[{type:'heading',text:''},{type:'paragraph',text:''}],tableHeading:'',columns:['รายการ','จำนวน','หน่วย','หมายเหตุ'],rows:[['','','',''],['','','','']],title:'',recipient:'',recipientType:'',priority:'normal',attachmentNote:''};
  wzAttachments=[];
  setPageTitle('สร้างเอกสาร','📝');
  renderWizard();
}

function renderWizard(){
  const steps=[{l:'รายละเอียด\nและเนื้อหา'},{l:'เลือกผู้รับ'},{l:'QR & พิมพ์'}];
  const stepsHtml=steps.map((s,i)=>{
    const n=i+1; const cls=n<wz.step?'done':n===wz.step?'active':'todo';
    const lbl=n<wz.step?'✓':n;
    const lineHtml=i<2?`<div class="ws-line${n<wz.step?' done':''}"></div>`:'';
    return `<div class="ws-item"><div class="ws-dot ${cls}">${lbl}</div><div class="ws-label${n===wz.step?' active':''}">${s.l.replace('\n','<br>')}</div></div>${lineHtml}`;
  }).join('');

  let body='';
  if(wz.step===1){
    const formDisplay=wz.mode==='form'?'block':'none';
    const tblDisplay=wz.mode==='table'?'block':'none';
    const blocksHtml=wz.blocks.map((b,i)=>{
      if(b.type==='heading') return `<div class="block-wrapper"><div class="heading-block"><input type="text" placeholder="หัวข้อ..." value="${escapeHtml(b.text)}" oninput="wz.blocks[${i}].text=this.value"></div><button class="block-del" onclick="removeBlock(${i})" title="ลบ">✕</button></div>`;
      return `<div class="block-wrapper"><div class="para-block"><textarea placeholder="รายละเอียด..." oninput="wz.blocks[${i}].text=this.value" rows="3">${escapeHtml(b.text)}</textarea></div><button class="block-del" onclick="removeBlock(${i})" title="ลบ">✕</button></div>`;
    }).join('');
    const tblHeadHtml=wz.columns.map((c,ci)=>`<th>${escapeHtml(c)} <small style="cursor:pointer;color:var(--muted);font-size:10px" onclick="renameColumn(${ci})">[แก้]</small></th>`).join('');
    const tblRowHtml=wz.rows.map((row,ri)=>`<tr>${row.map((cell,ci)=>`<td><input type="text" value="${escapeHtml(cell)}" oninput="wz.rows[${ri}][${ci}]=this.value"></td>`).join('')}</tr>`).join('');
    body=`
    <div class="form-group"><label>ชื่อเอกสาร *</label><input type="text" id="wz-title" placeholder="ชื่อเอกสาร..." value="${escapeHtml(wz.title)}" oninput="wz.title=this.value"></div>
    <div class="form-group"><label>รูปแบบเนื้อหา</label>
      <div class="content-toggle">
        <div class="ct-btn${wz.mode==='form'?' active':''}" onclick="setWzMode('form')">📝 กรอกข้อมูลเอง</div>
        <div class="ct-btn${wz.mode==='table'?' active':''}" onclick="setWzMode('table')">📊 ตาราง</div>
      </div>
    </div>
    <div id="wz-form-area" style="display:${formDisplay}">
      <div class="blocks-area" id="blocks-area">${blocksHtml}</div>
      <div class="add-block-bar">
        <button class="btn-outline btn-sm" onclick="addBlock('heading')">+ หัวข้อ</button>
        <button class="btn-outline btn-sm" onclick="addBlock('paragraph')">+ ย่อหน้า</button>
      </div>
    </div>
    <div id="wz-table-area" style="display:${tblDisplay}">
      <div class="table-area">
        <div class="table-header-row"><input type="text" placeholder="หัวข้อตาราง..." value="${escapeHtml(wz.tableHeading)}" oninput="wz.tableHeading=this.value" style="font-size:14px;font-weight:600;border:none;background:transparent;padding:0;width:100%;"></div>
        <div class="table-body"><table class="doc-table"><thead><tr>${tblHeadHtml}</tr></thead><tbody>${tblRowHtml}</tbody></table></div>
        <div class="table-actions">
          <button class="btn-outline btn-sm" onclick="addTableRow()">+ แถว</button>
          <button class="btn-outline btn-sm" onclick="addTableCol()">+ คอลัมน์</button>
        </div>
      </div>
    </div>
    <div class="form-group" style="margin-top:16px;">
      <label>📎 แนบไฟล์เอกสาร (PNG / BMP / JPG / Excel / PDF / MD)</label>
      <div class="upload-zone" id="upload-zone"
           ondrop="handleFileDrop(event)"
           ondragover="event.preventDefault();this.classList.add('dragover')"
           ondragleave="this.classList.remove('dragover')"
           onclick="document.getElementById('file-input-wz').click()">
        <div class="upload-zone-icon">📁</div>
        <p><strong>คลิกหรือลากไฟล์มาวางที่นี่</strong></p>
        <p style="font-size:11px;margin-top:4px;">PNG · BMP · JPG · XLS · XLSX · PDF · MD (สูงสุด 10MB/ไฟล์)</p>
      </div>
      <div class="upload-btn-row" style="display:flex;gap:8px;margin-top:8px;">
        <button type="button" class="btn-outline btn-sm" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;"
                onclick="document.getElementById('file-input-wz').click()">
          📂 <span>เลือกไฟล์จากเครื่อง</span>
        </button>
        <button type="button" class="btn-outline btn-sm" style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;"
                onclick="document.getElementById('camera-input-wz').click()">
          📷 <span>ถ่ายรูป / กล้อง</span>
        </button>
      </div>
      <!-- file picker: multiple files -->
      <input type="file" id="file-input-wz" multiple
             accept=".png,.bmp,.jpg,.jpeg,.xls,.xlsx,.pdf,.md,.txt"
             style="display:none" onchange="handleFileSelect(this.files);this.value=''">
      <!-- camera input: single capture (add more via file picker) -->
      <input type="file" id="camera-input-wz"
             accept="image/*" capture="environment"
             style="display:none" onchange="handleFileSelect(this.files);this.value=''">
      <div class="attachment-list" id="attachment-list"></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:16px;"><button class="btn-primary" onclick="wzNext()">ถัดไป: เลือกผู้รับ →</button></div>`;
  } else if(wz.step===2){
    const users=getUsers().filter(u=>u.username!==getCurrentUser().username);
    const depts=getDepartments(); // use admin-managed department list
    const userOpts=users.map(u=>`<option value="user:${escapeHtml(u.username)}" ${wz.recipient==='user:'+u.username?'selected':''}>${displayNamePlain(u)} (${escapeHtml(u.department)})</option>`).join('');
    const deptOpts=depts.map(d=>`<option value="dept:${escapeHtml(d)}" ${wz.recipient==='dept:'+d?'selected':''}>${escapeHtml(d)} (ทั้งแผนก)</option>`).join('');
    body=`
    <div class="info-box">📋 เอกสาร: <strong>${escapeHtml(wz.title||'(ยังไม่มีชื่อ)')}</strong> · โหมด: ${wz.mode==='form'?'กรอกข้อมูล':'ตาราง'}</div>
    <div class="form-group"><label>ผู้รับ / แผนก *</label>
      <select id="wz-recipient" onchange="wz.recipient=this.value">
        <option value="">-- เลือกผู้รับหรือแผนก --</option>
        <optgroup label="รายบุคคล">${userOpts}</optgroup>
        <optgroup label="ทั้งแผนก">${deptOpts}</optgroup>
      </select>
    </div>
    <div class="form-group"><label>ความเร่งด่วน</label>
      <select id="wz-priority" onchange="wz.priority=this.value">
        <option value="normal" ${wz.priority==='normal'?'selected':''}>ปกติ</option>
        <option value="urgent" ${wz.priority==='urgent'?'selected':''}>ด่วน</option>
        <option value="very_urgent" ${wz.priority==='very_urgent'?'selected':''}>ด่วนมาก</option>
      </select>
    </div>
    <div class="form-group"><label>หมายเหตุไฟล์แนบ (เพิ่มเติม)</label><input type="text" placeholder="หมายเหตุเพิ่มเติมเกี่ยวกับไฟล์..." value="${escapeHtml(wz.attachmentNote)}" oninput="wz.attachmentNote=this.value"></div>
    ${wzAttachments.length>0?`<div class="info-box">📎 มีไฟล์แนบ <strong>${wzAttachments.length}</strong> ไฟล์พร้อมส่ง (${wzAttachments.map(a=>a.name).join(', ')})</div>`:''}
    <div style="display:flex;justify-content:space-between;margin-top:16px;">
      <button class="btn-outline" onclick="wz.step=1;renderWizard()">← ย้อนกลับ</button>
      <button class="btn-primary" onclick="wzSubmit()">📨 ส่งและสร้าง QR Code</button>
    </div>`;
  }
  document.getElementById('page-body').innerHTML=`<div class="wizard-steps">${stepsHtml}</div>${body}`;
}

function setWzMode(m){ wz.mode=m; const fa=document.getElementById('wz-form-area'); const ta=document.getElementById('wz-table-area'); if(fa)fa.style.display=m==='form'?'block':'none'; if(ta)ta.style.display=m==='table'?'block':'none'; document.querySelectorAll('.ct-btn').forEach((el,i)=>el.classList.toggle('active',i===(m==='form'?0:1))); setTimeout(()=>renderAttachmentList('attachment-list'),50); }
function addBlock(type){ wz.blocks.push({type,text:''}); renderBlocksArea(); }
function removeBlock(i){ wz.blocks.splice(i,1); renderBlocksArea(); }
function renderBlocksArea(){
  const html=wz.blocks.map((b,i)=>{
    if(b.type==='heading') return `<div class="block-wrapper"><div class="heading-block"><input type="text" placeholder="หัวข้อ..." value="${escapeHtml(b.text)}" oninput="wz.blocks[${i}].text=this.value"></div><button class="block-del" onclick="removeBlock(${i})">✕</button></div>`;
    return `<div class="block-wrapper"><div class="para-block"><textarea placeholder="รายละเอียด..." oninput="wz.blocks[${i}].text=this.value" rows="3">${escapeHtml(b.text)}</textarea></div><button class="block-del" onclick="removeBlock(${i})">✕</button></div>`;
  }).join('');
  const el=document.getElementById('blocks-area'); if(el)el.innerHTML=html;
}
function addTableRow(){ wz.rows.push(wz.columns.map(()=>'')); renderWizard(); }
function addTableCol(){ const name=prompt('ชื่อคอลัมน์ใหม่:',''); if(!name)return; wz.columns.push(name); wz.rows=wz.rows.map(r=>[...r,'']); renderWizard(); }
function renameColumn(ci){ const n=prompt('ชื่อคอลัมน์ใหม่:',wz.columns[ci]); if(n&&n.trim())wz.columns[ci]=n.trim(); renderWizard(); }

function wzNext(){ wz.title=document.getElementById('wz-title')?.value.trim()||wz.title; if(!wz.title){ alert('กรุณากรอกชื่อเอกสาร'); return; } wz.step=2; renderWizard(); }

async function wzSubmit(){
  wz.recipient=document.getElementById('wz-recipient')?.value||wz.recipient;
  wz.priority=document.getElementById('wz-priority')?.value||wz.priority;
  wz.attachmentNote=document.getElementById('wz-priority')?.nextElementSibling?.value||wz.attachmentNote;
  if(!wz.recipient){ alert('กรุณาเลือกผู้รับ'); return; }
  const users=getUsers();
  let recipientType,recipientUsername=null,recipientDepartment=null,recipientFullName=null;
  if(wz.recipient.startsWith('user:')){
    recipientType='user'; recipientUsername=wz.recipient.slice(5);
    const ru=users.find(u=>u.username===recipientUsername);
    recipientFullName=ru?ru.fullName:recipientUsername;
    recipientDepartment=ru?ru.department:null;
  } else {
    recipientType='department'; recipientDepartment=wz.recipient.slice(5);
    recipientFullName=recipientDepartment+' (ทั้งแผนก)';
  }
  // ── Upload ไฟล์แนบไปยัง Cloudinary (server-side) ก่อนบันทึก ──
  let finalAttachments = wzAttachments;
  if (wzAttachments.length > 0) {
    showToast('⬆️ กำลังอัปโหลดไฟล์...','info');
    finalAttachments = await Promise.all(wzAttachments.map(a => uploadToCloudinary(a)));
  }
  const docContent = wz.mode==='form'
    ? {blocks:wz.blocks}
    : {tableHeading:wz.tableHeading,columns:wz.columns,rows:wz.rows};
  const doc=await createDocument({title:wz.title,contentType:wz.mode,content:docContent,recipientType,recipientUsername,recipientDepartment,recipientFullName,priority:wz.priority,attachmentNote:wz.attachmentNote,attachments:finalAttachments});
  if(!doc||doc._failed){ showToast('ส่งเอกสารไม่สำเร็จ กรุณาลองใหม่','error'); return; }
  wzAttachments=[];
  wz.step=3; wz.lastDoc=doc;
  renderWizardSuccess(doc);
}

function renderWizardSuccess(doc){
  const steps=[{l:'รายละเอียด\nและเนื้อหา'},{l:'เลือกผู้รับ'},{l:'QR & พิมพ์'}];
  const stepsHtml=steps.map((s,i)=>{
    const n=i+1; const cls=n<=3?'done':'todo'; const lbl='✓';
    const lineHtml=i<2?`<div class="ws-line done"></div>`:'';
    return `<div class="ws-item"><div class="ws-dot ${cls}">${lbl}</div><div class="ws-label">${s.l.replace('\n','<br>')}</div></div>${lineHtml}`;
  }).join('');
  document.getElementById('page-body').innerHTML=`
  <div class="wizard-steps">${stepsHtml}</div>
  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--r-lg);padding:12px 16px;color:#14532d;margin-bottom:20px;display:flex;align-items:center;gap:8px;">
    ✅ ส่งเอกสารเรียบร้อย — QR Code ถูก generate อัตโนมัติแล้ว
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
    <div class="doc-detail-card">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);"><strong>${escapeHtml(doc.title)}</strong></div>
      <div class="ddc-row"><span class="ddc-label">รหัสเอกสาร</span><code style="font-size:12px;color:var(--blue)">${doc.id}</code></div>
      <div class="ddc-row"><span class="ddc-label">จาก</span><span>${escapeHtml(doc.senderFullName)} · ${escapeHtml(doc.senderDepartment)}</span></div>
      <div class="ddc-row"><span class="ddc-label">ถึง</span><span>${escapeHtml(doc.recipientFullName)}</span></div>
      <div class="ddc-row"><span class="ddc-label">ความเร่งด่วน</span>${priorityBadge(doc.priority)}</div>
      <div class="ddc-row"><span class="ddc-label">ส่งเมื่อ</span><span>${formatDate(doc.createdAt)}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div class="qr-container">
        <div class="qr-box" id="qr-success-box"></div>
        <div class="qr-url">${escapeHtml(doc.qrUrl)}</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
          <button class="btn-primary" onclick="printEnvelope('${doc.id}')">🖨️ พิมพ์หน้าปะซอง</button>
          <button class="btn-outline" onclick="copyLink('${escapeHtml(doc.qrUrl)}')">📋 คัดลอก Link</button>
          <button class="btn-outline" onclick="downloadQR('qr-success-box','${doc.id}')">⬇️ PNG</button>
        </div>
      </div>
    </div>
  </div>
  <div class="doc-content-area">
    <div class="doc-content-header">
      ${doc.contentType==='table'?'📊 ตารางเนื้อหา':'📝 เนื้อหาเอกสาร'}
    </div>
    ${renderDocContent(doc)}
  </div>
  <div style="margin-top:16px;display:flex;gap:8px;">
    <button class="btn-primary" onclick="initWizard()">+ สร้างเอกสารใหม่</button>
    <button class="btn-outline" onclick="navigate('outbox')">ดูรายการที่ส่ง →</button>
  </div>`;
  setTimeout(()=>generateQR('qr-success-box',doc.qrUrl,130),100);
}

// ===================================================================
// INBOX
// ===================================================================
let inboxFilter='all';
async function forceRefreshInbox() {
  const icon = document.getElementById('inbox-refresh-icon');
  if (icon) icon.style.animation = 'spin 1s linear infinite';
  const label = document.getElementById('inbox-sync-label');
  if (label) label.textContent = '🔄 กำลังโหลด…';
  try {
    const data = await apiCall('GET','/api/docs/all-meta');
    if (Array.isArray(data)) {
      localStorage.setItem(K.docs, JSON.stringify(data));
      _lastSyncTime = Date.now();
    }
  } catch(_) {}
  renderInbox();
  updateInboxBadge();
}

function renderInbox(){
  setPageTitle('เอกสารที่ได้รับ','📥');
  const user=getCurrentUser();
  // Auto-refresh if data is stale (>8s since last sync) — catches socket-missed events
  const stale = Date.now() - _lastSyncTime > 8000;
  if (stale) {
    apiCall('GET','/api/docs/all-meta').then(data => {
      if (Array.isArray(data)) {
        localStorage.setItem(K.docs, JSON.stringify(data));
        _lastSyncTime = Date.now();
        if (currentPage==='inbox') renderInbox();
      }
    }).catch(()=>{});
  }
  const docs=getInboxDocs(user).sort((a,b)=>b.createdAt-a.createdAt);
  const filtered=inboxFilter==='all'?docs:inboxFilter==='pending'?docs.filter(d=>d.status==='pending'):docs.filter(d=>d.status==='received');
  const pCount=docs.filter(d=>d.status==='pending').length;
  const rCount=docs.filter(d=>d.status==='received').length;
  const syncAgo = _lastSyncTime ? Math.round((Date.now()-_lastSyncTime)/1000) : null;
  const syncLabel = syncAgo===null?'ยังไม่ได้ซิงค์':syncAgo<5?'เพิ่งอัพเดท':`${syncAgo} วิที่แล้ว`;
  document.getElementById('page-body').innerHTML=`
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
    <div class="filter-bar" style="margin-bottom:0;flex:1;min-width:0;">
      <span class="filter-chip${inboxFilter==='all'?' active':''}" onclick="inboxFilter='all';renderInbox()">ทั้งหมด (${docs.length})</span>
      <span class="filter-chip${inboxFilter==='pending'?' active':''}" onclick="inboxFilter='pending';renderInbox()">รอรับ (${pCount})</span>
      <span class="filter-chip${inboxFilter==='received'?' active':''}" onclick="inboxFilter='received';renderInbox()">รับแล้ว (${rCount})</span>
    </div>
    <button onclick="forceRefreshInbox()" id="inbox-refresh-btn" class="refresh-pill-btn" style="flex-shrink:0;">
      <svg id="inbox-refresh-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
      </svg>
      <span id="inbox-sync-label">🔄 ${syncLabel}</span>
    </button>
  </div>
  <div class="doc-list">
  ${filtered.length===0?'<div class="empty-state"><p>ไม่มีเอกสาร</p></div>':
    filtered.map(doc=>`
    <div class="doc-card${doc.priority==='very_urgent'&&doc.status==='pending'?' urgent':''} inbox-card-clickable"
         onclick="openDocPreviewModal('${doc.id}')" style="cursor:pointer;" title="คลิกเพื่อดูเอกสาร">
      <div class="doc-icon${doc.status==='received'?' ok':doc.priority==='very_urgent'?' warn':''}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
      </div>
      <div class="doc-info">
        <div class="doc-title">${escapeHtml(doc.title)}</div>
        <div class="doc-meta">จาก: ${escapeHtml(doc.senderFullName)} · ${escapeHtml(doc.senderDepartment)} · ${formatDateShort(doc.createdAt)} ${doc.status==='received'?'· เก็บที่: <strong>'+escapeHtml(doc.storageLocation)+'</strong>':''}</div>
      </div>
      <div class="doc-actions" onclick="event.stopPropagation()">
        ${priorityBadge(doc.priority)}
        ${doc.status==='pending'
  ?`<button class="btn-outline btn-sm" onclick="event.stopPropagation();openDocPreviewModal('${doc.id}')">👁 ดู</button><button class="btn-primary btn-sm" onclick="event.stopPropagation();openReceiveModal('${doc.id}')">✓ รับเอกสาร</button>`
  :`<button class="btn-outline btn-sm" onclick="event.stopPropagation();openDocPreviewModal('${doc.id}')">👁 ดู</button><span class="badge badge-received">รับแล้ว ✓</span>`}
      </div>
    </div>`).join('')}
  </div>`;
}

// ===================================================================
// OUTBOX
// ===================================================================
let outboxSelected=null;
let outboxFilter='all';
function renderOutbox(){
  setPageTitle('เอกสารที่ส่ง','📤');
  const user=getCurrentUser();
  const allDocs=getOutboxDocs(user).sort((a,b)=>b.createdAt-a.createdAt);
  const pendCount=allDocs.filter(d=>d.status==='pending').length;
  const recvCount=allDocs.filter(d=>d.status==='received').length;
  const docs=outboxFilter==='all'?allDocs:outboxFilter==='pending'?allDocs.filter(d=>d.status==='pending'):allDocs.filter(d=>d.status==='received');
  const selDoc=outboxSelected?getDocById(outboxSelected):null;
  document.getElementById('page-body').innerHTML=`
  <div class="page-toolbar">
    <span class="page-toolbar-label">ทั้งหมด <strong>${allDocs.length}</strong> รายการ</span>
    <button id="page-refresh-btn" onclick="forceRefreshPage('outbox')" class="refresh-pill-btn"
      ${canRefreshPage('outbox')?'':'disabled'}>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      ${canRefreshPage('outbox')?'รีเฟรช':'รออีก '+refreshCooldownSecs('outbox')+' วิ'}
    </button>
  </div>
  <div class="outbox-stats">
    <div class="outbox-stat${outboxFilter==='all'?' active':''}" onclick="outboxFilter='all';outboxSelected=null;renderOutbox()">
      <div class="os-icon total">📤</div>
      <div><div class="os-val">${allDocs.length}</div><div class="os-label">ทั้งหมด</div></div>
    </div>
    <div class="outbox-stat${outboxFilter==='pending'?' active':''}" onclick="outboxFilter='pending';outboxSelected=null;renderOutbox()">
      <div class="os-icon pending">⏳</div>
      <div><div class="os-val" style="color:var(--amber)">${pendCount}</div><div class="os-label">รอรับ</div></div>
    </div>
    <div class="outbox-stat${outboxFilter==='received'?' active':''}" onclick="outboxFilter='received';outboxSelected=null;renderOutbox()">
      <div class="os-icon done">✅</div>
      <div><div class="os-val" style="color:var(--green)">${recvCount}</div><div class="os-label">รับแล้ว</div></div>
    </div>
  </div>
  <div class="outbox-layout">
    <div class="outbox-list-panel">
    ${docs.length===0?`<div class="empty-state" style="margin-top:0;border:1.5px dashed var(--border);border-radius:var(--r-lg);padding:48px 24px;">
      <div style="font-size:40px;margin-bottom:12px;">📭</div>
      <p style="font-weight:600;font-size:15px;">ยังไม่มีเอกสาร</p>
      <p style="font-size:12px;color:var(--muted);margin-top:4px;">เริ่มส่งเอกสารแรกของคุณได้เลย</p>
      <button class="btn-primary btn-sm" style="margin-top:14px;" onclick="navigate('create')">+ สร้างเอกสาร</button>
    </div>`:docs.map(doc=>{
      const isUrgent=doc.priority==='very_urgent'&&doc.status==='pending';
      const stripeClass=isUrgent?'urgent-stripe':doc.status==='received'?'received':'pending';
      return `<div class="ob-card${outboxSelected===doc.id?' selected':''}${isUrgent?' urgent':''}" onclick="selectOutboxDoc('${doc.id}')">
        <div class="ob-stripe ${stripeClass}"></div>
        <div class="ob-body">
          <div class="ob-title">${escapeHtml(doc.title)}</div>
          <div class="ob-meta">
            <span>📬 ${escapeHtml(doc.recipientFullName||doc.recipientDepartment||'ทุกแผนก')}</span>
            <span class="ob-meta-sep">·</span>
            <span>🏢 ${escapeHtml(doc.recipientDepartment||'—')}</span>
            <span class="ob-meta-sep">·</span>
            <span>📅 ${formatDateShort(doc.createdAt)}</span>
            ${doc.attachments&&doc.attachments.length?`<span class="ob-meta-sep">·</span><span>📎 ${doc.attachments.length} ไฟล์</span>`:''}
            ${(doc.comments&&doc.comments.length)?`<span class="ob-meta-sep">·</span><span>💬 ${doc.comments.length}</span>`:''}
          </div>
        </div>
        <div class="ob-side">
          ${doc.status==='received'?'<span class="badge badge-received">✓ รับแล้ว</span>':'<span class="badge badge-pending">⏳ รอรับ</span>'}
          ${priorityBadge(doc.priority)}
          <div class="ob-actions">
            <button class="btn-icon" title="ดู QR Code" onclick="event.stopPropagation();navigate('qr',{docId:'${doc.id}'})">🔍</button>
            <button class="btn-icon" title="คัดลอกลิงก์" onclick="event.stopPropagation();copyLink('${escapeHtml(doc.qrUrl||'')}')">🔗</button>
          </div>
        </div>
      </div>`;
    }).join('')}
    </div>
    ${selDoc?renderOutboxDetail(selDoc):`<div class="ob-detail-empty">
      <div style="font-size:40px;margin-bottom:14px;opacity:.6;">👈</div>
      <div style="font-weight:700;font-size:14px;margin-bottom:6px;">เลือกเอกสาร</div>
      <div style="font-size:12px;line-height:1.6;">คลิกที่รายการด้านซ้าย<br>เพื่อดูรายละเอียดและติดตามสถานะ</div>
    </div>`}
  </div>`;
}
function selectOutboxDoc(id){ outboxSelected=outboxSelected===id?null:id; renderOutbox(); }
function renderOutboxDetail(doc){
  if(!doc)return'';
  const received=doc.status==='received';
  return `<div class="ob-detail-panel">
    <div class="ob-detail-head">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        ${received?'<span class="badge badge-received">✓ รับแล้ว</span>':'<span class="badge badge-pending">⏳ รอรับ</span>'}
        ${priorityBadge(doc.priority)}
      </div>
      <div class="ob-detail-title">${escapeHtml(doc.title)}</div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:4px;">ID: ${escapeHtml(doc.id)}</div>
    </div>
    <div class="ob-detail-body">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px;">ข้อมูลการส่ง</div>
      <div class="ob-info-row"><span class="ob-info-label">ผู้รับ</span><span class="ob-info-val">${escapeHtml(doc.recipientFullName||'—')}</span></div>
      <div class="ob-info-row"><span class="ob-info-label">แผนก</span><span class="ob-info-val">${escapeHtml(doc.recipientDepartment||'—')}</span></div>
      <div class="ob-info-row"><span class="ob-info-label">ส่งเมื่อ</span><span class="ob-info-val">${formatDate(doc.createdAt)}</span></div>
      ${received?`<div class="ob-info-row"><span class="ob-info-label">รับเมื่อ</span><span class="ob-info-val" style="color:var(--green);">${formatDate(doc.receivedAt)}</span></div>
      <div class="ob-info-row"><span class="ob-info-label">เก็บที่</span><span class="ob-info-val">${escapeHtml(doc.storageLocation||'—')}</span></div>`:''}
      <div class="ob-counters">
        <div class="ob-counter">📎 ${doc.attachments&&doc.attachments.length?doc.attachments.length:0} ไฟล์แนบ</div>
        <div class="ob-counter">💬 ${doc.comments&&doc.comments.length?doc.comments.length:0} ความคิดเห็น</div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 10px;">ติดตามสถานะ</div>
      <div class="ob-tl">
        <div class="ob-tl-item">
          <div class="ob-tl-dot done"></div>
          <div class="ob-tl-title">📝 สร้างเอกสาร</div>
          <div class="ob-tl-sub">${formatDate(doc.createdAt)}</div>
        </div>
        <div class="ob-tl-item">
          <div class="ob-tl-dot done"></div>
          <div class="ob-tl-title">📤 ส่งเรียบร้อยแล้ว</div>
          <div class="ob-tl-sub">บันทึกในระบบอัตโนมัติ</div>
        </div>
        <div class="ob-tl-item">
          <div class="ob-tl-dot ${received?'done':'active'}"></div>
          <div class="ob-tl-title" style="color:${received?'var(--green)':'var(--blue)'};">
            ${received?'✅ ผู้รับยืนยันรับแล้ว':'🔔 รอการรับเอกสาร'}
          </div>
          <div class="ob-tl-sub">${received?(formatDate(doc.receivedAt)+(doc.receivedBy?' · '+escapeHtml(doc.receivedBy):'')):'ยังไม่มีการตอบรับจากผู้รับ'}</div>
        </div>
      </div>
    </div>
    <div class="ob-detail-actions">
      <button class="btn-primary btn-sm" onclick="navigate('qr',{docId:'${doc.id}'})">🔍 ดู QR</button>
      <button class="btn-outline btn-sm" onclick="printEnvelope('${doc.id}')">🖨️ หน้าปะซอง</button>
      <button class="btn-outline btn-sm" onclick="copyLink('${escapeHtml(doc.qrUrl||'')}')">🔗 คัดลอก</button>
    </div>
  </div>`;
}
function renderTimeline(doc){
  if(!doc)return'';
  return renderOutboxDetail(doc);
}
// ===================================================================
// QR VIEWER
// ===================================================================

function renderDocContent(doc){
  if(!doc||!doc.content) return '<div class="doc-content-body"><p style="color:var(--muted);font-size:13px;">ไม่มีเนื้อหา</p></div>';
  const c=doc.content;
  if(doc.contentType==='form'){
    const blocks=(c.blocks||[]).map(b=>{
      if(b.type==='heading') return `<div class="view-heading">${escapeHtml(b.text||'')}</div>`;
      return `<div class="view-para">${escapeHtml(b.text||'')}</div>`;
    }).join('');
    return `<div class="doc-content-body">${blocks||'<p style="color:var(--muted)">ไม่มีเนื้อหา</p>'}</div>`;
  }
  if(doc.contentType==='table'){
    const cols=c.columns||[];
    const rows=c.rows||[];
    const thead=cols.map(col=>`<th>${escapeHtml(col)}</th>`).join('');
    const tbody=rows.map(row=>`<tr>${row.map(cell=>`<td>${escapeHtml(cell||'')}</td>`).join('')}</tr>`).join('');
    return `<div class="doc-content-body">
      ${c.tableHeading?`<div class="view-table-title">📊 ${escapeHtml(c.tableHeading)}</div>`:''}
      <div style="overflow-x:auto;"><table class="view-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>
    </div>`;
  }
  return '<div class="doc-content-body"><p style="color:var(--muted)">ไม่รู้จักรูปแบบเนื้อหา</p></div>';
}
async function renderQRViewer(docId){
  if(!docId){ document.getElementById('page-body').innerHTML='<div class="empty-state"><p>ไม่พบเอกสาร</p></div>'; return; }
  // Always fetch full doc from server (cache may be stripped)
  let doc = await apiCall('GET','/api/docs/'+docId);
  if(!doc) doc = getDocById(docId);
  if(!doc){ document.getElementById('page-body').innerHTML='<div class="empty-state"><p>ไม่พบเอกสาร</p></div>'; return; }
  setPageTitle('QR Code','📷');
  document.getElementById('page-actions').innerHTML=`<button class="btn-outline btn-sm" onclick="history.back?navigate('outbox'):null">← กลับ</button>`;
  document.getElementById('page-body').innerHTML=`
  <div style="display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:start;">
    <div style="text-align:center;">
      <div class="qr-box" id="qr-viewer-box" style="margin-bottom:10px;"></div>
      <code style="font-size:11px;color:var(--blue);display:block;margin-bottom:12px;">${doc.id}</code>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <button class="btn-primary" onclick="printEnvelope('${doc.id}')">🖨️ พิมพ์หน้าปะซอง</button>
        <button class="btn-outline" onclick="copyLink('${escapeHtml(doc.qrUrl)}')">📋 คัดลอก Link</button>
        <button class="btn-outline" onclick="downloadQR('qr-viewer-box','${doc.id}')">⬇️ บันทึก PNG</button>
      </div>
      <div class="qr-url" style="margin-top:12px;max-width:200px;">${escapeHtml(doc.qrUrl)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px;background:#f8fafc;padding:6px;border-radius:var(--r);">🔒 ต้องล็อกอินก่อนเปิด</div>
    </div>
    <div class="doc-detail-card">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border);"><strong style="font-size:15px;">${escapeHtml(doc.title)}</strong></div>
      <div class="ddc-row"><span class="ddc-label">รหัสเอกสาร</span><code style="font-size:12px;color:var(--blue)">${doc.id}</code></div>
      <div class="ddc-row"><span class="ddc-label">จาก</span><span>${escapeHtml(doc.senderFullName)} · ${escapeHtml(doc.senderDepartment)} · ${escapeHtml(doc.senderLocation)}</span></div>
      <div class="ddc-row"><span class="ddc-label">ถึง</span><span>${escapeHtml(doc.recipientFullName||doc.recipientDepartment||'')}</span></div>
      <div class="ddc-row"><span class="ddc-label">ความเร่งด่วน</span>${priorityBadge(doc.priority)}</div>
      <div class="ddc-row"><span class="ddc-label">ส่งเมื่อ</span><span>${formatDate(doc.createdAt)}</span></div>
      <div class="ddc-row"><span class="ddc-label">สถานะ</span>${doc.status==='received'?'<span class="badge badge-received">รับแล้ว ✓</span>':'<span class="badge badge-pending">รอรับ</span>'}</div>
      ${doc.status==='received'?`<div class="ddc-row"><span class="ddc-label">รับเมื่อ</span><span>${formatDate(doc.receivedAt)}</span></div><div class="ddc-row"><span class="ddc-label">เก็บที่</span><span>${escapeHtml(doc.storageLocation)}</span></div>`:''}
      ${doc.attachmentNote?`<div class="ddc-row"><span class="ddc-label">ไฟล์แนบ</span><span>${escapeHtml(doc.attachmentNote)}</span></div>`:''}
    </div>
  </div>
  <div class="doc-content-area">
    <div class="doc-content-header">
      ${doc.contentType==='table'?'📊 ตารางเนื้อหา':'📝 เนื้อหาเอกสาร'}
      <span class="badge badge-normal" style="margin-left:auto">${doc.contentType==='table'?'ตาราง':'กรอกข้อมูล'}</span>
    </div>
    ${renderDocContent(doc)}
  </div>`;
  const cfg=getGDriveConfig();
  const driveSection=cfg.enabled?`<button class="gdrive-btn" style="margin-top:8px;width:100%;justify-content:center;" onclick="uploadDocToGoogleDrive(getDocById('${doc.id}'))"><img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" alt=""> Upload to Google Drive</button>`:'';
  const attSection=renderDocAttachments(doc);
  const cmtSection=renderCommentSection(doc);
  const extraEl=document.createElement('div');
  extraEl.innerHTML=driveSection+attSection+cmtSection;
  document.getElementById('page-body').appendChild(extraEl);
  setTimeout(()=>generateQR('qr-viewer-box',doc.qrUrl,140),100);
}

// ===================================================================
// PROFILE
// ===================================================================
function renderProfile(){
  setPageTitle('ข้อมูลของฉัน','👤');
  const u=getCurrentUser();
  const initials=(u.nickname||u.fullName||'?')[0].toUpperCase();
  const locs=getLocations();
  const locOpts=locs.map(l=>`<option value="${escapeHtml(l)}"${u.location===l?' selected':''}>${escapeHtml(l)}</option>`).join('');
  const deptOpts=getDepartments().map(d=>`<option value="${escapeHtml(d)}"${u.department===d?' selected':''}>${escapeHtml(d)}</option>`).join('');
  document.getElementById('page-body').innerHTML=`
  <div class="doc-detail-card" style="max-width:560px;">
    <div style="padding:20px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;">
      <div style="width:52px;height:52px;border-radius:50%;background:var(--blue-lt);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--blue);">${initials}</div>
      <div>
        <div style="font-size:17px;font-weight:700;">${u.nickname?escapeHtml(u.nickname)+' <span style="font-size:13px;color:var(--muted);">('+escapeHtml(u.fullName)+')</span>':escapeHtml(u.fullName)}</div>
        <div style="color:var(--muted);font-size:13px;">@${escapeHtml(u.username)}</div>
        <span class="badge ${hasAdminAccess(u)?'badge-admin':'badge-user'}">${getRoleName(u.role)}</span>
      </div>
    </div>

    <!-- Section: ข้อมูลส่วนตัว -->
    <div style="padding:16px;border-bottom:1px solid var(--border);">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">✏️ ข้อมูลส่วนตัว</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group" style="margin:0;grid-column:1/-1"><label>ชื่อ-นามสกุล *</label><input id="prof-fullname" type="text" value="${escapeHtml(u.fullName)}" placeholder="ชื่อ นามสกุล"></div>
        <div class="form-group" style="margin:0;grid-column:1/-1"><label>ชื่อเล่น</label><input id="prof-nickname" type="text" value="${escapeHtml(u.nickname||'')}" placeholder="ชื่อเล่น (ไม่บังคับ)"></div>
        <div class="form-group" style="margin:0"><label>แผนก</label><select id="prof-dept" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r);font-size:13px;background:var(--white);color:var(--text);">${deptOpts}</select></div>
        <div class="form-group" style="margin:0"><label>สถานที่</label><select id="prof-location" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r);font-size:13px;background:var(--white);color:var(--text);">${locOpts}</select></div>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:flex-end;">
        <button class="btn-primary btn-sm" onclick="saveProfileInfo()">💾 บันทึกข้อมูล</button>
      </div>
    </div>

    <!-- Section: เปลี่ยนรหัสผ่าน -->
    <div style="padding:16px;border-bottom:1px solid var(--border);">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">🔒 เปลี่ยนรหัสผ่าน</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group" style="margin:0;grid-column:1/-1"><label>ยืนยัน Passkey (6 หลัก)</label><input id="prof-pw-passkey" type="password" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center;"></div>
        <div class="form-group" style="margin:0"><label>รหัสผ่านใหม่</label><div class="pw-wrap"><input id="prof-new-pw" type="password" placeholder="อย่างน้อย 6 ตัว"><button type="button" class="pw-toggle" onclick="togglePw('prof-new-pw',this)">👁</button></div></div>
        <div class="form-group" style="margin:0"><label>ยืนยันรหัสผ่าน</label><div class="pw-wrap"><input id="prof-new-pw2" type="password" placeholder="••••••"><button type="button" class="pw-toggle" onclick="togglePw('prof-new-pw2',this)">👁</button></div></div>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:flex-end;">
        <button class="btn-primary btn-sm" onclick="saveProfilePassword()">🔒 เปลี่ยนรหัสผ่าน</button>
      </div>
    </div>

    <!-- Section: เปลี่ยน Passkey -->
    <div style="padding:16px;">
      <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">🔑 Passkey</div>
      <div id="profile-passkey-status" style="margin-bottom:12px;font-size:13px;color:var(--muted);">กำลังตรวจสอบ...</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group" style="margin:0;grid-column:1/-1"><label>Passkey เดิม (ถ้ามี)</label><input id="prof-old-passkey" type="password" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center;"></div>
        <div class="form-group" style="margin:0"><label>Passkey ใหม่ (6 หลัก)</label><input id="prof-new-passkey" type="password" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center;"></div>
        <div class="form-group" style="margin:0"><label>ยืนยัน Passkey ใหม่</label><input id="prof-new-passkey2" type="password" inputmode="numeric" maxlength="6" placeholder="••••••" style="letter-spacing:4px;text-align:center;"></div>
      </div>
      <div style="margin-top:12px;display:flex;justify-content:flex-end;">
        <button class="btn-primary btn-sm" onclick="saveProfilePasskey()">🔑 บันทึก Passkey</button>
      </div>
    </div>
  </div>`;

  apiCall('GET',`/api/users/${escapeHtml(u.username)}/passkey-status`).then(r=>{
    const el=document.getElementById('profile-passkey-status');
    if(el&&r) el.innerHTML=r.hasPasskey
      ?'<span class="passkey-chip set">✅ ตั้ง Passkey แล้ว</span>'
      :'<span class="passkey-chip unset">❌ ยังไม่ได้ตั้ง Passkey — กรอกแค่ Passkey ใหม่ได้เลย</span>';
  });
}

async function saveProfileInfo(){
  const fullName=(document.getElementById('prof-fullname')?.value||'').trim();
  const nickname=(document.getElementById('prof-nickname')?.value||'').trim();
  const department=(document.getElementById('prof-dept')?.value||'').trim();
  const location=(document.getElementById('prof-location')?.value||'').trim();
  if(!fullName){ showToast('กรุณากรอกชื่อ-นามสกุล','error'); return; }
  const res=await apiCall('PUT','/api/users/me/profile',{fullName,nickname,department,location});
  if(!res){ showToast('บันทึกไม่สำเร็จ','error'); return; }
  // Update cache
  const users=getUsers();
  const idx=users.findIndex(u=>u.username===res.username);
  if(idx>=0) users[idx]={...users[idx],...res};
  else users.push(res);
  localStorage.setItem(K.users,JSON.stringify(users));
  store.setObj(K.session,{username:res.username,loginAt:Date.now()});
  showToast('บันทึกข้อมูลเรียบร้อย ✅','success');
  renderProfile();
}

async function saveProfilePassword(){
  const passkey=(document.getElementById('prof-pw-passkey')?.value||'').trim();
  const newPassword=(document.getElementById('prof-new-pw')?.value||'').trim();
  const newPassword2=(document.getElementById('prof-new-pw2')?.value||'').trim();
  if(!passkey||!/^\d{6}$/.test(passkey)){ showToast('กรุณากรอก Passkey 6 หลัก','error'); return; }
  if(!newPassword||newPassword.length<6){ showToast('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร','error'); return; }
  if(newPassword!==newPassword2){ showToast('รหัสผ่านไม่ตรงกัน','error'); return; }
  const res=await apiCall('PUT','/api/users/me/password',{passkey,newPassword});
  if(!res){ showToast('เปลี่ยนรหัสผ่านไม่สำเร็จ','error'); return; }
  showToast('เปลี่ยนรหัสผ่านเรียบร้อย ✅','success');
  document.getElementById('prof-pw-passkey').value='';
  document.getElementById('prof-new-pw').value='';
  document.getElementById('prof-new-pw2').value='';
}

async function saveProfilePasskey(){
  const oldPasskey=(document.getElementById('prof-old-passkey')?.value||'').trim();
  const newPasskey=(document.getElementById('prof-new-passkey')?.value||'').trim();
  const newPasskey2=(document.getElementById('prof-new-passkey2')?.value||'').trim();
  if(!newPasskey||!/^\d{6}$/.test(newPasskey)){ showToast('Passkey ใหม่ต้องเป็นตัวเลข 6 หลัก','error'); return; }
  if(newPasskey!==newPasskey2){ showToast('Passkey ใหม่ไม่ตรงกัน','error'); return; }
  const body={newPasskey};
  if(oldPasskey) body.oldPasskey=oldPasskey;
  const res=await apiCall('PUT','/api/users/me/passkey',body);
  if(!res){ showToast('บันทึก Passkey ไม่สำเร็จ','error'); return; }
  showToast('บันทึก Passkey เรียบร้อย ✅','success');
  document.getElementById('prof-old-passkey').value='';
  document.getElementById('prof-new-passkey').value='';
  document.getElementById('prof-new-passkey2').value='';
  renderProfile();
}

// ===================================================================
// ADMIN PANEL
// ===================================================================
let adminTab='members';
function renderAdmin(){
  setPageTitle('Admin Panel','⚙️');
  const user=getCurrentUser(); if(!hasAdminAccess(user)){document.getElementById('page-body').innerHTML='<p>ไม่มีสิทธิ์</p>';return;}
  renderAdminTab(adminTab);
}
function renderAdminTab(tab){
  adminTab=tab;
  const tabs=['members','docs','roles','storage','settings','dbsync'];
  const labels=['สมาชิก','เอกสาร','บทบาท','แผนก/จัดเก็บ','ตั้งค่า','🔄 DB Sync'];
  const tabBar=tabs.map((t,i)=>`<div class="admin-tab${t===tab?' active':''}" onclick="renderAdminTab('${t}')">${labels[i]}</div>`).join('');
  let content='';
  if(tab==='members'){
    const users=getUsers();
    const sel=adminSelectedUser;
    // BUG1-fix: hoist getDocs outside loop (was O(N²))
    const allDocs=getDocs();
    const listItems=users.map(u=>{
      // BUG10-fix: safe initials — filter empty words first
      const words=(u.fullName||'?').trim().split(/\s+/).filter(Boolean);
      const initials=(words.length>=2?words[0][0]+words[words.length-1][0]:words[0]?words[0].slice(0,2):'??').toUpperCase();
      return `<div class="user-list-item${sel===u.username?' selected':''}" onclick="selectAdminUser('${escapeHtml(u.username)}')">
        <div class="uli-avatar">${initials}</div>
        <div class="uli-info">
          <div class="uli-name">${escapeHtml(u.fullName)}</div>
          <div class="uli-meta">@${escapeHtml(u.username)} · <span class="badge ${hasAdminAccess(u)?'badge-admin':'badge-user'}" style="font-size:10px;padding:1px 6px;">${getRoleName(u.role)}</span></div>
        </div>
      </div>`;
    }).join('');
    const _rawDetail = sel ? renderUserDetailPanel(sel) : '';
    // BUG6-fix: if user deleted or not found, fall back to empty state
    const _emptyState = `<div class="user-detail-panel admin-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg><p style="font-weight:700;font-size:14px;">เลือกสมาชิก</p><p style="font-size:12px;margin-top:4px;">คลิกชื่อทางซ้ายเพื่อดู/แก้ไขข้อมูล</p></div>`;
    const detailPanel = _rawDetail || _emptyState;
    // If only 1 user (seeded admin) → auto-fetch fresh list in background
    if (users.length <= 1) {
      ensureUsersLoaded(() => renderAdminTab('members'));
    }
    content=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="color:var(--muted);font-size:13px;font-weight:500;">สมาชิกทั้งหมด <strong style="color:var(--text)" id="members-count">${users.length}</strong> คน</span>
        <button onclick="refreshMembersList()" id="members-refresh-btn" title="รีเฟรชรายชื่อ"
          style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;color:var(--muted);display:flex;align-items:center;gap:4px;">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          รีเฟรช
        </button>
      </div>
      <button class="btn-primary btn-sm" onclick="openAddMemberModal()">+ เพิ่มสมาชิก</button>
    </div>
    <div class="admin-layout">
      <div class="user-list-panel">
        <div class="user-list-header"><span style="font-weight:700;font-size:13px;">รายชื่อสมาชิก</span></div>
        <div class="user-list-search"><input type="text" placeholder="🔍 ค้นหาชื่อหรือ username..." oninput="filterUserList(this.value)" id="user-search-input"></div>
        <div id="user-list-body">${listItems}</div>
      </div>
      ${detailPanel}
    </div>`;
  } else if(tab==='docs'){
    const docs=getDocs().sort((a,b)=>b.createdAt-a.createdAt);
    const sel=adminSelectedDoc||null;
    const selDoc=sel?getDocById(sel):null;
    const rowsHtml=docs.length===0?'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;">ยังไม่มีเอกสาร</td></tr>':
      docs.map(d=>`<tr class="log-row-clickable${sel===d.id?' selected':''}" onclick="selectAdminDoc('${d.id}')">
        <td><code style="font-size:11px;color:var(--blue)">${d.id}</code></td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.title)}</td>
        <td>${escapeHtml(d.senderFullName)}</td>
        <td>${formatDateShort(d.createdAt)}</td>
        <td>${d.status==='received'?'<span class="badge badge-received">รับแล้ว</span>':'<span class="badge badge-pending">รอรับ</span>'}</td>
        <td style="white-space:nowrap;">
          <button class="btn-icon" onclick="event.stopPropagation();navigate('qr',{docId:'${d.id}'})" title="QR Viewer">QR</button>
          <button class="btn-icon" style="color:var(--red);margin-left:4px;" onclick="event.stopPropagation();deleteDoc('${d.id}')" title="ลบเอกสาร">🗑</button>
        </td>
      </tr>`).join('');
    const detailHtml=selDoc?`
      <div class="adp-header">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(selDoc.title)}</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px;">${selDoc.id} · ${formatDate(selDoc.createdAt)}</div>
        </div>
        <button class="btn-icon" onclick="adminSelectedDoc=null;renderAdminTab('docs')" style="flex-shrink:0;">✕</button>
      </div>
      <div class="adp-body">
        <div class="ddc-row"><span class="ddc-label">จาก</span><span>${escapeHtml(selDoc.senderFullName)} · ${escapeHtml(selDoc.senderDepartment)}</span></div>
        <div class="ddc-row"><span class="ddc-label">ถึง</span><span>${escapeHtml(selDoc.recipientFullName||selDoc.recipientDepartment||'')}</span></div>
        <div class="ddc-row"><span class="ddc-label">สถานะ</span>${selDoc.status==='received'?'<span class="badge badge-received">รับแล้ว ✓</span>':'<span class="badge badge-pending">รอรับ</span>'}</div>
        ${selDoc.status==='received'?`<div class="ddc-row"><span class="ddc-label">เก็บที่</span><span>${escapeHtml(selDoc.storageLocation||'')}</span></div>`:''}
        <div style="margin-top:14px;"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">📄 เนื้อหาเอกสาร</div>${renderDocContent(selDoc)}</div>
        ${selDoc.attachments&&selDoc.attachments.length>0?`<div style="margin-top:10px;"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px;">📎 ไฟล์แนบ (${selDoc.attachments.length})</div><div class="attachment-list">${selDoc.attachments.map(a=>{const btn=a.cloudinaryUrl?`<a class="att-view" href="${escapeHtml(a.cloudinaryUrl)}" target="_blank" download="${escapeHtml(a.name)}">⬇ ดาวน์โหลด</a>`:a.driveId?`<a class="att-view" href="${escapeHtml(a.driveUrl||'#')}" target="_blank">🔗 Drive</a>`:a.base64?`<a class="att-view" href="${escapeHtml(a.base64)}" download="${escapeHtml(a.name)}">⬇ ดาวน์โหลด</a>`:'';return`<div class="attachment-item"><span class="att-icon">${fileTypeIcon(a.name)}</span><span class="att-name">${escapeHtml(a.name)}</span><span class="att-size">${formatFileSize(a.size)}</span>${btn}</div>`;}).join('')}</div></div>`:''}
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-primary btn-sm" onclick="navigate('qr',{docId:'${selDoc.id}'})">🔗 ดู QR Viewer</button>
          <button class="btn-outline btn-sm" onclick="uploadDocToGoogleDrive(getDocById('${selDoc.id}'))">☁️ Upload Drive</button>
          <button class="btn-outline btn-sm" onclick="exportSingleDoc('${selDoc.id}')">⬇ Export JSON</button>
          <button class="btn-sm" style="background:var(--red);color:#fff;border:none;border-radius:var(--r);padding:5px 12px;cursor:pointer;font-size:12px;" onclick="deleteDoc('${selDoc.id}')">🗑 ลบเอกสาร</button>
        </div>
        <div style="margin-top:14px;">${renderCommentSection(selDoc)}</div>
      </div>`:`<div class="adp-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg><p style="font-weight:700;font-size:14px;">เลือกเอกสาร</p><p style="font-size:12px;margin-top:4px;">คลิกแถวทางซ้ายเพื่ออ่านเนื้อหา</p></div>`;
    const expiringSoon = docs.filter(d => (Date.now()-d.createdAt) > 27*24*60*60*1000).length;
    content=`<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:13px;color:var(--muted);">เอกสารทั้งหมด <strong style="color:var(--text)">${docs.length}</strong> รายการ</span>
        ${expiringSoon>0?`<span style="font-size:11px;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:6px;padding:2px 8px;">⚠️ ${expiringSoon} รายการจะลบใน 3 วัน</span>`:''}
      </div>
      <div style="display:flex;gap:8px;">
        <span style="font-size:11px;color:var(--muted);align-self:center;">🗑 ลบอัตโนมัติหลัง 30 วัน</span>
        <button class="btn-outline btn-sm" onclick="exportDocs()">⬇️ Export JSON</button>
      </div>
    </div>
    <div class="log-layout">
      <div class="log-panel"><table class="data-table"><thead><tr><th>รหัส</th><th>ชื่อเอกสาร</th><th>จาก</th><th>วันที่</th><th>สถานะ</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <div class="log-detail-panel adp-overlay">${detailHtml}</div>
    </div>`;
  } else if(tab==='roles'){
    const roles=getRoles();
    const PERM_KEYS=['can_send','can_receive','can_view_all','can_manage_users','can_export','can_preview_docs'];
    const roleCardsHtml=roles.map(r=>`
      <div class="role-item">
        <div class="role-item-header">
          <div class="role-item-name">
            <span class="badge badge-normal" style="font-size:13px;padding:3px 10px;">${escapeHtml(r.name)}</span>
            ${r.isDefault?'<span class="role-default-badge">ค่าเริ่มต้น</span>':''}
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            <button class="btn-outline btn-sm" onclick="openEditRoleModal('${escapeHtml(r.id)}')">✏️ แก้ไข</button>
            ${!r.isDefault?`<button class="btn-outline btn-sm" style="color:var(--red);border-color:var(--red);" onclick="deleteRole('${escapeHtml(r.id)}')">🗑 ลบ</button>`:'<span style="font-size:11px;color:var(--muted);">ลบไม่ได้ (ค่าระบบ)</span>'}
          </div>
        </div>
        <div class="role-perms">${PERM_KEYS.map(p=>`<span class="perm-chip${r.permissions[p]?'':' off'}">${r.permissions[p]?'✓ ':''} ${permLabel(p)}</span>`).join('')}</div>
      </div>`).join('');
    content=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <span style="color:var(--muted);font-size:13px;">บทบาทผู้ใช้งาน <strong style="color:var(--text)">${roles.length}</strong> บทบาท</span>
      <button class="btn-primary btn-sm" onclick="openAddRoleModal()">+ สร้างบทบาทใหม่</button>
    </div>
    <div class="role-list">${roleCardsHtml}</div>`;
  } else if(tab==='storage'){
    const locs=getLocations();
    const depts=getDepartments();
    // If data not yet synced, fetch live then re-render
    if(locs.length===0&&depts.length===0){
      ensureLocsLoaded().then(()=>{
        if(getLocations().length>0||getDepartments().length>0) renderAdminTab('storage');
      });
      content=`<div style="text-align:center;padding:40px 20px;color:var(--muted);">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:.4;"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        <div style="font-weight:600;margin-bottom:6px;">กำลังโหลดข้อมูลจากเซิร์ฟเวอร์…</div>
        <div style="font-size:12px;margin-bottom:16px;">หากใช้เวลานานกว่า 10 วินาที กรุณากดรีเฟรช</div>
        <button class="btn-primary btn-sm" onclick="syncFromServer().then(()=>renderAdminTab('storage'))">🔄 รีเฟรชข้อมูล</button>
      </div>`;
      document.getElementById('page-body').innerHTML=`<div class="admin-tabs">${tabs.map((t,i)=>`<div class="admin-tab${t===tab?' active':''}" onclick="renderAdminTab('${t}')">${labels[i]}</div>`).join('')}</div>${content}`;
      return;
    }
    // Locations section
    const locsHtml=locs.map(l=>`<div class="loc-row">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><rect x="2" y="7" width="20" height="14" rx="2"/><polyline points="16,2 12,7 8,2"/></svg>
      <span class="loc-name" style="flex:1;font-size:13px;">${escapeHtml(l)}</span>
      <input class="loc-input" type="text" value="${escapeHtml(l)}" style="display:none;flex:1;padding:4px 8px;border:1px solid var(--blue);border-radius:6px;font-size:13px;background:var(--white);color:var(--text);" onkeydown="if(event.key==='Enter')confirmRename(this,'${escapeHtml(l)}');if(event.key==='Escape')cancelRename(this,'${escapeHtml(l)}')">
      <div class="loc-actions">
        <button class="btn-icon loc-edit-btn" onclick="startRename(this,'${escapeHtml(l)}')">✏️</button>
        <button class="btn-icon loc-save-btn" style="display:none;color:var(--green)" onclick="confirmRename(this.closest('.loc-row').querySelector('.loc-input'),'${escapeHtml(l)}')">✅</button>
        <button class="btn-icon loc-cancel-btn" style="display:none;" onclick="cancelRename(this.closest('.loc-row').querySelector('.loc-input'),'${escapeHtml(l)}')">✕</button>
        <button class="btn-icon" style="color:var(--red)" onclick="removeLocation('${escapeHtml(l)}')">🗑</button>
      </div>
    </div>`).join('');
    // Departments section
    const deptsHtml=depts.map(d=>`<div class="loc-row" id="dept-row-${btoa(encodeURIComponent(d)).replace(/=/g,'')}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
      <span class="loc-name" style="flex:1;font-size:13px;">${escapeHtml(d)}</span>
      <input class="loc-input" type="text" value="${escapeHtml(d)}" style="display:none;flex:1;padding:4px 8px;border:1px solid var(--blue);border-radius:6px;font-size:13px;background:var(--white);color:var(--text);" onkeydown="if(event.key==='Enter')confirmRenameDept(this,'${escapeHtml(d)}');if(event.key==='Escape')cancelRename(this,'${escapeHtml(d)}')">
      <div class="loc-actions">
        <button class="btn-icon loc-edit-btn" onclick="startRename(this,'${escapeHtml(d)}')">✏️</button>
        <button class="btn-icon loc-save-btn" style="display:none;color:var(--green)" onclick="confirmRenameDept(this.closest('.loc-row').querySelector('.loc-input'),'${escapeHtml(d)}')">✅</button>
        <button class="btn-icon loc-cancel-btn" style="display:none;" onclick="cancelRename(this.closest('.loc-row').querySelector('.loc-input'),'${escapeHtml(d)}')">✕</button>
        <button class="btn-icon" style="color:var(--red)" onclick="removeDept('${escapeHtml(d)}')">🗑</button>
      </div>
    </div>`).join('');
    content=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;">
      <div class="card-section">
        <div class="card-section-header">📦 สถานที่จัดเก็บเอกสาร <button class="btn-primary btn-sm" onclick="addLocation()">+ เพิ่ม</button></div>
        <div class="card-section-body" id="loc-list">${locsHtml}</div>
      </div>
      <div class="card-section">
        <div class="card-section-header">🏢 แผนก <button class="btn-primary btn-sm" onclick="addDept()">+ เพิ่ม</button></div>
        <div class="card-section-body" id="dept-list">${deptsHtml}
          <div style="font-size:11px;color:var(--muted);margin-top:8px;">⚠️ การเปลี่ยนชื่อแผนกไม่ได้อัปเดตข้อมูล user เดิมโดยอัตโนมัติ</div>
        </div>
      </div>
    </div>`;
  } else if(tab==='settings'){
    const locs=getLocations();
    const gd=getGDriveConfig();
    const driveStatus=gd.enabled&&gd.clientId?'gdrive-connected':'gdrive-disconnected';
    const driveStatusTxt=gd.enabled&&gd.clientId?'● เชื่อมต่อแล้ว':'● ยังไม่เชื่อมต่อ';
    content=`<div class="card-section" style="margin-bottom:16px;">
      <div class="card-section-header" style="display:flex;align-items:center;gap:10px;">
        <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" style="width:18px;height:18px;" alt="">
        Google Drive Integration
        <span class="gdrive-status ${driveStatus}">${driveStatusTxt}</span>
      </div>
      <div class="card-section-body">
        <div class="form-row" style="margin-bottom:10px;">
          <div class="form-group"><label>OAuth2 Client ID</label><input type="text" id="gd-client-id" value="${escapeHtml(gd.clientId||'')}" placeholder="xxx.apps.googleusercontent.com"></div>
          <div class="form-group"><label>Folder ID (เว้นว่าง = My Drive)</label><input type="text" id="gd-folder-id" value="${escapeHtml(gd.folderId||'')}" placeholder="1BxiMVs0XRA..."></div>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;">
            <input type="checkbox" id="gd-enabled" ${gd.enabled?'checked':''} style="width:15px;height:15px;">
            เปิดใช้งาน Google Drive
          </label>
          <button class="btn-primary btn-sm" onclick="saveGDriveSettings()">💾 บันทึกการตั้งค่า</button>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6;">
          ⓘ ต้องสร้าง OAuth2 Client ID ใน <a href="https://console.cloud.google.com" target="_blank" style="color:var(--blue)">Google Cloud Console</a> แล้วเพิ่ม domain ของเว็บใน Authorized JavaScript Origins
        </div>
      </div>
    </div>
    <div class="card-section" style="margin-bottom:16px;">
      <div class="card-section-header" style="display:flex;align-items:center;gap:10px;">
        📧 Email Notification (SMTP)
        <span id="email-status-badge" class="gdrive-status gdrive-disconnected">● ตรวจสอบ...</span>
      </div>
      <div class="card-section-body">
        <div id="email-status-detail" style="font-size:13px;color:var(--muted);margin-bottom:10px;">กำลังโหลดสถานะ...</div>
        <div style="background:#f8f7ff;border-left:4px solid var(--blue);padding:14px;border-radius:8px;font-size:12px;line-height:1.8;color:var(--muted);">
          <strong style="color:var(--text);">วิธีตั้งค่า SMTP บน Render.com:</strong><br>
          ไปที่ Dashboard → Service → Environment → Add Environment Variable<br>
          <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;">SMTP_HOST</code> — เช่น <code>smtp.gmail.com</code><br>
          <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;">SMTP_PORT</code> — <code>587</code> (TLS) หรือ <code>465</code> (SSL)<br>
          <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;">SMTP_USER</code> — อีเมลผู้ส่ง<br>
          <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;">SMTP_PASS</code> — รหัสผ่านหรือ App Password<br>
          <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;">EMAIL_FROM</code> — ชื่อผู้ส่ง (เว้นว่างได้)<br>
        </div>
        <button class="btn-outline btn-sm" style="margin-top:10px;" onclick="checkEmailStatus()">🔄 ตรวจสอบสถานะ</button>
      </div>
    </div>
    <div class="card-section" style="margin-bottom:16px;border-color:rgba(239,68,68,0.25);">
      <div class="card-section-header" style="color:var(--red);">🗑 ล้างข้อมูลในระบบ</div>
      <div class="card-section-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:14px;">
            <div style="font-size:13px;font-weight:700;color:#fca5a5;margin-bottom:4px;">📄 ล้างเอกสารทั้งหมด</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">ลบเอกสารและไฟล์แนบทุกรายการในระบบ รวมถึงประวัติกล่องจดหมาย</div>
            <button onclick="openClearDataModal('docs')" style="background:var(--red);color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;width:100%;">🗑 ล้างเอกสาร</button>
          </div>
          <div style="background:rgba(239,68,68,0.07);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:14px;">
            <div style="font-size:13px;font-weight:700;color:#fca5a5;margin-bottom:4px;">📭 ล้างกล่องจดหมาย</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">ล้างประวัติการแจ้งเตือนของทุก User โดยไม่ลบเอกสาร</div>
            <button onclick="openClearDataModal('notifs')" style="background:rgba(239,68,68,0.7);color:#fff;border:none;border-radius:8px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;width:100%;">📭 ล้างกล่องจดหมาย</button>
          </div>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px;">⚠️ ต้องยืนยันด้วย Passkey ทุกครั้ง — ข้อมูลที่ลบไม่สามารถกู้คืนได้</div>
      </div>
    </div>
    `;
  }
  if(tab==='dbsync'){
    content=`<div class="card-section">
      <div class="card-section-header" style="display:flex;align-items:center;gap:10px;">
        🗄️ ดึงข้อมูลจาก Neon DB (Force Sync)
      </div>
      <div class="card-section-body">
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px;line-height:1.7;">
          ใช้เมื่อข้อมูลบนหน้าเว็บไม่อัปเดต หรือต้องการดึงข้อมูลใหม่จาก PostgreSQL โดยตรง<br>
          <span style="color:var(--red);font-size:12px;">⚠️ ระบบจะส่งสัญญาณ force_sync ไปยังทุก client ที่เปิดอยู่</span>
        </div>
        <button class="btn-primary" id="db-sync-btn" onclick="runDbSync()" style="min-width:180px;">
          🔄 ดึงข้อมูลจาก Neon DB ทันที
        </button>
        <div id="db-sync-log" style="margin-top:16px;font-family:monospace;font-size:12px;background:var(--white);border:1px solid var(--border);border-radius:10px;padding:14px;min-height:80px;max-height:320px;overflow-y:auto;display:none;">
        </div>
      </div>
    </div>`;
  }
  document.getElementById('page-body').innerHTML=`<div class="page-toolbar" style="margin-bottom:8px;"><span class="page-toolbar-label">Admin Panel</span><button id="page-refresh-btn" onclick="forceRefreshPage('admin')" class="refresh-pill-btn" ${canRefreshPage('admin')?'':'disabled'}><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>${canRefreshPage('admin')?'รีเฟรช':'รออีก '+refreshCooldownSecs('admin')+' วิ'}</button></div><div class="admin-tabs">${tabBar}</div>${content}`;
  if(tab==='settings') setTimeout(checkEmailStatus, 100);
}

// ── Admin: Force DB Sync ────────────────────────────────────────────────────
async function runDbSync(){
  const btn=document.getElementById('db-sync-btn');
  const logEl=document.getElementById('db-sync-log');
  if(!btn||!logEl) return;
  btn.disabled=true; btn.textContent='⏳ กำลังดึงข้อมูล...';
  logEl.style.display='block';
  logEl.innerHTML='<span style="color:var(--muted);">เริ่มต้น...</span><br>';
  const t0=Date.now();
  const appendLog=(msg,ok=true)=>{
    const color=ok?'var(--green)':'var(--red)';
    const ms=Date.now()-t0;
    logEl.innerHTML+=`<span style="color:${color};">[${ms}ms] ${escapeHtml(msg)}</span><br>`;
    logEl.scrollTop=logEl.scrollHeight;
  };
  try {
    appendLog('เชื่อมต่อ server...');
    const res=await apiCall('GET','/api/admin/db-status');
    if(!res){ appendLog('ไม่สามารถเชื่อมต่อ server ได้','error',false); return; }
    (res.log||[]).forEach(l=>appendLog(l.msg, l.ok));
    if(res.ok){
      appendLog(`✅ Force sync สำเร็จ รวม ${res.totalMs}ms`);
      await syncFromServer();
      appendLog('Client sync เสร็จแล้ว — หน้าจอจะอัปเดตทันที');
      showToast('ดึงข้อมูลจาก Neon DB สำเร็จ ✓','success');
    } else {
      appendLog('❌ เกิดข้อผิดพลาด: '+(res.error||'unknown'), false);
    }
  } catch(e){
    appendLog('❌ Error: '+e.message, false);
  } finally {
    btn.disabled=false; btn.textContent='🔄 ดึงข้อมูลจาก Neon DB ทันที';
  }
}

// ── Admin: User selection & detail panel ──────────────────────────────────
let adminSelectedUser=null;

function selectAdminUser(username){
  adminSelectedUser=username;
  renderAdminTab('members');
  setTimeout(()=>{
    const el=document.querySelector('.user-list-item.selected');
    if(el) el.scrollIntoView({block:'nearest'});
    // load passkey status for selected user
    checkPasskeyStatus(username, `admin-passkey-status-${username}`);
  },80);
}

function filterUserList(q){
  // BUG9-fix: search only name+username (data-search attr), not badge role text
  const items=document.querySelectorAll('#user-list-body .user-list-item');
  const lq=q.toLowerCase().trim();
  items.forEach(el=>{
    const name=(el.querySelector('.uli-name')?.textContent||'').toLowerCase();
    const meta=(el.querySelector('.uli-meta')?.textContent||'').toLowerCase();
    el.style.display=(!lq||name.includes(lq)||meta.includes(lq))?'':'none';
  });
}

function renderUserDetailPanel(username){
  const u=findUser(username); if(!u) return '';
  const cur=getCurrentUser();
  const docs=getDocs();
  const sent=docs.filter(d=>d.senderUsername===u.username).length;
  const received=docs.filter(d=>d.recipientUsername===u.username&&d.status==='received').length;
  const pending=docs.filter(d=>d.recipientUsername===u.username&&d.status==='pending').length;
  const initials=(u.fullName||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const isSelf=u.username===cur.username;
  const locs=getLocations();
  const locOpts=locs.map(l=>`<option${u.location===l?' selected':''}>${escapeHtml(l)}</option>`).join('');
  const roleOpts=getRoles().map(r=>`<option value="${escapeHtml(r.id)}"${u.role===r.id?' selected':''}>${escapeHtml(r.name)}</option>`).join('');
  return `<div class="user-detail-panel">
    <div class="udp-header">
      <div class="udp-avatar">${initials}</div>
      <div>
        <div class="udp-name">${u.nickname?escapeHtml(u.nickname)+' <span style="font-size:13px;font-weight:400;color:var(--muted);">('+escapeHtml(u.fullName)+')</span>':escapeHtml(u.fullName)}</div>
        <div class="udp-sub">@${escapeHtml(u.username)} · สมัครเมื่อ ${formatDate(u.createdAt)}</div>
        <span class="badge ${hasAdminAccess(u)?'badge-admin':'badge-user'}" style="margin-top:5px;">${getRoleName(u.role)}</span>
        ${isSelf?'<span class="badge" style="margin-left:6px;margin-top:5px;background:rgba(16,185,129,0.1);color:var(--green);border:1px solid rgba(16,185,129,0.2);">ตัวเอง</span>':''}
      </div>
    </div>
    <div class="udp-body">
      <div class="udp-section">
        <div class="udp-section-title">📊 สถิติเอกสาร</div>
        <div class="udp-stats">
          <div class="udp-stat"><div class="udp-stat-num">${sent}</div><div class="udp-stat-label">ส่งแล้ว</div></div>
          <div class="udp-stat"><div class="udp-stat-num" style="color:var(--green)">${received}</div><div class="udp-stat-label">รับแล้ว</div></div>
          <div class="udp-stat"><div class="udp-stat-num" style="color:var(--amber)">${pending}</div><div class="udp-stat-label">รอรับ</div></div>
        </div>
      </div>
      <div class="udp-section">
        <div class="udp-section-title">✏️ ข้อมูลส่วนตัว</div>
        <div class="udp-grid">
          <div class="form-group"><label>ชื่อ-นามสกุล</label><input id="edit-fullname" type="text" value="${escapeHtml(u.fullName)}"></div>
          <div class="form-group"><label>ชื่อเล่น</label><input id="edit-nickname" type="text" value="${escapeHtml(u.nickname||'')}" placeholder="ชื่อเล่น (ไม่บังคับ)"></div>
          <div class="form-group"><label>Username</label><input id="edit-username" type="text" value="${escapeHtml(u.username)}"${isSelf?' disabled':''}></div>
          <div class="form-group" style="grid-column:1/-1"><label>อีเมล</label><input id="edit-email" type="email" value="${escapeHtml(u.email)}"></div>
        </div>
      </div>
      <div class="udp-section">
        <div class="udp-section-title">🏢 แผนก & สิทธิ์</div>
        <div class="udp-grid">
          <div class="form-group"><label>แผนก</label><select id="edit-dept" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r);font-size:13px;background:var(--white);color:var(--text);">${getDepartments().map(d=>`<option value="${escapeHtml(d)}" ${u.department===d?'selected':''}>${escapeHtml(d)}</option>`).join('')}</select></div>
          <div class="form-group"><label>สถานที่</label><select id="edit-location">${locOpts}</select></div>
          <div class="form-group"><label>Role</label><select id="edit-role"${isSelf?' disabled':''}>${roleOpts}</select></div>
        </div>
      </div>
      <div class="udp-section">
        <div class="udp-section-title">🔒 รีเซ็ตรหัสผ่าน (เว้นว่างถ้าไม่เปลี่ยน)</div>
        <div class="udp-grid">
          <div class="form-group"><label>รหัสผ่านใหม่</label><div class="pw-wrap"><input id="edit-pw" type="password" placeholder="อย่างน้อย 6 ตัว"><button type="button" class="pw-toggle" onclick="togglePw('edit-pw',this)">👁</button></div></div>
          <div class="form-group"><label>ยืนยันรหัสผ่าน</label><div class="pw-wrap"><input id="edit-pw2" type="password" placeholder="••••••"><button type="button" class="pw-toggle" onclick="togglePw('edit-pw2',this)">👁</button></div></div>
        </div>
      </div>
    </div>
      <div class="udp-section">
        <div class="udp-section-title">🔑 Passkey</div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div id="admin-passkey-status-${escapeHtml(u.username)}" style="font-size:13px;color:var(--muted);">กำลังตรวจสอบ...</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${isSelf?`<button class="btn-outline btn-sm" onclick="openPasskeySetupModal()">✏️ ตั้ง/เปลี่ยน Passkey</button>`:`
            <button class="btn-outline btn-sm" style="color:var(--red);border-color:var(--red);" onclick="adminClearPasskey('${escapeHtml(u.username)}')">🗑 ล้าง Passkey</button>
            <button class="btn-outline btn-sm" onclick="adminSetPasskeyModal('${escapeHtml(u.username)}')">🔑 ตั้ง Passkey ใหม่</button>`}
          </div>
        </div>
      </div>
    </div>
    <div class="udp-footer">
      <button class="btn-danger btn-sm" onclick="confirmDeleteMember('${escapeHtml(u.username)}')"${isSelf?' disabled':''}>🗑 ลบบัญชี</button>
      <div style="display:flex;gap:8px;">
        <button class="btn-outline btn-sm" onclick="adminSelectedUser=null;renderAdminTab('members')">ยกเลิก</button>
        <button class="btn-primary btn-sm" onclick="saveUserEdit('${escapeHtml(u.username)}')">💾 บันทึกการเปลี่ยนแปลง</button>
      </div>
    </div>
  </div>`;
}

async function saveUserEdit(oldUsername){
  const fullName=document.getElementById('edit-fullname')?.value.trim();
  const editNickname=(document.getElementById('edit-nickname')?.value||'').trim();
  const newUsername=(document.getElementById('edit-username')?.value||oldUsername).trim().toLowerCase();
  const email=document.getElementById('edit-email')?.value.trim();
  const department=document.getElementById('edit-dept')?.value.trim();
  const location=(document.getElementById('edit-location')?.value||'').trim(); // BUG7-fix: trim
  // BUG4-fix: preserve current role if field is disabled/missing; never set undefined
  const roleEl=document.getElementById('edit-role');
  const role=(roleEl&&!roleEl.disabled&&roleEl.value)?roleEl.value:null;
  const pw=(document.getElementById('edit-pw')?.value||'').trim();   // BUG8-fix: trim
  const pw2=(document.getElementById('edit-pw2')?.value||'').trim(); // BUG8-fix: trim

  if(!fullName||!email||!department||!location){showToast('กรุณากรอกข้อมูลให้ครบ','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showToast('รูปแบบอีเมลไม่ถูกต้อง','error');return;}
  if(newUsername!==oldUsername&&!/^[a-z0-9_]{3,32}$/.test(newUsername)){showToast('Username ต้องเป็น a-z, 0-9, _ ยาว 3-32 ตัว','error');return;}

  const users=getUsers();
  const idx=users.findIndex(u=>u.username===oldUsername);
  if(idx<0){showToast('ไม่พบผู้ใช้','error');return;}

  // Check duplicate username
  if(newUsername!==oldUsername&&users.find(u=>u.username===newUsername)){showToast('Username นี้มีคนใช้แล้ว','error');return;}
  // Check duplicate email
  if(email!==users[idx].email&&users.find(u=>u.email===email)){showToast('อีเมลนี้มีคนใช้แล้ว','error');return;}
  // Password validation
  if(pw||pw2){
    if(pw.length<6){showToast('รหัสผ่านต้องอย่างน้อย 6 ตัว','error');return;}
    if(pw!==pw2){showToast('รหัสผ่านและยืนยันไม่ตรงกัน','error');return;}
  }

  // Apply changes
  users[idx].fullName=fullName;
  users[idx].email=email;
  users[idx].department=department;
  users[idx].location=location;
  if(newUsername!==oldUsername) users[idx].username=newUsername;
  const cur=getCurrentUser();
  if(role!==null&&!(oldUsername===cur.username&&cur.role==='admin')) users[idx].role=role; // BUG4-fix
  if(pw){
    users[idx].passwordHash=await hashPassword(pw);
  }
  const res=await apiCall('PUT','/api/users/'+oldUsername,{fullName,nickname:editNickname,email,department,location,role:role||users[idx].role,password:pw||undefined});
  if(!res||res.error){showToast(res?.error||'บันทึกไม่สำเร็จ','error');return;}
  await syncFromServer();
  adminSelectedUser=newUsername!==oldUsername?newUsername:oldUsername;
  showToast('บันทึกข้อมูลเรียบร้อย ✓');
  renderAdminTab('members');
}

async function refreshMembersList() {
  const btn = document.getElementById('members-refresh-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:spin 1s linear infinite"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> กำลังโหลด…'; }
  try {
    // Fetch users directly (bypass sync) for guaranteed fresh data
    const data = await apiCall('GET', '/api/users');
    if (Array.isArray(data) && data.length > 0) {
      localStorage.setItem(K.users, JSON.stringify(data));
      showToast(`โหลดสมาชิก ${data.length} คน ✓`);
    }
    // Also do a full sync in background
    syncFromServer().catch(()=>{});
  } catch(e) {
    showToast('โหลดไม่สำเร็จ: ' + e.message, 'error');
  }
  renderAdminTab('members');
}

function confirmDeleteMember(username){
  const cur=getCurrentUser(); if(username===cur.username){showToast('ไม่สามารถลบบัญชีของตัวเองได้','error');return;}
  openModal('ยืนยันการลบ',
    `<p>ต้องการลบสมาชิก <strong>@${escapeHtml(username)}</strong> ใช่หรือไม่?</p><p style="font-size:12px;color:var(--muted);margin-top:6px;">เอกสารที่ส่ง/รับจะยังคงอยู่ในระบบ</p>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button><button class="btn-danger" onclick="deleteMember('${escapeHtml(username)}')">ลบบัญชี</button>`);
}
async function deleteMember(username){
  // Raw fetch to get exact error message from server
  let delRes, delErr;
  try {
    const r = await fetch('/api/users/'+username, {
      method:'DELETE', headers:{'Authorization':'Bearer '+_jwt}
    });
    const data = await r.json();
    if(!r.ok){ delErr = data.error || 'ลบไม่สำเร็จ'; } else { delRes = data; }
  } catch(e){ delErr = 'เชื่อมต่อ server ไม่ได้'; }
  if(delErr||!delRes){ showToast(delErr||'ลบไม่สำเร็จ','error'); return; }
  // Instantly purge from local cache — do not wait for sync
  store.set(K.users, getUsers().filter(u=>u.username!==username));
  if(adminSelectedUser===username) adminSelectedUser=null;
  closeModal();
  renderAdminTab('members');
  showToast('ลบบัญชีแล้ว ✓');
  // Background sync to confirm fresh data
  syncFromServer().then(()=>renderAdminTab('members')).catch(()=>{});
}
async function addDept(){
  const name=(prompt('ชื่อแผนกใหม่:','')||'').trim();
  if(!name) return;
  const res=await apiCall('POST','/api/departments',{name});
  if(res?.ok){
    // Optimistic update: add to local cache immediately
    const cur=getDepartments();
    if(!cur.includes(name)){ cur.push(name); localStorage.setItem(K.depts,JSON.stringify(cur)); }
    renderAdminTab('storage');
    showToast('เพิ่มแผนกแล้ว');
    syncFromServer().catch(()=>{});
  } else showToast(res?.error||'เพิ่มไม่สำเร็จ','error');
}
async function confirmRenameDept(input, oldName){
  const newName=(input.value||'').trim();
  if(!newName||newName===oldName){cancelRename(input,oldName);return;}
  const res=await apiCall('PUT','/api/departments/'+encodeURIComponent(oldName),{name:newName});
  if(res?.ok){
    localStorage.setItem(K.depts, JSON.stringify(getDepartments().map(d=>d===oldName?newName:d)));
    renderAdminTab('storage');
    showToast('เปลี่ยนชื่อแล้ว');
    syncFromServer().catch(()=>{});
  } else showToast(res?.error||'แก้ไขไม่สำเร็จ','error');
}
async function removeDept(name){
  if(!confirm('ลบแผนก "'+name+'"? \nUser ที่อยู่ในแผนกนี้จะยังคงมีค่าแผนกเดิม')) return;
  const res=await apiCall('DELETE','/api/departments/'+encodeURIComponent(name));
  if(res?.ok){
    localStorage.setItem(K.depts, JSON.stringify(getDepartments().filter(d=>d!==name)));
    renderAdminTab('storage');
    showToast('ลบแผนกแล้ว');
    syncFromServer().catch(()=>{});
  } else showToast(res?.error||'ลบไม่สำเร็จ','error');
}
async function addLocation(){
  const n=(prompt('ชื่อสถานที่จัดเก็บ:','')||'').trim();
  if(!n) return;
  const res=await apiCall('POST','/api/locations',{name:n});
  if(res?.ok){
    const cur=getLocations();
    if(!cur.includes(n)){ cur.push(n); localStorage.setItem(K.locs,JSON.stringify(cur)); }
    renderAdminTab('storage');
    showToast('เพิ่มสถานที่แล้ว');
    syncFromServer().catch(()=>{});
  } else showToast(res?.error||'เพิ่มไม่สำเร็จ','error');
}
async function removeLocation(name){
  if(!confirm('ลบ "'+name+'" ?\nเอกสารที่เก็บที่นี่จะยังคงอยู่')) return;
  const res=await apiCall('DELETE','/api/locations/'+encodeURIComponent(name));
  if(res?.ok){
    localStorage.setItem(K.locs, JSON.stringify(getLocations().filter(l=>l!==name)));
    renderAdminTab('storage');
    showToast('ลบสถานที่แล้ว');
    syncFromServer().catch(()=>{});
  } else showToast('ลบไม่สำเร็จ','error');
}

// ─── Location inline rename helpers ───────────────────────────────
function startRename(btn, oldName){
  const row = btn.closest('.loc-row');
  row.querySelector('.loc-name').style.display = 'none';
  const inp = row.querySelector('.loc-input');
  inp.style.display = 'block';
  inp.focus(); inp.select();
  row.querySelector('.loc-edit-btn').style.display = 'none';
  row.querySelector('.loc-save-btn').style.display = 'inline-flex';
  row.querySelector('.loc-cancel-btn').style.display = 'inline-flex';
}

function cancelRename(inp, oldName){
  const row = inp.closest('.loc-row');
  inp.value = oldName;
  inp.style.display = 'none';
  row.querySelector('.loc-name').style.display = 'inline';
  row.querySelector('.loc-edit-btn').style.display = 'inline-flex';
  row.querySelector('.loc-save-btn').style.display = 'none';
  row.querySelector('.loc-cancel-btn').style.display = 'none';
}

async function confirmRename(inp, oldName){
  const newName = inp.value.trim();
  if(!newName){ showToast('ชื่อต้องไม่ว่างเปล่า','error'); return; }
  if(newName === oldName){ cancelRename(inp, oldName); return; }
  const res = await apiCall('PUT','/api/locations/'+encodeURIComponent(oldName),{newName});
  if(res?.ok){
    // Optimistic update local cache immediately
    localStorage.setItem(K.locs, JSON.stringify(getLocations().map(l=>l===oldName?newName:l)));
    showToast(`เปลี่ยนชื่อ "${oldName}" → "${newName}" เรียบร้อย`);
    renderAdminTab('storage');
    syncFromServer().catch(()=>{});
  } else {
    showToast(res?.error||'เปลี่ยนชื่อไม่สำเร็จ','error');
    cancelRename(inp, oldName);
  }
}
function exportDocs(){ const data=JSON.stringify(getDocs(),null,2); const blob=new Blob([data],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`sendfile_docs_${new Date().toISOString().slice(0,10)}.json`; a.click(); showToast('Export เรียบร้อย'); }
function exportSingleDoc(id){ const doc=getDocById(id); if(!doc)return; const blob=new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`${id}.json`; a.click(); showToast('Export เรียบร้อย'); }

// ── Admin: selected doc state ─────────────────────────────────
let adminSelectedDoc=null;
function selectAdminDoc(id){ adminSelectedDoc=adminSelectedDoc===id?null:id; renderAdminTab('docs'); }

// ── Google Drive settings save ────────────────────────────────
async function saveGDriveSettings(){
  const cfg={
    enabled:document.getElementById('gd-enabled')?.checked||false,
    clientId:(document.getElementById('gd-client-id')?.value||'').trim(),
    folderId:(document.getElementById('gd-folder-id')?.value||'').trim()
  };
  await apiCall('PUT','/api/settings/gdrive',cfg);
  await syncFromServer();
  showToast('บันทึกการตั้งค่า Google Drive แล้ว');
  renderAdminTab('settings');
}

async function checkEmailStatus(){
  const res = await apiCall('GET','/api/settings/email-status');
  const badge = document.getElementById('email-status-badge');
  const detail = document.getElementById('email-status-detail');
  if(!res){ if(badge)badge.textContent='● ตรวจสอบไม่ได้'; return; }
  if(badge){
    badge.className='gdrive-status '+(res.configured?'gdrive-connected':'gdrive-disconnected');
    badge.textContent=res.configured?'● เชื่อมต่อแล้ว':'● ยังไม่ตั้งค่า';
  }
  if(detail){
    detail.innerHTML=res.configured
      ? `<strong style="color:var(--green);">✅ SMTP พร้อมใช้งาน</strong> — Host: <code>${res.host}</code><br>ระบบจะส่งอีเมลแจ้งเตือนอัตโนมัติเมื่อมีการส่งเอกสาร`
      : '<span style="color:var(--amber);">⚠️ ยังไม่ได้ตั้งค่า SMTP</span> — ระบบจะไม่ส่งอีเมลแจ้งเตือน กรุณาตั้งค่าตามคำแนะนำด้านล่าง';
  }
}

// ── Role CRUD ─────────────────────────────────────────────────
const PERM_KEYS=['can_send','can_receive','can_view_all','can_manage_users','can_export','can_preview_docs'];
const PERM_DEFAULTS={can_send:true,can_receive:true,can_view_all:false,can_manage_users:false,can_export:false,can_preview_docs:false};
function openAddRoleModal(){ openAddRoleModalInner(null); }
function openEditRoleModal(id){ const r=getRoleById(id); openAddRoleModalInner(r); }
function openAddRoleModalInner(existing){
  const r=existing||{id:'',name:'',isDefault:false,permissions:{...PERM_DEFAULTS}};
  // Merge with defaults so every key is present even on old/partial permission objects
  const perms=Object.assign({...PERM_DEFAULTS}, r.permissions||{});
  const permChecks=PERM_KEYS.map(p=>`<label class="perm-check"><input type="checkbox" id="perm-${p}" ${perms[p]?'checked':''}>${permLabel(p)}</label>`).join('');
  openModal(existing?'แก้ไขบทบาท':'สร้างบทบาทใหม่',`
    <div class="form-group"><label>ชื่อบทบาท *</label><input type="text" id="new-role-name" value="${escapeHtml(r.name)}" placeholder="เช่น Manager, HR, Viewer"></div>
    <div style="margin-top:14px;"><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:10px;">สิทธิ์การใช้งาน</div>
    <div class="perm-grid">${permChecks}</div></div>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button>
     <button class="btn-primary" onclick="saveRole('${escapeHtml(existing?r.id:'')}')">💾 บันทึก</button>`);
}
async function saveRole(existingId){
  const name=(document.getElementById('new-role-name')?.value||'').trim();
  if(!name){showToast('กรุณาระบุชื่อบทบาท','error');return;}
  // Guard: if modal was destroyed by a re-render, checkboxes won't exist
  const firstEl=document.getElementById('perm-'+PERM_KEYS[0]);
  if(!firstEl){showToast('เกิดข้อผิดพลาด กรุณาเปิดหน้าต่างแก้ไขใหม่อีกครั้ง','error');return;}
  const perms={};
  PERM_KEYS.forEach(p=>{perms[p]=document.getElementById('perm-'+p)?.checked||false;});
  let res;
  if(existingId){
    res=await apiCall('PUT','/api/roles/'+existingId,{name,permissions:perms});
  } else {
    const id='role_'+Date.now();
    res=await apiCall('POST','/api/roles',{id,name,permissions:perms});
  }
  if(!res||res.error){showToast(res?.error||'บันทึกไม่สำเร็จ','error');return;}
  // Immediately update K.roles — don't rely on syncFromServer to avoid stale UI
  const roles=getRoles();
  if(existingId){
    const idx=roles.findIndex(r=>r.id===existingId);
    if(idx>=0) roles[idx]={...roles[idx],name,permissions:perms};
  } else {
    roles.push({id:'role_'+Date.now(),name,isDefault:false,permissions:perms});
  }
  localStorage.setItem(K.roles,JSON.stringify(roles));
  closeModal();
  showToast(existingId?'แก้ไขบทบาทแล้ว ✓':'สร้างบทบาทแล้ว ✓');
  renderAdminTab('roles');
  syncFromServer().then(()=>renderAdminTab('roles')).catch(()=>{});
}
async function deleteRole(id){
  if(!confirm('ลบบทบาทนี้?'))return;
  const res=await apiCall('DELETE','/api/roles/'+id);
  if(!res||res.error){showToast(res?.error||'ลบไม่สำเร็จ','error');return;}
  localStorage.setItem(K.roles,JSON.stringify(getRoles().filter(r=>r.id!==id)));
  showToast('ลบบทบาทแล้ว');
  renderAdminTab('roles');
  syncFromServer().then(()=>renderAdminTab('roles')).catch(()=>{});
}

async function openAddMemberModal(){
  await ensureLocsLoaded();
  // BUG3-fix: use getLocations() so custom locations are included
  const locs=getLocations();
  const locOpts=locs.map(l=>`<option>${escapeHtml(l)}</option>`).join('');
  openModal('เพิ่มสมาชิก',`
    <div class="form-row">
      <div class="form-group"><label>ชื่อผู้ใช้ *</label><input id="am-username" type="text" placeholder="somchai01" autocomplete="off"></div>
      <div class="form-group"><label>Role</label><select id="am-role"><option value="user">user</option><option value="admin">admin</option></select></div>
    </div>
    <div class="form-group"><label>อีเมล *</label><input id="am-email" type="email" placeholder="name@company.com"></div>
    <div class="form-group"><label>ชื่อ-นามสกุล *</label><input id="am-fullname" type="text" placeholder="สมชาย มั่นคง"></div>
    <div class="form-row">
      <div class="form-group"><label>แผนก *</label><select id="am-dept" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:var(--r);font-size:13px;background:var(--white);color:var(--text);">${getDepartments().map(d=>`<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('')}</select></div>
      <div class="form-group"><label>สถานที่ *</label><select id="am-loc">${locOpts}</select></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>รหัสผ่าน *</label><div class="pw-wrap"><input id="am-pw" type="password" placeholder="อย่างน้อย 6 ตัว"><button type="button" class="pw-toggle" onclick="togglePw('am-pw',this)">👁</button></div></div>
      <div class="form-group"><label>ยืนยันรหัสผ่าน *</label><div class="pw-wrap"><input id="am-pw2" type="password" placeholder="••••••"><button type="button" class="pw-toggle" onclick="togglePw('am-pw2',this)">👁</button></div></div>
    </div>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button><button class="btn-primary" onclick="submitAddMember()">เพิ่มสมาชิก</button>`);
}
async function submitAddMember(){
  const username=document.getElementById('am-username').value.trim().toLowerCase();
  const email=document.getElementById('am-email').value.trim();
  const fullName=document.getElementById('am-fullname').value.trim();
  const department=document.getElementById('am-dept').value.trim();
  const location=document.getElementById('am-loc').value;
  const role=document.getElementById('am-role')?.value||'user';
  const password=document.getElementById('am-pw').value.trim();
  const confirm=document.getElementById('am-pw2').value.trim();
  if(!username||!email||!fullName||!department||!password){showToast('กรุณากรอกข้อมูลให้ครบ','error');return;}
  if(!/^[a-z0-9_]{3,32}$/.test(username)){showToast('Username: a-z, 0-9, _ เท่านั้น ยาว 3-32 ตัว','error');return;}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){showToast('รูปแบบอีเมลไม่ถูกต้อง','error');return;}
  if(password.length<6){showToast('รหัสผ่านต้องอย่างน้อย 6 ตัว','error');return;}
  if(password!==confirm){showToast('รหัสผ่านและยืนยันไม่ตรงกัน','error');return;}
  if(findUser(username)){showToast('ชื่อผู้ใช้นี้มีอยู่แล้ว','error');return;}
  const users=getUsers();
  if(users.find(u=>u.email===email)){showToast('อีเมลนี้มีอยู่แล้ว','error');return;}
  const res=await apiCall('POST','/api/auth/register',{username,fullName,email,department,location,role,password});
  if(!res||res.error){showToast(res?.error||'เพิ่มสมาชิกไม่สำเร็จ','error');return;}
  await syncFromServer();
  closeModal(); adminSelectedUser=username; renderAdminTab('members'); showToast(`เพิ่ม @${username} (${role}) เรียบร้อย`);
}

// ===================================================================
// MODAL
// ===================================================================
function openModal(title,content,actions='',size=''){
  const box=document.getElementById('modal-box');
  box.className='modal-box'+(size?' modal-'+size:'');
  document.getElementById('modal-title').textContent=title;
  document.getElementById('modal-content').innerHTML=content;
  document.getElementById('modal-actions').innerHTML=actions;
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(){ document.getElementById('modal-overlay').classList.remove('open'); }

function openReceiveModal(docId){
  const locs=getLocations();
  const opts=locs.map(l=>`<option>${escapeHtml(l)}</option>`).join('');
  openModal('✅ รับเอกสาร',`
    <div class="form-group">
      <label>สถานที่จัดเก็บ *</label>
      <select id="receive-loc" style="width:100%;">${opts}</select>
    </div>
    <div class="form-group" style="margin-top:12px;">
      <label>บันทึกการรับเอกสาร <span class="recv-required">* จำเป็น</span></label>
      <textarea id="recv-note" class="recv-note-area" rows="3"
        placeholder="เช่น ได้รับเอกสารถูกต้องเรียบร้อย / ตรวจสอบเอกสารครบแล้ว..."
        oninput="this.classList.remove('error')"></textarea>
      <div style="font-size:11px;color:var(--muted);margin-top:4px;">
        ⚠️ กรุณากรอกบันทึกก่อนกดยืนยัน — ข้อความนี้จะแสดงใน comment ของเอกสาร
      </div>
    </div>`,
    `<button class="btn-outline" onclick="closeModal()">ยกเลิก</button>
     <button class="btn-primary" onclick="confirmReceive('${docId}')">✓ ยืนยันรับเอกสาร</button>`);
  setTimeout(()=>document.getElementById('recv-note')?.focus(),200);
}
async function confirmReceive(docId){
  const loc=document.getElementById('receive-loc')?.value||'';
  const note=(document.getElementById('recv-note')?.value||'').trim();
  if(!note){
    const ta=document.getElementById('recv-note');
    if(ta){ta.classList.add('error');ta.focus();}
    showToast('กรุณากรอกบันทึกการรับเอกสารก่อน','error');
    return;
  }
  await receiveDocument(docId,loc,note);
  // Server already adds "ยืนยันรับ" comment inside PATCH /receive — no duplicate needed
  const user=getCurrentUser();
  // Notify sender
  const updDoc = await apiCall('GET','/api/docs/'+docId) || getDocById(docId);
  if(updDoc){
    // doc_received notification now created server-side
  }
  closeModal(); showToast('รับเอกสารเรียบร้อย ✓'); renderInbox();
}

// ===================================================================
// QR & PRINT
// ===================================================================
function generateQR(elId,url,size=130){
  const el=document.getElementById(elId); if(!el)return;
  el.innerHTML='';
  if(typeof QRCode==='undefined'){ el.innerHTML='<div style="width:'+size+'px;height:'+size+'px;display:flex;align-items:center;justify-content:center;background:#f1f5f9;border-radius:4px;color:var(--muted);font-size:12px;">QR</div>'; return; }
  try{ new QRCode(el,{text:url,width:size,height:size,colorDark:'#111',colorLight:'#fff',correctLevel:QRCode.CorrectLevel.M}); }catch(e){ el.innerHTML='<p style="font-size:12px;color:red">QR error</p>'; }
}

function downloadQR(elId,docId){
  const el=document.getElementById(elId); if(!el)return;
  const canvas=el.querySelector('canvas'); if(!canvas){showToast('ไม่พบ canvas','error');return;}
  const a=document.createElement('a'); a.download=`QR_${docId}.png`; a.href=canvas.toDataURL('image/png'); a.click(); showToast('บันทึก PNG แล้ว');
}

function copyLink(url){ navigator.clipboard.writeText(url).then(()=>showToast('คัดลอก Link แล้ว')).catch(()=>{ prompt('คัดลอก Link:',url); }); }

function printEnvelope(docId){
  const doc=getDocById(docId); if(!doc)return;
  const printArea=document.getElementById('print-area');
  printArea.innerHTML=`
  <div class="envelope-paper">
    <div class="env-header">
      <div style="font-size:9pt;color:#888;margin-bottom:2pt;">ระบบส่งเอกสารภายใน | Internal Document Routing</div>
      <div style="font-size:18pt;font-weight:800;color:#2563eb;">PEO Thailand</div>
      <div style="font-size:8pt;color:#aaa;">${window.location.protocol==='file:'?'localhost':window.location.hostname}</div>
    </div>
    <div class="env-title">${escapeHtml(doc.title)}</div>
    <div style="display:flex;gap:8pt;margin-bottom:10pt;flex-wrap:wrap;">
      <span style="background:#eff6ff;border:1px solid #bfdbfe;color:#1d4ed8;font-size:9pt;padding:2pt 8pt;border-radius:3pt;font-family:monospace;">${doc.id}</span>
      ${doc.priority==='very_urgent'?'<span style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;font-size:9pt;padding:2pt 8pt;border-radius:3pt;font-weight:700;">ด่วนมาก</span>':doc.priority==='urgent'?'<span style="background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:9pt;padding:2pt 8pt;border-radius:3pt;">ด่วน</span>':''}
    </div>
    <div class="env-addr">
      <div class="env-box">
        <div class="env-box-label">จาก (From)</div>
        <div class="env-box-name">${escapeHtml(doc.senderFullName)}</div>
        <div class="env-box-sub">${escapeHtml(doc.senderDepartment)}</div>
        <div class="env-box-sub">${escapeHtml(doc.senderLocation)}</div>
      </div>
      <div class="env-box" style="border-color:#2563eb;background:#f0f6ff;">
        <div class="env-box-label" style="color:#2563eb;">ถึง (To)</div>
        <div class="env-box-name">${escapeHtml(doc.recipientFullName||doc.recipientDepartment||'')}</div>
        <div class="env-box-sub">${doc.recipientDepartment?escapeHtml(doc.recipientDepartment):''}</div>
      </div>
    </div>
    <div class="env-meta">
      <span>📅 ${formatDate(doc.createdAt)}</span>
      ${doc.attachmentNote?`<span>📎 ${escapeHtml(doc.attachmentNote)}</span>`:''}
    </div>
    <div class="env-qr-section">
      <div style="font-size:8pt;color:#888;margin-bottom:6pt;">สแกน QR เพื่อดูรายละเอียดและยืนยันการรับเอกสาร</div>
      <div id="print-qr-box" style="display:inline-flex;border:1px solid #ccc;border-radius:4pt;padding:6pt;background:#fff;"></div>
      <div class="env-qr-url">${escapeHtml(doc.qrUrl)}</div>
      <div style="font-size:8pt;color:#888;margin-top:4pt;">🔒 ต้องล็อกอินเข้าระบบก่อนเปิด Link</div>
    </div>
    <div class="env-footer">พิมพ์เมื่อ ${formatDate(Date.now())} · SendFile — PEO Thailand</div>
  </div>`;
  setTimeout(()=>{
    generateQR('print-qr-box',doc.qrUrl,110);
    setTimeout(()=>{ window.print(); printArea.innerHTML=''; },500);
  },100);
}

// ===================================================================
// ===================================================================
// MOBILE FAB MENU
// ===================================================================
function showFabMenu() {
  if (document.getElementById('fab-menu-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'fab-menu-overlay';
  overlay.className = 'fab-menu-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) closeFabMenu(); };

  overlay.innerHTML = `
    <div class="fab-menu" id="fab-menu">
      <button class="fab-menu-item" onclick="closeFabMenu();navigate('create')">
        <span class="fab-menu-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
        </span>
        <span class="fab-menu-label">สร้างเอกสาร</span>
      </button>
      <button class="fab-menu-item" onclick="closeFabMenu();showQrScanner()">
        <span class="fab-menu-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="5" y="5" width="3" height="3" fill="currentColor" stroke="none"/>
            <rect x="16" y="5" width="3" height="3" fill="currentColor" stroke="none"/>
            <rect x="5" y="16" width="3" height="3" fill="currentColor" stroke="none"/>
            <path d="M14 14h2v2h-2zm4 0h2v2h-2zm-4 4h2v2h-2zm4-2h2v4h-2z"/>
          </svg>
        </span>
        <span class="fab-menu-label">สแกน QR Code</span>
      </button>
    </div>`;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('fab-menu-overlay--open'));
}

function closeFabMenu() {
  const el = document.getElementById('fab-menu-overlay');
  if (!el) return;
  el.classList.remove('fab-menu-overlay--open');
  setTimeout(() => el.remove(), 200);
}

// ── QR Scanner (uses jsQR via CDN) ──────────────────────────────
function showQrScanner() {
  if (document.getElementById('qr-scanner-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'qr-scanner-overlay';
  overlay.className = 'doc-preview-overlay';
  overlay.innerHTML = `
    <div class="doc-preview-card" style="max-width:400px;text-align:center;">
      <div class="doc-preview-header">
        <span style="font-weight:600;font-size:1rem;">สแกน QR Code เอกสาร</span>
        <button class="doc-preview-close" onclick="closeQrScanner()">✕</button>
      </div>
      <div class="doc-preview-body">
        <p style="color:var(--gray);font-size:.85rem;margin-bottom:12px;">เล็งกล้องไปที่ QR Code บนซองเอกสาร</p>
        <div style="position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:1;">
          <video id="qr-video" autoplay playsinline style="width:100%;height:100%;object-fit:cover;"></video>
          <canvas id="qr-canvas" style="display:none;"></canvas>
          <div style="position:absolute;inset:20%;border:2px solid rgba(255,255,255,.7);border-radius:8px;pointer-events:none;"></div>
        </div>
        <div id="qr-status" style="margin-top:10px;color:var(--gray);font-size:.85rem;">กำลังเปิดกล้อง…</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Load jsQR if not already loaded
  if (!window.jsQR) {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    script.onload = () => startQrScan();
    document.head.appendChild(script);
  } else {
    startQrScan();
  }
}

function closeQrScanner() {
  const el = document.getElementById('qr-scanner-overlay');
  if (el) el.remove();
  stopQrScan();
}

let _qrStream = null;
let _qrInterval = null;
function stopQrScan() {
  if (_qrInterval) { clearInterval(_qrInterval); _qrInterval = null; }
  if (_qrStream) { _qrStream.getTracks().forEach(t => t.stop()); _qrStream = null; }
}

async function startQrScan() {
  const video = document.getElementById('qr-video');
  const canvas = document.getElementById('qr-canvas');
  const status = document.getElementById('qr-status');
  if (!video || !canvas) return;

  try {
    _qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = _qrStream;
    video.play();
    if (status) status.textContent = 'กำลังสแกน…';

    _qrInterval = setInterval(() => {
      if (!document.getElementById('qr-video')) { stopQrScan(); return; }
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR && window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        stopQrScan();
        closeQrScanner();
        // Parse URL → extract ?doc= param
        try {
          const url = new URL(code.data);
          const docId = url.searchParams.get('doc');
          if (docId) {
            showDocPreviewScreen(docId);
          } else {
            showToast('QR นี้ไม่ใช่ลิงก์เอกสาร SendFile', 'error');
          }
        } catch(_) {
          showToast('อ่าน QR ไม่ได้: ' + code.data, 'error');
        }
      }
    }, 300);
  } catch(e) {
    if (status) status.textContent = 'ไม่สามารถเปิดกล้องได้: ' + e.message;
  }
}

// ===================================================================
// DOC PREVIEW DEEP LINK SCREEN
// ===================================================================
function showDocPreviewScreen(docId) {
  if (document.getElementById('doc-preview-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'doc-preview-overlay';
  overlay.className = 'doc-preview-overlay';

  overlay.innerHTML = `
    <div class="doc-preview-card">
      <div class="doc-preview-header">
        <div>
          <div style="font-weight:700;font-size:1rem;color:var(--text);">ดูตัวอย่างเอกสาร</div>
          <div style="font-size:.78rem;color:var(--gray);margin-top:2px;">${escapeHtml(docId)}</div>
        </div>
        <button class="doc-preview-close" onclick="closeDocPreview();window.location.href=window.location.pathname">✕</button>
      </div>
      <div class="doc-preview-body">
        <p style="color:var(--gray);font-size:.88rem;margin-bottom:18px;line-height:1.5;">
          กรุณากรอก Passkey 6 หลักของคุณ<br>เพื่อยืนยันตัวตนและดูเอกสาร
        </p>
        <div style="display:flex;gap:8px;justify-content:center;margin-bottom:18px;" id="pin-boxes">
          ${Array(6).fill(0).map((_,i)=>`<input type="password" inputmode="numeric" maxlength="1" class="pin-box" id="pin-${i}" data-idx="${i}">`).join('')}
        </div>
        <div id="doc-preview-err" style="color:#dc2626;font-size:.83rem;min-height:20px;text-align:center;margin-bottom:10px;"></div>
        <button class="btn btn--primary" style="width:100%;" id="doc-preview-submit-btn" onclick="handleDocPreviewPasskey('${escapeHtml(docId)}')">
          ยืนยัน Passkey
        </button>
        <button class="btn" style="width:100%;margin-top:8px;" onclick="closeDocPreview();window.location.href=window.location.pathname">
          ยกเลิก / กลับหน้าล็อกอิน
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // Wire up PIN box auto-advance
  const boxes = overlay.querySelectorAll('.pin-box');
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      if (box.value && i < 5) boxes[i+1].focus();
      if (getPinValue().length === 6) handleDocPreviewPasskey(docId);
    });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i-1].focus();
    });
  });
  setTimeout(() => boxes[0] && boxes[0].focus(), 100);
}

function getPinValue() {
  const boxes = document.querySelectorAll('#doc-preview-overlay .pin-box');
  return Array.from(boxes).map(b => b.value).join('');
}

function closeDocPreview() {
  const el = document.getElementById('doc-preview-overlay');
  if (el) el.remove();
}

async function handleDocPreviewPasskey(docId) {
  const passkey = getPinValue();
  if (passkey.length !== 6) {
    const errEl = document.getElementById('doc-preview-err');
    if (errEl) errEl.textContent = 'กรุณากรอก Passkey ให้ครบ 6 หลัก';
    return;
  }

  const btn = document.getElementById('doc-preview-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'กำลังตรวจสอบ…'; }
  const errEl = document.getElementById('doc-preview-err');
  if (errEl) errEl.textContent = '';

  try {
    const res = await fetch('/api/auth/doc-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passkey, docId })
    });
    const data = await res.json();

    if (res.status === 401) {
      if (errEl) errEl.textContent = 'Passkey ไม่ถูกต้อง';
      if (btn) { btn.disabled = false; btn.textContent = 'ยืนยัน Passkey'; }
      // Clear PIN boxes
      document.querySelectorAll('#doc-preview-overlay .pin-box').forEach(b => b.value = '');
      const boxes = document.querySelectorAll('#doc-preview-overlay .pin-box');
      if (boxes[0]) boxes[0].focus();
      return;
    }

    if (res.status === 403) {
      closeDocPreview();
      // Show access-denied screen then redirect to login
      showDocAccessDenied();
      return;
    }

    if (res.status === 404) {
      if (errEl) errEl.textContent = 'ไม่พบเอกสาร: ' + docId;
      if (btn) { btn.disabled = false; btn.textContent = 'ยืนยัน Passkey'; }
      return;
    }

    if (!res.ok) {
      if (errEl) errEl.textContent = data.error || 'เกิดข้อผิดพลาด';
      if (btn) { btn.disabled = false; btn.textContent = 'ยืนยัน Passkey'; }
      return;
    }

    // ✅ Success — save 24h session, set JWT, show doc
    saveDocSession(data.token, data.username);
    _jwt = data.token;
    sessionStorage.setItem(_JWT_KEY, _jwt);
    seedCurrentUser(data.user);

    closeDocPreview();

    // Show document in preview modal then close → go to main app
    showDocPreviewModal(data.doc, () => {
      // After user closes preview, clean URL and enter dashboard
      window.history.replaceState(null, '', window.location.pathname);
      (async () => {
        try { await syncFromServer(); } catch(_) {}
        const user = getCurrentUser();
        if (user) { connectSocket(user.username); enterDashboard(user); }
        else showAuth();
      })();
    });

  } catch(e) {
    if (errEl) errEl.textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อ';
    if (btn) { btn.disabled = false; btn.textContent = 'ยืนยัน Passkey'; }
  }
}

function showDocAccessDenied() {
  const overlay = document.createElement('div');
  overlay.className = 'doc-preview-overlay';
  overlay.style.zIndex = '9998';
  overlay.innerHTML = `
    <div class="doc-preview-card" style="text-align:center;max-width:340px;">
      <div style="font-size:3rem;margin-bottom:12px;">🔒</div>
      <div style="font-weight:700;font-size:1.05rem;color:var(--text);margin-bottom:8px;">ไม่มีสิทธิ์ดูเอกสารนี้</div>
      <p style="color:var(--gray);font-size:.88rem;margin-bottom:20px;">คุณไม่มีสิทธิ์เข้าถึงเอกสารนี้<br>กรุณาติดต่อผู้ส่งเอกสาร</p>
      <button class="btn btn--primary" style="width:100%;" onclick="this.closest('.doc-preview-overlay').remove();window.location.href=window.location.pathname">
        กลับหน้าล็อกอิน
      </button>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(() => {
    overlay.remove();
    window.location.href = window.location.pathname;
  }, 4000);
}

function showDocPreviewModal(doc, onClose) {
  if (!doc) { if (onClose) onClose(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'doc-preview-modal';
  overlay.className = 'doc-preview-overlay';

  const statusLabels = { pending: 'รอดำเนินการ', approved: 'อนุมัติแล้ว', rejected: 'ปฏิเสธ', completed: 'เสร็จสิ้น' };
  const priorityColors = { urgent: '#dc2626', high: '#ea580c', normal: '#2563eb', low: '#6b7280' };
  const priorityLabels = { urgent: '🔴 เร่งด่วนมาก', high: '🟠 เร่งด่วน', normal: '🔵 ปกติ', low: '⚪ ไม่เร่งด่วน' };

  overlay.innerHTML = `
    <div class="doc-preview-card" style="max-width:520px;">
      <div class="doc-preview-header">
        <div>
          <div style="font-weight:700;font-size:1rem;">${escapeHtml(doc.title||'(ไม่มีหัวข้อ)')}</div>
          <div style="font-size:.75rem;color:var(--gray);">${escapeHtml(doc.id||'')}</div>
        </div>
        <button class="doc-preview-close" id="dpm-close-btn">✕</button>
      </div>
      <div class="doc-preview-body">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
          <div class="dp-info-row"><span class="dp-label">ผู้ส่ง</span><span>${escapeHtml(doc.senderFullName||doc.senderUsername||'')}</span></div>
          <div class="dp-info-row"><span class="dp-label">แผนก</span><span>${escapeHtml(doc.senderDepartment||'')}</span></div>
          <div class="dp-info-row"><span class="dp-label">ถึง</span><span>${escapeHtml(doc.recipientFullName||doc.recipientDepartment||doc.recipientUsername||'')}</span></div>
          <div class="dp-info-row"><span class="dp-label">วันที่</span><span>${doc.createdAt ? new Date(doc.createdAt).toLocaleDateString('th-TH') : ''}</span></div>
          <div class="dp-info-row"><span class="dp-label">ความเร่งด่วน</span><span style="color:${priorityColors[doc.priority]||''};">${priorityLabels[doc.priority]||doc.priority||''}</span></div>
          <div class="dp-info-row"><span class="dp-label">สถานะ</span><span>${statusLabels[doc.status]||doc.status||''}</span></div>
        </div>
        ${doc.content ? `<div style="background:var(--surface);border-radius:8px;padding:12px;font-size:.88rem;color:var(--text);white-space:pre-wrap;max-height:180px;overflow-y:auto;margin-bottom:14px;">${escapeHtml(doc.content)}</div>` : ''}
        ${doc.attachments && doc.attachments.length ? `
          <div style="font-size:.82rem;color:var(--gray);margin-bottom:8px;">ไฟล์แนบ: ${doc.attachments.length} ไฟล์</div>
        ` : ''}
        <button class="btn btn--primary" style="width:100%;margin-top:4px;" id="dpm-continue-btn">
          เข้าสู่ระบบต่อ →
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); if (onClose) onClose(); };
  document.getElementById('dpm-close-btn').onclick = close;
  document.getElementById('dpm-continue-btn').onclick = close;
}

// ===================================================================
// INIT — runs on page load
// ===================================================================
// Helper: restore a saved token and enter dashboard (used by initApp)
async function restoreSession(token, username, afterEnter) {
  _jwt = token;
  sessionStorage.setItem(_JWT_KEY, _jwt);
  // Ensure session object exists so getCurrentUser() works
  if (!store.getObj(K.session)) {
    store.setObj(K.session, { username, loginAt: Date.now() });
  }
  // Try to sync; even if it fails, seedCurrentUser from K.users is enough
  try { await syncFromServer(); } catch(_) {}
  const user = getCurrentUser();
  if (!user) {
    // Sync failed and no cached user — back to auth
    _jwt = null; sessionStorage.removeItem(_JWT_KEY);
    showAuth(); return;
  }
  connectSocket(username);
  enterDashboard(user);
  if (afterEnter) setTimeout(afterEnter, 600);
}

(function initApp() {
  const params = new URLSearchParams(window.location.search);
  const docIdParam = params.get('doc');

  if (docIdParam) {
    // ── Deep link mode: ?doc=DOC-XXXX ─────────────────────────────
    const docSess = getDocSession();
    if (docSess && docSess.token) {
      // Remembered 24h doc session — restore and open doc directly
      restoreSession(docSess.token, docSess.username, async () => {
        try {
          const res = await apiCall('GET', '/api/docs/' + encodeURIComponent(docIdParam));
          if (res) {
            showDocPreviewModal(res, () => {
              window.history.replaceState(null, '', window.location.pathname);
            });
          } else {
            // Token expired/invalid — re-prompt passkey
            clearDocSession();
            _jwt = null; sessionStorage.removeItem(_JWT_KEY);
            showDocPreviewScreen(docIdParam);
          }
        } catch(_) { showDocPreviewScreen(docIdParam); }
      });
    } else {
      // No remembered session → show passkey screen
      showDocPreviewScreen(docIdParam);
    }
  } else {
    // ── Normal mode: no ?doc= param ───────────────────────────────
    const jwtStored = sessionStorage.getItem(_JWT_KEY);
    if (jwtStored) {
      // Active session in this tab — restore immediately
      _jwt = jwtStored;
      (async () => {
        try { await syncFromServer(); } catch(_) {}
        const user = getCurrentUser();
        if (user) { connectSocket(user.username); enterDashboard(user); }
        else { _jwt = null; sessionStorage.removeItem(_JWT_KEY); showAuth(); }
      })();
    } else {
      // No tab session — check 24h remember-me
      const rem = getRememberAuth();
      if (rem && rem.token) {
        restoreSession(rem.token, rem.username, null);
      } else {
        showAuth();
      }
    }
  }
})();
// ==================================