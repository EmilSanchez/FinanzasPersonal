/* ============================================================
   FIREBASE SETUP — INSTRUCCIONES
   ============================================================
   1. Ve a console.firebase.google.com
   2. Crea un proyecto → Firestore Database → Modo producción
   3. Ve a Configuración → Tus apps → Agrega app web (</>)
   4. Copia el objeto firebaseConfig que te da Firebase
   5. Reemplaza los valores REEMPLAZA_* en el bloque <script type="module">
      que está al inicio de este archivo (justo después del <title>)
   6. En Firestore → Reglas → pega esto:
      rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /{document=**} {
            allow read, write: if true;
          }
        }
      }
   7. ¡Listo! Los datos se sincronizan automáticamente en la nube.
      LocalStorage sigue funcionando como respaldo offline.
   ============================================================ */

/* ============================================================
   STATE & STORAGE
   ============================================================ */
const STATE = {
  db: null,
  currentPage: 'dashboard',
  ingEditId: null,
  gasEditId: null,
};

/* ============================================================
   FIREBASE — Capa de datos
   loadDb()  → carga de Firestore (o localStorage como fallback)
   saveDb()  → guarda en Firestore Y localStorage (doble respaldo)
   ============================================================ */

// ── Fallback: cargar datos desde localStorage ──
function loadDbLocal() {
  const raw = localStorage.getItem('finanzas_pro_v2');
  STATE.db = raw ? JSON.parse(raw) : {
    ingresos: [], gastos: [], deudas: [], pass: [],
    prestamos: [], gastosFijos: [], inversiones: [], ventasInv: [], billeteras: [], transferencias: []
  };
  if (!STATE.db.prestamos)      STATE.db.prestamos      = [];
  if (!STATE.db.gastosFijos)    STATE.db.gastosFijos    = [];
  if (!STATE.db.inversiones)    STATE.db.inversiones    = [];
  if (!STATE.db.ventasInv)      STATE.db.ventasInv      = [];
  if (!STATE.db.billeteras)     STATE.db.billeteras     = [];
  if (!STATE.db.transferencias) STATE.db.transferencias = [];
}

// ── Cargar datos: local primero (instantáneo), Firebase en background ──
async function loadDb(silent = false) {
  if (!silent) showLoadingOverlay('Cargando datos...');
  loadDbLocal();
  // Spinner breve — solo para dar feedback visual
  await new Promise(r => setTimeout(r, 400));
  hideLoadingOverlay();
  // Sincronizar Firebase en background sin bloquear la UI
  _sincronizarFirebase(silent);
}

async function _sincronizarFirebase(silent = false) {
  // Esperar Firebase máximo 5s
  if (!window.__FB?.ready) {
    await new Promise(resolve => {
      const t = setTimeout(resolve, 5000);
      window.addEventListener('firebase-auth-ready', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  if (!window.__FB?.ready) {
    if (!silent) toast('Sin conexión — datos locales', 'info');
    return;
  }

  try {
    const data = await window.__FB.loadAll();
    const dbRemote = {
      ingresos:       data.ingresos       || [],
      gastos:         data.gastos         || [],
      deudas:         data.deudas         || [],
      pass:           data.pass           || [],
      prestamos:      data.prestamos      || [],
      gastosFijos:    data.gastosFijos    || [],
      inversiones:    data.inversiones    || [],
      ventasInv:      data.ventasInv      || [],
      billeteras:     data.billeteras     || [],
      transferencias: data.transferencias || [],
    };
    // Solo re-renderizar si hay diferencias
    if (JSON.stringify(STATE.db) !== JSON.stringify(dbRemote)) {
      STATE.db = dbRemote;
      localStorage.setItem('finanzas_pro_v2', JSON.stringify(dbRemote));
      renderAll();
      console.log(' Sincronizado con Firestore');
    }
    // PIN sync
    try {
      if (window.__FB.loadPin) {
        const hashRemoto = await window.__FB.loadPin();
        if (hashRemoto && hashRemoto.length === 64) localStorage.setItem('fp_pin_hash', hashRemoto);
        else if (!hashRemoto && localStorage.getItem('fp_pin_hash')) await window.__FB.savePin(localStorage.getItem('fp_pin_hash')).catch(()=>{});
      }
    } catch(e) {}
  } catch(err) {
    console.error('Error sincronizando Firebase:', err);
  }
}

// ── Guardar (Firebase + localStorage como doble respaldo) ──
// Rastrea qué colecciones han cambiado para sync selectivo
const _dirtyCollections = new Set();
function markDirty(col) { _dirtyCollections.add(col); }

/* ── Helper: registrar gasto aplicando 4x1000 si la billetera lo cobra ── */
function registrarGastoConGMF({ id, fecha, hora, monto, desc, cat, billeteraId, ...extra }) {
  const _ts = Date.now();
  STATE.db.gastos.push({ id: id || uid(), fecha, hora: hora || horaActual(), monto, desc, cat, billeteraId, ts: _ts, ...extra });
  const bill = getBilleteras().find(b => b.id === billeteraId);
  if (bill?.cobra4x1000 && monto > 0) {
    const gmf = Math.round(monto * 0.004);
    STATE.db.gastos.push({
      id: uid(), fecha, hora: hora || horaActual(), monto: gmf,
      desc: `4x1000 sobre ${fmt(monto)}`, cat: 'Impuestos',
      billeteraId, ts: _ts + 1, autoGenerado: true
    });
  }
}

/* ── Overlay de carga global ── */
function showLoading() {
  let ov = document.getElementById('loading-overlay');
  if (ov) { ov.style.display = 'flex'; return; }
  ov = document.createElement('div');
  ov.id = 'loading-overlay';
  ov.innerHTML = '<div class="loading-spinner"></div>';
  document.body.appendChild(ov);
}
function hideLoading() {
  const ov = document.getElementById('loading-overlay');
  if (ov) ov.style.display = 'none';
}

async function saveDb(coleccionesEspecificas = null) {
  // Siempre guardar en localStorage primero (respaldo inmediato)
  localStorage.setItem('finanzas_pro_v2', JSON.stringify(STATE.db));

  // Si Firebase ya está listo, guardar inmediatamente
  // Si no, esperar hasta 8 segundos a que se conecte
  if (!estaConectado()) {
    showSavingDot();
    const connected = await esperarFirebase(8000);
    if (!connected) {
      // Guardar en cola pendiente para sincronizar cuando vuelva la conexión
      _pendingSync = true;
      showSaveError({ message: 'Sin conexión — datos guardados localmente' });
      toast('⚠️ Guardado localmente. Se sincronizará al conectarse.', 'info');
      return false;
    }
  }

  showSavingDot();
  try {
    const toSave = coleccionesEspecificas ||
      ['ingresos','gastos','deudas','pass','prestamos','gastosFijos','inversiones','ventasInv','billeteras','transferencias'];
    await Promise.all(
      toSave.map(col => window.__FB.saveCollection(col, STATE.db[col] || []))
    );
    _pendingSync = false;
    showSaveSuccess();
    return true;
  } catch (err) {
    console.error('Error guardando en Firebase:', err);
    _pendingSync = true;
    showSaveError(err);
    return false;
  }
}

// Espera a que Firebase esté listo, con timeout en ms
let _pendingSync = false;
function esperarFirebase(timeoutMs = 8000) {
  if (estaConectado()) return Promise.resolve(true);
  return new Promise(resolve => {
    const t = setTimeout(() => { resolve(false); }, timeoutMs);
    window.addEventListener('firebase-auth-ready', () => {
      clearTimeout(t);
      resolve(true);
    }, { once: true });
  });
}

// Cuando Firebase se conecta, sincronizar datos pendientes automáticamente
window.addEventListener('firebase-auth-ready', async () => {
  if (_pendingSync && STATE.db) {
    console.log('Firebase conectado — sincronizando datos pendientes...');
    toast('☁️ Sincronizando datos con la nube...', 'info');
    try {
      const cols = ['ingresos','gastos','deudas','pass','prestamos','gastosFijos','inversiones','ventasInv','billeteras','transferencias'];
      await Promise.all(cols.map(col => window.__FB.saveCollection(col, STATE.db[col] || [])));
      _pendingSync = false;
      toast(' Datos sincronizados correctamente', 'success');
    } catch(e) {
      console.error('Error en sync pendiente:', e);
    }
  }
});

// ── Indicador visual de guardado ──
let _saveTimer = null;
function showSavingDot() {
  // Mostrar un pequeño punto de guardado en el topbar
  const dot = document.getElementById('fb-badge-dot');
  const txt = document.getElementById('fb-badge-txt');
  const badge = document.getElementById('fb-badge-topbar');
  if (!badge || !window.__FB?.ready) return;
  badge.style.display = 'flex';
  if (dot) dot.style.background = '#d97706';
  if (txt) txt.textContent = 'Guardando...';
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (dot) dot.style.background = '#059669';
    if (txt) txt.textContent = 'Guardado';
    setTimeout(() => { badge.style.display = 'none'; }, 2000);
  }, 800);
}

// ── Feedback visual de guardado exitoso ──
function showSaveSuccess() {
  const dot   = document.getElementById('fb-badge-dot');
  const txt   = document.getElementById('fb-badge-txt');
  const badge = document.getElementById('fb-badge-topbar');
  if (!badge) return;
  clearTimeout(_saveTimer);
  badge.style.display = 'flex';
  if (dot) dot.style.background = '#059669';
  if (txt) txt.textContent = '✓ Guardado';
  _saveTimer = setTimeout(() => { badge.style.display = 'none'; }, 2500);
}

// ── Alerta de error al guardar en Firebase ──
let _saveErrorTimer = null;
function showSaveError(err) {
  const dot   = document.getElementById('fb-badge-dot');
  const txt   = document.getElementById('fb-badge-txt');
  const badge = document.getElementById('fb-badge-topbar');
  if (badge) {
    clearTimeout(_saveTimer);
    badge.style.display = 'flex';
    if (dot) dot.style.background = '#ef4444';
    if (txt) txt.textContent = '✕ Error al guardar';
  }

  // Toast con mensaje claro
  const esRed = err && (err.message?.includes('network') || err.code === 'unavailable' || err.message?.includes('Failed to fetch'));
  const msg = esRed
    ? '⚠️ Sin conexión — el dato se guardó localmente y se sincronizará cuando vuelva internet.'
    : '❌ No se pudo guardar en la nube. Revisa tu conexión e intenta de nuevo.';
  toast(msg, 'error');

  // Resetear badge después de 4 segundos
  clearTimeout(_saveErrorTimer);
  _saveErrorTimer = setTimeout(() => {
    if (badge) badge.style.display = 'none';
  }, 4000);
}

// ── Verificar conexión antes de cualquier escritura ──
function estaConectado() {
  return window.__FB && window.__FB.ready && window.__fbAuthReady === true;
}

function mostrarAvisoSinConexion() {
  // Quitar aviso anterior si existe
  const existing = document.getElementById('offline-block-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'offline-block-modal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:99999;
    background:rgba(0,0,0,0.6);
    display:flex;align-items:center;justify-content:center;
    padding:20px;
  `;
  modal.innerHTML = `
    <div style="
      background:#1e293b;border-radius:16px;padding:32px 28px;
      max-width:380px;width:100%;text-align:center;
      box-shadow:0 20px 60px rgba(0,0,0,0.5);
      border:1px solid #334155;
    ">
      <div style="font-size:2.8rem;margin-bottom:12px;">📡</div>
      <h2 style="color:#f8fafc;font-size:1.2rem;margin-bottom:10px;">Sin conexión</h2>
      <p style="color:#94a3b8;font-size:.9rem;line-height:1.6;margin-bottom:24px;">
        No hay conexión con la nube en este momento.<br>
        <strong style="color:#f8fafc;">No puedes hacer cambios</strong> hasta que se restablezca la conexión para evitar pérdida de datos.
      </p>
      <div style="display:flex;gap:10px;justify-content:center;">
        <button onclick="intentarReconectar()" style="
          background:#3b82f6;color:white;border:none;
          padding:10px 20px;border-radius:8px;
          font-size:.9rem;font-weight:600;cursor:pointer;
        ">🔄 Reintentar</button>
        <button onclick="document.getElementById('offline-block-modal').remove()" style="
          background:#334155;color:#94a3b8;border:none;
          padding:10px 20px;border-radius:8px;
          font-size:.9rem;cursor:pointer;
        ">Cerrar</button>
      </div>
    </div>
  "`;
  document.body.appendChild(modal);
}

async function intentarReconectar() {
  const modal = document.getElementById('offline-block-modal');
  if (modal) {
    modal.querySelector('h2').textContent = 'Reconectando...';
    modal.querySelector('p').textContent = 'Verificando conexión con Firebase...';
    modal.querySelector('button').disabled = true;
  }
  // Esperar un momento y verificar
  await new Promise(r => setTimeout(r, 1500));
  if (estaConectado()) {
    if (modal) modal.remove();
    toast(' Conexión restablecida', 'success');
    updateFbStatus(true);
  } else {
    if (modal) {
      modal.querySelector('h2').textContent = 'Sin conexión';
      modal.querySelector('p').innerHTML = 'Sigue sin conexión con la nube.<br><strong style="color:#f8fafc;">No puedes hacer cambios</strong> hasta que se restablezca.';
      modal.querySelector('button').disabled = false;
    }
  }
}

// ── Guardar un solo item de una colección (más rápido que batch) ──
async function saveItem(colName, item) {
  if (!estaConectado()) { await esperarFirebase(5000); }
  if (!estaConectado()) { mostrarAvisoSinConexion(); return false; }

  // Actualizar STATE primero (UI inmediata)
  const arr = STATE.db[colName] || [];
  const idx = arr.findIndex(i => i.id === item.id);
  if (idx !== -1) arr[idx] = item; else arr.push(item);
  STATE.db[colName] = arr;

  // Guardar localStorage
  localStorage.setItem('finanzas_pro_v2', JSON.stringify(STATE.db));
  showSavingDot();

  // Guardar en Firebase
  try {
    await window.__FB.save(colName, item);
    showSaveSuccess();
    return true;
  } catch(err) {
    // Revertir el cambio en STATE si Firebase falló
    if (arr.findIndex(i => i.id === item.id) !== -1) {
      STATE.db[colName] = arr.filter(i => i.id !== item.id);
      localStorage.setItem('finanzas_pro_v2', JSON.stringify(STATE.db));
    }
    console.error('Firebase saveItem error:', err);
    showSaveError(err);
    return false;
  }
}

// ── Eliminar un item de una colección ──
async function deleteItem(colName, id) {
  if (!estaConectado()) { mostrarAvisoSinConexion(); return false; }

  const backup = [...(STATE.db[colName] || [])];
  STATE.db[colName] = backup.filter(i => i.id !== id);
  localStorage.setItem('finanzas_pro_v2', JSON.stringify(STATE.db));
  showSavingDot();

  try {
    await window.__FB.remove(colName, id);
    showSaveSuccess();
    return true;
  } catch(err) {
    // Revertir si Firebase falló
    STATE.db[colName] = backup;
    localStorage.setItem('finanzas_pro_v2', JSON.stringify(STATE.db));
    console.error('Firebase deleteItem error:', err);
    showSaveError(err);
    return false;
  }
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Convierte "03:45 PM" → "15:45" para input[type=time]
function horaToInputTime(horaStr) {
  if (!horaStr) return '';
  try {
    const match = horaStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (!match) return '';
    let h = parseInt(match[1]);
    const m = String(parseInt(match[2])).padStart(2,'0');
    const ampm = (match[3]||'').toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return String(h).padStart(2,'0') + ':' + m;
  } catch { return ''; }
}

// Convierte "15:45" → "03:45 PM" para almacenar
function inputTimeToHora(val) {
  if (!val) return horaActual();
  try {
    const [hStr, mStr] = val.split(':');
    let h = parseInt(hStr);
    const m = mStr;
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return String(h).padStart(2,'0') + ':' + m + ' ' + ampm;
  } catch { return horaActual(); }
}

// Convierte "03:45 PM" a minutos totales para comparación
function convertirHora(horaStr) {
  if (!horaStr) return 0;
  try {
    // Normalizar formato colombiano: "05:34 a. m." -> "05:34 AM"
    const normalizado = horaStr.replace(/a\.\s*m\./i, 'AM').replace(/p\.\s*m\./i, 'PM');
    const match = normalizado.match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (!match) return 0;
    let h = parseInt(match[1]);
    const m = parseInt(match[2]);
    const ampm = (match[3]||'').toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  } catch { return 0; }
}

// Captura la hora actual del dispositivo
function horaActual() {
  return new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', hour12: true
  });
}

function formatFechaLarga(fechaStr) {
  if (!fechaStr) return '—';
  try {
    const [y, m, d] = fechaStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .replace(/^\w/, c => c.toUpperCase());
  } catch { return fechaStr; }
}

/* ── Firebase UI helpers ── */
function showLoadingOverlay(msg = 'Cargando...') {
  const el = document.getElementById('fb-loading');
  const msgEl = document.getElementById('fb-loading-msg');
  if (el) { el.style.display = 'flex'; }
  if (msgEl) msgEl.textContent = msg;
}

function hideLoadingOverlay() {
  const el = document.getElementById('fb-loading');
  if (el) el.style.display = 'none';
}

function updateFbStatus(connected) {
  // Bottom badge (mobile)
  const badge = document.getElementById('fb-status');
  const dot   = document.getElementById('fb-status-dot');
  const txt   = document.getElementById('fb-status-txt');
  // Topbar badge (desktop)
  const tBadge = document.getElementById('fb-badge-topbar');
  const tDot   = document.getElementById('fb-badge-dot');
  const tTxt   = document.getElementById('fb-badge-txt');

  const color  = connected ? '#059669' : '#d97706';
  const label  = connected ? '☁️ Firebase' : ' Offline';

  if (badge) {
    badge.style.display = 'flex';
    if (dot) dot.style.background = color;
    if (txt) txt.textContent = connected ? 'Firebase conectado' : 'Modo offline';
    if (connected) setTimeout(() => { badge.style.display = 'none'; }, 4000);
  }
  if (tBadge) {
    tBadge.style.display = 'flex';
    if (tDot) tDot.style.background = color;
    if (tTxt) tTxt.textContent = label;
    if (connected) setTimeout(() => { tBadge.style.display = 'none'; }, 4000);
  }
}

/* ============================================================
   SESIÓN & SEGURIDAD
   ============================================================ */

/* ── Perfil de usuario — clave única por usuario ── */
function _perfilKey(suffix) {
  const u = window.__CURRENT_USER;
  const uid = (!u || u.isAdmin) ? 'admin' : u.id;
  return `fp_perfil_${uid}_${suffix}`;
}

async function cargarPerfil() {
  let nombre = localStorage.getItem(_perfilKey('nombre')) || '';
  let foto   = localStorage.getItem(_perfilKey('foto'))   || '';

  // Sincronizar desde Firebase
  if (window.__FB?.ready && window.__FB.loadPerfil) {
    try {
      const remote = await window.__FB.loadPerfil();
      if (remote.nombre) { nombre = remote.nombre; localStorage.setItem(_perfilKey('nombre'), nombre); }
      if (remote.foto)   { foto   = remote.foto;   localStorage.setItem(_perfilKey('foto'),   foto);   }
    } catch(e) { console.warn('Perfil sync error:', e); }
  }

  const u = window.__CURRENT_USER;
  const nombreMostrar = nombre || (u && !u.isAdmin ? u.nombre : '') || 'Mi perfil';

  const nameEl = document.getElementById('sidebar-user-name');
  if (nameEl) nameEl.textContent = nombreMostrar;

  // Actualizar rol en sidebar
  const roleEl = document.getElementById('sidebar-user-role');
  if (roleEl) {
    const u = window.__CURRENT_USER;
    roleEl.textContent = (!u || u.isAdmin) ? 'Administrador' : 'Usuario';
  }

  const inp = document.getElementById('config-nombre-input');
  if (inp) inp.value = nombre;

  _actualizarAvatarUI(foto);
}

function _actualizarAvatarUI(fotoB64) {
  const ids = [
    { img: 'sidebar-avatar-img', icon: 'sidebar-avatar-icon' },
    { img: 'config-avatar-img',  icon: 'config-avatar-icon'  },
  ];
  ids.forEach(({ img, icon }) => {
    const imgEl  = document.getElementById(img);
    const iconEl = document.getElementById(icon);
    if (imgEl && iconEl) {
      if (fotoB64) {
        imgEl.src = fotoB64;
        imgEl.style.display = 'block';
        iconEl.style.display = 'none';
      } else {
        imgEl.style.display = 'none';
        iconEl.style.display = '';
      }
    }
  });
}

async function guardarNombrePerfil() {
  const val = (document.getElementById('config-nombre-input')?.value || '').trim();
  if (!val) return toast('Escribe un nombre', 'error');

  // Animación en el botón
  const btn = document.querySelector('[onclick="guardarNombrePerfil()"]');
  if (btn) { btn.textContent = '...'; btn.disabled = true; }

  localStorage.setItem(_perfilKey('nombre'), val);
  if (window.__FB?.ready && window.__FB.savePerfil) {
    try { await window.__FB.savePerfil(val, undefined); } catch(e) {}
  }
  await cargarPerfil();

  if (btn) { btn.textContent = '✓ Guardado'; setTimeout(() => { btn.textContent = 'Guardar'; btn.disabled = false; }, 1500); }
  toast('Nombre actualizado ', 'success');
}

async function subirFotoPerfil(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('La imagen debe pesar menos de 2MB', 'error');

  // Mostrar spinner en el avatar mientras sube
  const avatarEl = document.getElementById('config-avatar');
  const origContent = avatarEl?.innerHTML;
  if (avatarEl) {
    avatarEl.innerHTML = '<div class="loading-spinner" style="width:36px;height:36px;border-width:3px;border-color:rgba(37,99,235,.2);border-top-color:var(--accent);"></div>';
  }

  const reader = new FileReader();
  reader.onload = async e => {
    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      const MAX = 200;
      let w = img.width, h = img.height;
      if (w > h) { if (w > MAX) { h = h * MAX / w; w = MAX; } }
      else        { if (h > MAX) { w = w * MAX / h; h = MAX; } }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const b64 = canvas.toDataURL('image/jpeg', 0.8);
      localStorage.setItem(_perfilKey('foto'), b64);

      // Guardar en Firebase
      if (window.__FB?.ready && window.__FB.savePerfil) {
        try { await window.__FB.savePerfil(undefined, b64); } catch(e) {}
      }

      _actualizarAvatarUI(b64);
      // Restaurar el botón de cámara en el avatar
      if (avatarEl) {
        avatarEl.innerHTML = `
          <svg id="config-avatar-icon" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <img id="config-avatar-img" src="${b64}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        document.getElementById('config-avatar-icon').style.display = 'none';
        document.getElementById('config-avatar-img').style.display = 'block';
        // Animación de entrada
        avatarEl.style.animation = 'none';
        void avatarEl.offsetWidth;
        avatarEl.style.animation = 'pageEnter .4s cubic-bezier(.22,.68,0,1.2)';
      }
      toast('Foto actualizada ', 'success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = '';
}

/* ── Sistema universal de confirmación con PIN del usuario ── */
let _confirmPinCallback = null;

function pedirPinParaAccion(titulo, callback) {
  _confirmPinCallback = callback;
  const t = document.getElementById('confirm-pin-titulo');
  const inp = document.getElementById('confirm-pin-input');
  const err = document.getElementById('confirm-pin-error');
  if (t) t.textContent = titulo;
  if (inp) inp.value = '';
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  openModal('modal-confirm-pin');
  setTimeout(() => { if (inp) inp.focus(); }, 150);
}

async function confirmarAccionConPin() {
  const inp = document.getElementById('confirm-pin-input');
  const err = document.getElementById('confirm-pin-error');
  const entered = inp?.value?.trim() || '';
  if (!entered) return;

  const enteredHash = await sha256(entered);
  const u = window.__CURRENT_USER;

  let correctHash;
  if (!u || u.isAdmin) {
    correctHash = localStorage.getItem('fp_pin_hash');
  } else {
    // Usuario: leer de Firebase
    try { correctHash = await window.__FB.loadPin(); } catch(e) { correctHash = null; }
  }

  if (enteredHash === correctHash) {
    closeModal('modal-confirm-pin');
    if (_confirmPinCallback) { _confirmPinCallback(); _confirmPinCallback = null; }
  } else {
    if (err) { err.textContent = 'PIN incorrecto.'; err.style.display = 'block'; }
    if (inp) { inp.value = ''; inp.classList.add('mov-del-shake'); setTimeout(() => inp.classList.remove('mov-del-shake'), 500); }
  }
}

/* ── Formateador de monto en tiempo real (ej: 1,000,000) ── */
function fmtMontoInput(input) {
  const prevLen = input.value.length;
  const pos = input.selectionStart;

  // Solo dígitos
  const raw = input.value.replace(/[^0-9]/g, '');
  if (!raw) { input.value = ''; return; }

  // Separador de miles manual con punto (estilo colombiano)
  const formatted = raw.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  input.value = formatted;

  // Ajustar cursor
  const diff = formatted.length - prevLen;
  const newPos = Math.max(0, pos + diff);
  input.setSelectionRange(newPos, newPos);
}

/* ── Leer valor numérico real de un input formateado ── */
function getMontoValue(id) {
  const el = document.getElementById(id);
  if (!el) return 0;
  return parseInt(el.value.replace(/[^0-9]/g, ''), 10) || 0;
}

/* ── SHA-256 helper (Web Crypto API) ── */
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

const SESSION_KEY = 'fp_session';
const SESSION_MS  = 30 * 60 * 1000;
let _sessionTimer = null;

function sessionClear() {
  localStorage.removeItem(SESSION_KEY);
  clearTimeout(_sessionTimer);
}

function _scheduleSessionExpiry() {
  clearTimeout(_sessionTimer);
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return;
  const { ts } = JSON.parse(raw);
  const remaining = SESSION_MS - (Date.now() - ts);
  _sessionTimer = setTimeout(() => {
    sessionClear();
    window.location.replace('login.html');
  }, Math.max(remaining, 0));
}

function sessionUpdateTimer() {
  const el = document.getElementById('config-session-timer');
  if (!el) return;
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) { el.textContent = '—'; return; }
  const { ts } = JSON.parse(raw);
  const rem = SESSION_MS - (Date.now() - ts);
  if (rem <= 0) { el.textContent = 'expirada'; return; }
  const m = Math.floor(rem / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  el.textContent = `${m}:${String(s).padStart(2,'0')}`;
}



async function recargarApp() {
  const page  = STATE.currentPage || 'dashboard';
  const param = STATE.navParam    || null;
  const btn   = document.querySelector('[onclick="recargarApp()"]');

  // Mostrar 3 puntitos saltando
  let dotsEl = null;
  if (btn) {
    const svg = btn.querySelector('svg');
    if (svg) svg.style.display = 'none';
    dotsEl = document.createElement('span');
    dotsEl.id = 'reload-dots';
    dotsEl.innerHTML = `<span class="rdot"></span><span class="rdot"></span><span class="rdot"></span>`;
    dotsEl.style.cssText = 'display:flex;align-items:center;gap:3px;';
    btn.appendChild(dotsEl);
  }

  try {
    await loadDb(true);
    renderAll();
    // Forzar animación de entrada al actualizar
    const pageEl2 = document.getElementById('page-' + page);
    if (pageEl2) { pageEl2.classList.remove('page-enter'); void pageEl2.offsetWidth; pageEl2.classList.add('page-enter'); pageEl2.addEventListener('animationend', () => pageEl2.classList.remove('page-enter'), { once: true }); }
    navigate(page, param);
    toast('Datos actualizados ', 'success');
  } catch(e) {
    toast('Error al actualizar', 'error');
  } finally {
    if (btn) {
      const svg = btn.querySelector('svg');
      if (svg) svg.style.display = '';
      if (dotsEl) dotsEl.remove();
    }
  }
}

function lockApp() {
  sessionClear();
  window.location.replace('login.html');
}

async function changePin() {
  const oldVal = document.getElementById('m-pin-old').value;
  const nw     = document.getElementById('m-pin-new').value;
  const cf     = document.getElementById('m-pin-conf').value;
  const u      = window.__CURRENT_USER;
  const esAdmin = !u || u.isAdmin;

  if (nw.length !== 4)   return toast('El nuevo PIN debe tener 4 dígitos', 'error');
  if (!/^\d+$/.test(nw)) return toast('El PIN sólo puede contener números', 'error');
  if (nw !== cf)          return toast('Los PINs no coinciden', 'error');

  const oldHash = await sha256(oldVal);
  let savedHash;

  if (esAdmin) {
    // Admin: verificar contra localStorage (con migración legacy)
    const leg = localStorage.getItem('fp_pin');
    if (leg) { localStorage.setItem('fp_pin_hash', await sha256(leg)); localStorage.removeItem('fp_pin'); }
    if (!localStorage.getItem('fp_pin_hash')) localStorage.setItem('fp_pin_hash', await sha256('1234'));
    savedHash = localStorage.getItem('fp_pin_hash');
  } else {
    // Usuario: verificar contra Firebase
    try { savedHash = await window.__FB.loadPin(); } catch(e) { savedHash = null; }
  }

  if (oldHash !== savedHash) return toast('PIN actual incorrecto', 'error');

  const newHash = await sha256(nw);

  if (esAdmin) {
    localStorage.setItem('fp_pin_hash', newHash);
    localStorage.removeItem('fp_pin');
  }

  if (window.__FB?.ready && window.__FB.savePin) {
    try {
      await window.__FB.savePin(newHash);
      toast('PIN actualizado ', 'success');
    } catch(e) {
      if (esAdmin) toast('PIN actualizado localmente', 'info');
      else toast('Error actualizando PIN', 'error');
    }
  } else {
    toast('PIN actualizado', 'success');
  }

  closeModal('modal-pin');
  ['m-pin-old','m-pin-new','m-pin-conf'].forEach(id => document.getElementById(id).value = '');
}

/* ============================================================
   INICIO — la sesión ya fue validada por index.html guard
   ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  _scheduleSessionExpiry();
  setInterval(sessionUpdateTimer, 1000);
  cargarPerfil();
  initApp().then(async () => {
    updateFbStatus(window.__FB && window.__FB.ready);
    cargarPerfil(); // recargar perfil desde Firebase una vez conectado
    // Si es usuario no-admin, cargar sus módulos y verificar que sigue activo
    const cu = window.__CURRENT_USER;
    if (cu && !cu.isAdmin && window.__FB?.ready) {
      try {
        const usuarios = await window.__FB.getUsuarios();
        const uData = usuarios.find(u => u.id === cu.id);
        if (uData) {
          if (uData.activo === false) {
            toast('Tu cuenta ha sido desactivada. Contacta al administrador.', 'error');
            setTimeout(() => lockApp(), 2500);
            return;
          }
          // Guardar módulos en sesión
          cu.modulos = uData.modulos || null; // null = todos
          const sess = JSON.parse(localStorage.getItem(SESSION_KEY));
          if (sess) { sess.user = cu; localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); }
          window.__CURRENT_USER = cu;
          // Ocultar nav items sin acceso
          filtrarNavPorModulos(cu.modulos);
        }
      } catch(e) { console.warn('No se pudo verificar módulos:', e); }
    }
  });
  window.addEventListener('firebase-auth-ready', () => { updateFbStatus(true); }, { once: true });
});

function filtrarNavPorModulos(modulos) {
  if (!modulos) return; // null = acceso a todo
  document.querySelectorAll('.nav-btn[data-page], .bnav-btn[data-page], .drawer-item[data-page]').forEach(btn => {
    const page = btn.dataset.page;
    if (!page || page === 'dashboard' || page === 'config' || page === '__more') return;
    const modulo = page.split('-')[0];
    if (!modulos.includes(modulo)) btn.style.display = 'none';
  });
}

/* ============================================================
   APP INIT
   ============================================================ */
async function initApp() {
  await loadDb();          // espera Firestore (o localStorage)

  // Limpiar transferencias corruptas (sin monto válido o sin billeteras)
  if (STATE.db.transferencias && STATE.db.transferencias.length) {
    const antes = STATE.db.transferencias.length;
    STATE.db.transferencias = STATE.db.transferencias.filter(t =>
      t && Number(t.monto) > 0 && (t.origenId || t.origenNombre) && (t.destinoId || t.destinoNombre)
    );
    if (STATE.db.transferencias.length < antes) {
      await saveDb(['transferencias']);
    }
  }

  setDateLabels();
  populateMonthFilters();
  populateCatFilters();
  populateGFMesSel();
  autoResetGFIfNeeded();
  renderAll();

  // Restaurar última página visitada
  try {
    const sess = JSON.parse(localStorage.getItem('fp_session') || '{}');
    if (sess.lastPage && sess.lastPage !== 'dashboard') {
      navigate(sess.lastPage, sess.lastParam || null);
    }
  } catch(e) {}
}

function setDateLabels() {
  const now  = new Date();
  const opts = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  const str  = now.toLocaleDateString('es-CO', opts);
  document.getElementById('topbar-date').textContent = str;
  document.getElementById('sidebar-date').textContent = str;

  const monthName = now.toLocaleDateString('es-CO', { month:'long', year:'numeric' });
  document.getElementById('dash-month-label').textContent =
    'Resumen de ' + monthName.charAt(0).toUpperCase() + monthName.slice(1);

  // set default dates on forms
  const ymd = now.toISOString().slice(0, 10);
  ['i-fecha','g-fecha','d-fecha','d-prox','m-abonar-fecha'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = ymd;
  });
}

/* ============================================================
   NAVIGATION
   ============================================================ */
const PAGE_TITLES = {
  dashboard: 'Dashboard', ingresos: 'Ingresos',
  gastos: 'Gastos', deudas: 'Deudas', claves: 'Contraseñas', config: 'Configuración',
  prestamos: 'Préstamos a Terceros', fijos: 'Gastos Fijos',
  inversiones: 'Inversiones', 'detalle-inv': 'Detalle de Inversión', billeteras: 'Billeteras',
};

function navigate(page, param=null) {
  STATE.currentPage = page;
  STATE.navParam = param;
  // Persistir página actual en sessionStorage
  try {
    const sess = JSON.parse(localStorage.getItem('fp_session') || '{}');
    sess.lastPage = page;
    sess.lastParam = param || null;
    localStorage.setItem('fp_session', JSON.stringify(sess));
  } catch(e) {}
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.classList.remove('page-enter'); });
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) {
    pageEl.classList.add('active');
    // Forzar reflow para que la animación se dispare siempre
    void pageEl.offsetWidth;
    pageEl.classList.add('page-enter');
    pageEl.addEventListener('animationend', () => pageEl.classList.remove('page-enter'), { once: true });
  }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const basePage = page.split('-')[0];
  const navBtn = document.querySelector(`.nav-btn[data-page="${page}"]`) ||
                 document.querySelector(`.nav-btn[data-page="${basePage}"]`) ||
                 document.querySelector(`.nav-btn[data-page="inversiones"]`);
  if(navBtn) navBtn.classList.add('active');
  document.getElementById('topbar-title').textContent = PAGE_TITLES[page] || page;
  closeSidebar();
  if(typeof updateBottomNav === 'function') updateBottomNav(page);
  if(page === 'detalle-inv') {
    renderDetalleInv(param);
  } else {
    renderAll();
  }
  if(page === 'config') renderConfigUsuarios();
  // Verificar acceso a módulo para usuarios no-admin
  const cu = window.__CURRENT_USER;
  if (cu && !cu.isAdmin && cu.modulos && !['dashboard','config'].includes(page)) {
    if (!cu.modulos.includes(page.split('-')[0])) {
      toast('No tienes acceso a este módulo', 'error');
      navigate('dashboard');
    }
  }
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('visible');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

/* ── Mobile bottom nav ── */
function mobileNav(page) {
  navigate(page);
  // Update bottom nav active state
  updateBottomNav(page);
}

function updateBottomNav(page) {
  const btns = document.querySelectorAll('.bnav-btn[data-page]');
  btns.forEach(b => b.classList.remove('active'));
  // Mark the matching btn
  const target = document.querySelector(`.bnav-btn[data-page="${page}"]`);
  if (target) {
    target.classList.add('active');
  } else {
    // It's in the "more" drawer — highlight the "more" button
    const moreBtn = document.querySelector('.bnav-btn[data-page="__more"]');
    if (moreBtn) moreBtn.classList.add('active');
  }
  // Also update drawer items
  document.querySelectorAll('.drawer-item[data-page]').forEach(b => b.classList.remove('active'));
  const drawerTarget = document.querySelector(`.drawer-item[data-page="${page}"]`);
  if (drawerTarget) drawerTarget.classList.add('active');
}

function openDrawer() {
  document.getElementById('bnav-drawer').classList.add('open');
  document.getElementById('drawer-overlay').classList.add('open');
}

function closeDrawer() {
  document.getElementById('bnav-drawer').classList.remove('open');
  document.getElementById('drawer-overlay').classList.remove('open');
}

// Swipe down to close drawer
(function() {
  let startY = 0;
  const drawer = document.getElementById ? document.getElementById('bnav-drawer') : null;
  if (!drawer) return;
  drawer.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  drawer.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 60) closeDrawer();
  }, { passive: true });
})();

/* ============================================================
   MODALS
   ============================================================ */
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function showChangePinModal() { openModal('modal-pin'); }

function confirmDeleteAll() {
  document.getElementById('m-delete-confirm').value = '';
  openModal('modal-delete-all');
}

function deleteAll() {
  if (document.getElementById('m-delete-confirm').value !== 'BORRAR') {
    return toast('Escribe BORRAR para confirmar', 'error');
  }
  STATE.db = { ingresos:[], gastos:[], deudas:[], pass:[], prestamos:[], gastosFijos:[], inversiones:[], ventasInv:[], billeteras:[], transferencias:[] };
  saveDb().then(() => {
    closeModal('modal-delete-all');
    renderAll();
    toast('Todos los datos fueron eliminados', 'info');
  });
}

/* ============================================================
   TOAST
   ============================================================ */
function toast(msg, type = 'info') {
  const c   = document.getElementById('toast-container');
  const el  = document.createElement('div');
  const ico = { success:'&#10003;', error:'&#10007;', info:'i' }[type] || 'i';
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${ico}</span><span>${msg}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

/* ============================================================
   HELPERS
   ============================================================ */
function fmt(n) {
  if (n == null || isNaN(n)) return '$0';
  return '$' + Number(n).toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function currentYM() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function ym(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : '';
}

function monthLabel(ymStr) {
  if (!ymStr) return '';
  const [y, m] = ymStr.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

function getMonths(arr) {
  const set = new Set(arr.map(i => ym(i.fecha)).filter(Boolean));
  return [...set].sort().reverse();
}

function populateMonthFilters() {
  const allMonths = [...new Set([
    ...STATE.db.ingresos.map(i => ym(i.fecha)),
    ...STATE.db.gastos.map(g => ym(g.fecha)),
  ].filter(Boolean))].sort().reverse();

  ['i-filter-month', 'g-filter-month'].forEach(id => {
    const sel = document.getElementById(id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">Todos los meses</option>';
    allMonths.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = monthLabel(m);
      if (m === cur) opt.selected = true;
      sel.appendChild(opt);
    });
  });
  // Repoblar días si hay mes seleccionado
  populateDayFilter('i-filter-month', 'i-filter-day', STATE.db.ingresos);
  populateDayFilter('g-filter-month', 'g-filter-day', STATE.db.gastos);
}

// Poblador de días: muestra los días que tienen registros
// Si hay un mes seleccionado, filtra por ese mes; si no, muestra todos los días
function populateDayFilter(monthSelId, daySelId, items) {
  const monthSel = document.getElementById(monthSelId);
  const daySel   = document.getElementById(daySelId);
  if (!monthSel || !daySel) return;

  const selMonth = monthSel.value;
  const curDay   = daySel.value;

  // Obtener días únicos que tienen registros
  let filtered = items;
  if (selMonth) filtered = items.filter(i => ym(i.fecha) === selMonth);

  const days = [...new Set(filtered.map(i => i.fecha).filter(Boolean))].sort().reverse();

  daySel.innerHTML = '<option value="">Todos los días</option>';
  days.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    // Formato legible: "Lunes 20 mar"
    const fecha = new Date(d + 'T12:00:00');
    opt.textContent = fecha.toLocaleDateString('es-CO', {
      weekday: 'short', day: 'numeric', month: 'short'
    });
    if (d === curDay) opt.selected = true;
    daySel.appendChild(opt);
  });
}

function populateCatFilters() {
  const cats = [...new Set(STATE.db.gastos.map(g => g.cat).filter(Boolean))];
  const sel  = document.getElementById('g-filter-cat');
  const cur  = sel.value;
  sel.innerHTML = '<option value="">Todas las categorías</option>';
  cats.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    if (c === cur) opt.selected = true;
    sel.appendChild(opt);
  });
}

/* ============================================================
   RENDER ALL
   ============================================================ */
function renderAll() {
  populateMonthFilters();
  populateCatFilters();
  populateBilleteraSelects();
  populateGFBilletera();
  renderDashboard();
  renderIngresos();
  renderGastos();
  renderDeudas();
  renderPrestamos();
  renderGastosFijos();
  renderInversiones();
  renderBilleteras();
  renderBilleterasDashWidget();
  renderReportes();
  renderPass();
  // Inicializar rango de movimientos al mes actual si no hay valor
  const movDesde = document.getElementById('mov-filter-desde');
  const movHasta = document.getElementById('mov-filter-hasta');
  if (movDesde && movHasta && !movDesde.value && !movHasta.value) {
    const hoy = new Date();
    const y = hoy.getFullYear();
    const mPad = String(hoy.getMonth()+1).padStart(2,'0');
    movDesde.value = `${y}-${mPad}-01`;
    const ultDia = new Date(y, hoy.getMonth()+1, 0);
    movHasta.value = `${y}-${mPad}-${String(ultDia.getDate()).padStart(2,'0')}`;
  }
  renderMovimientos();
}

// Populate GF billetera select
function populateGFBilletera() {
  const sel = document.getElementById('gf-billetera');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Sin asignar</option>';
  (STATE.db.billeteras||[]).forEach(b => {
    const saldo = saldoBilletera(b.id);
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldo);
    if (b.id === cur) o.selected = true;
    sel.appendChild(o);
  });
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function renderDashboard() {
  const ym0 = currentYM();

  const ingMes  = STATE.db.ingresos.filter(i => ym(i.fecha) === ym0 && !i.esRecuperacionInversion && i.cat !== 'Transferencia');
  const gasMes  = STATE.db.gastos.filter(g => ym(g.fecha) === ym0 && g.cat !== 'Transferencia');
  const totalIng = ingMes.reduce((a, b) => a + Number(b.monto), 0);
  const totalGas = gasMes.reduce((a, b) => a + Number(b.monto), 0);
  const totalDeu = STATE.db.deudas.reduce((a, d) => a + Math.max(0, Number(d.total) - Number(d.pagado || 0)), 0);
  // Préstamos por cobrar suman al balance (dinero tuyo en la calle)
  const totalPrestPendiente = STATE.db.prestamos.reduce((a, p) =>
    a + Math.max(0, Number(p.totalConInteres) - Number(p.cobrado || 0)), 0);

  // Capital invertido activo = lo que tienes puesto en productos activos
  // Usamos calcInversion de inversiones para obtener lo invertido
  const totalInvCapital = (STATE.db.inversiones || [])
    .filter(inv => inv.estado === 'activa' || inv.estado === 'pausada')
    .reduce((a, inv) => {
      const cap = Number(inv.capitalCOP || 0) +
                  (Number(inv.capitalUSD || inv.precioUSD * (inv.unidades || 1) || 0) * Number(inv.tasa || 0)) +
                  Number(inv.envio || 0) + Number(inv.otrosCostos || 0);
      return a + cap;
    }, 0);

  // Balance mensual = ingresos - gastos del mes
  const balanceMes = totalIng - totalGas;

  // ══ HERO: Total real en todas las billeteras ══
  const totalBilleteras = (STATE.db.billeteras || []).reduce((a, b) => a + saldoBilletera(b.id), 0);

  document.getElementById('d-ing').textContent = fmt(totalIng);
  document.getElementById('d-gas').textContent = fmt(totalGas);
  document.getElementById('d-deu').textContent = fmt(totalDeu);

  // El balance del hero = total billeteras (dinero real disponible)
  const bEl = document.getElementById('d-balance');
  if (bEl) {
    bEl.textContent = fmt(totalBilleteras);
    bEl.className = 'dash-balance-amount';
  }

  // Color de las tarjetas de detalle
  const ingEl = document.getElementById('d-ing');
  if(ingEl) ingEl.className = 'stat-value positive';
  const gasEl = document.getElementById('d-gas');
  if(gasEl) gasEl.className = 'stat-value negative';
  const deuEl = document.getElementById('d-deu');
  if(deuEl) deuEl.className = 'stat-value warning';

  document.getElementById('d-ing-sub').textContent  = ingMes.length + ' transacciones';
  document.getElementById('d-gas-sub').textContent  = gasMes.length + ' transacciones';
  document.getElementById('d-deu-sub').textContent  = STATE.db.deudas.filter(d => d.total - (d.pagado||0) > 0).length + ' deudas activas';

  // Sub del hero balance: desglose de activos adicionales
  const partes = [];
  const balMesPos = balanceMes >= 0;
  partes.push((balMesPos ? '↑ +' : '↓ ') + fmt(Math.abs(balanceMes)) + ' este mes');
  if (totalPrestPendiente > 0) partes.push(fmt(totalPrestPendiente) + ' por cobrar');
  if (totalInvCapital > 0)     partes.push(fmt(totalInvCapital) + ' invertido');
  document.getElementById('d-balance-sub').textContent = partes.join(' · ');

  // Todas las transacciones ordenadas: más reciente primero
  // Desempate por hora si misma fecha, luego por creadoEn si existe
  const all = [
    ...STATE.db.ingresos.map(i => ({ ...i, tipo: 'ingreso' })),
    ...STATE.db.gastos.map(g => ({ ...g, tipo: 'gasto' })),
  ].sort((a, b) => {
    // Comparar fecha primero
    const fechaDiff = (b.fecha||'').localeCompare(a.fecha||'');
    if (fechaDiff !== 0) return fechaDiff;
    // Misma fecha: comparar hora (formato "03:45 PM")
    const horaA = a.hora ? convertirHora(a.hora) : 0;
    const horaB = b.hora ? convertirHora(b.hora) : 0;
    if (horaB !== horaA) return horaB - horaA;
    // Último desempate: por creadoEn (timestamp)
    return (b.creadoEn||'').localeCompare(a.creadoEn||'');
  });

  const tbl = document.getElementById('dash-recent');
  if (!all.length) {
    tbl.innerHTML = '<div class="empty-state"><div class="empty-icon"></div><p>Sin transacciones aún.</p></div>';
    return;
  }
  // Tabla con scroll: max-height para ver todos deslizando
  tbl.innerHTML = `
    <div class="table-wrap" style="max-height:420px;overflow-y:auto;">
    <table class="data-table">
      <thead style="position:sticky;top:0;z-index:2;">
        <tr><th>Fecha</th><th>Hora</th><th>Descripción</th><th>Tipo</th><th>Monto</th></tr>
      </thead>
      <tbody>
        ${all.map(r => `
          <tr>
            <td style="white-space:nowrap">${r.fecha || '-'}</td>
            <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">${r.hora || '—'}</td>
            <td>${r.fuente || r.desc || '-'}</td>
            <td><span class="badge ${r.tipo === 'ingreso' ? 'badge-green' : 'badge-red'}">${r.tipo}</span></td>
            <td style="color:${r.tipo==='ingreso' ? 'var(--green)' : 'var(--red)'};font-weight:600;white-space:nowrap">
              ${r.tipo === 'ingreso' ? '+' : '-'}${fmt(r.monto)}
            </td>
          </tr>`).join('')}
      </tbody>
    </table></div>`;

  // charts now in Reportes page
}

/* ============================================================
   DASHBOARD EYE TOGGLE
   ============================================================ */
let _dashDetailsVisible = false;

function toggleDashDetails() {
  _dashDetailsVisible = !_dashDetailsVisible;
  const panel    = document.getElementById('dash-detail-cards');
  const eyeIcon  = document.getElementById('dash-eye-icon');
  const eyeLabel = document.getElementById('dash-eye-label');
  if (!panel) return;
  if (_dashDetailsVisible) {
    panel.style.display = '';
    panel.style.animation = 'fadeSlide .25s ease';
    if (eyeIcon)  eyeIcon.textContent  = '';
    if (eyeLabel) eyeLabel.textContent = 'Ocultar';
  } else {
    panel.style.display = 'none';
    if (eyeIcon)  eyeIcon.textContent  = '️';
    if (eyeLabel) eyeLabel.textContent = 'Ver detalle';
  }
}

/* ============================================================
   CHARTS (pure Canvas)
   ============================================================ */
// drawBalanceChart moved to renderReportes module

// drawCatChart moved to renderReportes module

/* ============================================================
   INGRESOS
   ============================================================ */
async function saveIngreso() {
  const fecha  = document.getElementById('i-fecha').value;
  const monto  = Number(document.getElementById('i-monto').value);
  const fuente = document.getElementById('i-fuente').value.trim();
  const cat    = document.getElementById('i-cat').value;
  const editId = document.getElementById('ing-edit-id').value;

  if (!fecha)   return toast('La fecha es obligatoria', 'error');
  if (!monto)   return toast('El monto debe ser mayor a 0', 'error');
  if (!fuente)  return toast('La fuente es obligatoria', 'error');

  const hora = horaActual();
  const billeteraId = document.getElementById('i-billetera')?.value || '';
  if (editId) {
    const idx = STATE.db.ingresos.findIndex(i => i.id === editId);
    if (idx !== -1) {
      const horaRaw  = document.getElementById('i-hora-edit')?.value;
      const horaEdit = horaRaw ? inputTimeToHora(horaRaw) : (STATE.db.ingresos[idx].hora || hora);
      STATE.db.ingresos[idx] = { ...STATE.db.ingresos[idx], fecha, hora: horaEdit, monto, fuente, cat, billeteraId };
    }
    cancelEditIngreso();
  } else {
    STATE.db.ingresos.push({ id: uid(), fecha, hora, monto, fuente, cat, billeteraId });
  }
  clearForm(['i-monto','i-fuente']);
  renderAll();
  await saveDb(['ingresos']);
  toast(editId ? 'Ingreso actualizado ' : 'Ingreso registrado', 'success');
}

function editIngreso(id) {
  const item = STATE.db.ingresos.find(i => i.id === id);
  if (!item) return;
  document.getElementById('i-fecha').value  = item.fecha;
  document.getElementById('i-monto').value  = item.monto;
  document.getElementById('i-fuente').value = item.fuente;
  document.getElementById('i-cat').value    = item.cat || 'Otro';
  document.getElementById('ing-edit-id').value = id;
  // Mostrar hora original en el time picker
  const horaEl = document.getElementById('i-hora-edit');
  if (horaEl) horaEl.value = horaToInputTime(item.hora);
  const horaGroup = document.getElementById('i-hora-edit-group');
  if (horaGroup) horaGroup.style.display = '';
  document.getElementById('ing-form-title').textContent = 'Editar ingreso';
  document.getElementById('ing-cancel-btn').style.display = '';
  document.getElementById('page-ingresos').scrollIntoView({ behavior: 'smooth' });
}

function cancelEditIngreso() {
  document.getElementById('ing-edit-id').value = '';
  document.getElementById('ing-form-title').textContent = 'Nuevo ingreso';
  document.getElementById('ing-cancel-btn').style.display = 'none';
  const horaGroup = document.getElementById('i-hora-edit-group');
  if (horaGroup) horaGroup.style.display = 'none';
  clearForm(['i-monto','i-fuente']);
}

async function deleteIngreso(id) {
  if (!confirm('¿Eliminar este ingreso?')) return;
  STATE.db.ingresos = STATE.db.ingresos.filter(i => i.id !== id);
  renderAll();
  await saveDb(['ingresos']);
  toast('Ingreso eliminado', 'info');
}

// Al cambiar mes, repoblar selector de días
function onIngFilterChange() {
  populateDayFilter('i-filter-month', 'i-filter-day', STATE.db.ingresos);
  renderIngresos();
}

function clearIngFilters() {
  document.getElementById('i-filter-month').value = '';
  document.getElementById('i-filter-day').value   = '';
  document.getElementById('i-filter-search').value = '';
  populateDayFilter('i-filter-month', 'i-filter-day', STATE.db.ingresos);
  renderIngresos();
}

function renderIngresos() {
  const filterM  = document.getElementById('i-filter-month').value;
  const filterD  = document.getElementById('i-filter-day').value;
  const filterQ  = (document.getElementById('i-filter-search')?.value || '').toLowerCase().trim();

  let list = STATE.db.ingresos.filter(i => i.cat !== 'Transferencia').slice();
  if (filterM) list = list.filter(i => ym(i.fecha) === filterM);
  if (filterD) list = list.filter(i => i.fecha === filterD);
  if (filterQ) list = list.filter(i =>
    (i.fuente||'').toLowerCase().includes(filterQ) ||
    (i.cat||'').toLowerCase().includes(filterQ)
  );

  // Ordenar: más reciente primero (fecha + hora)
  list.sort((a, b) => {
    const fd = (b.fecha||'').localeCompare(a.fecha||'');
    if (fd !== 0) return fd;
    return convertirHora(b.hora) - convertirHora(a.hora);
  });

  const total = list.reduce((a, b) => a + Number(b.monto), 0);
  const label = filterD
    ? `Día ${filterD}` : filterM ? monthLabel(filterM) : 'Total general';
  document.getElementById('ing-total-mes').innerHTML = list.length
    ? `<span class="badge badge-green">${label}: ${fmt(total)} · ${list.length} registros</span>`
    : `<span class="badge badge-yellow">Sin resultados para este filtro</span>`;

  const tbody = document.getElementById('ing-tbody');
  const empty = document.getElementById('ing-empty');

  if (!list.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = list.map(i => `
    <tr>
      <td style="white-space:nowrap">${i.fecha}</td>
      <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">${i.hora || '—'}</td>
      <td>${i.fuente}</td>
      <td><span class="badge badge-blue">${i.cat || '-'}</span></td>
      <td style="color:var(--green);font-weight:600;white-space:nowrap">${fmt(i.monto)}</td>
      <td>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" onclick="editIngreso('${i.id}')">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="deleteIngreso('${i.id}')">️</button>
        </div>
      </td>
    </tr>`).join('');
}

/* ============================================================
   GASTOS
   ============================================================ */
async function saveGasto() {
  const fecha  = document.getElementById('g-fecha').value;
  const monto  = Number(document.getElementById('g-monto').value);
  const desc   = document.getElementById('g-desc').value.trim();
  const cat    = document.getElementById('g-cat').value;
  const editId = document.getElementById('gas-edit-id').value;

  if (!fecha)  return toast('La fecha es obligatoria', 'error');
  if (!monto)  return toast('El monto debe ser mayor a 0', 'error');
  if (!desc)   return toast('La descripción es obligatoria', 'error');

  const billeteraId = document.getElementById('g-billetera')?.value || '';
  if (!billeteraId) {
    const sel = document.getElementById('g-billetera');
    if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(() => sel.style.border = '', 2000); }
    return toast('Debes seleccionar de qué billetera sale el dinero', 'error');
  }

  // Validar saldo suficiente solo al registrar nuevo (no al editar, ya que el gasto ya está contabilizado)
  if (!editId) {
    const saldoDisp = saldoBilletera(billeteraId);
    if (monto > saldoDisp) {
      const bill = STATE.db.billeteras?.find(b => b.id === billeteraId);
      const billNombre = bill ? bill.nombre : 'la billetera';
      const sel = document.getElementById('g-billetera');
      if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(() => sel.style.border = '', 2500); }
      return toast(`Saldo insuficiente en ${billNombre}. Disponible: ${fmt(saldoDisp)} — Necesitas: ${fmt(monto)}`, 'error');
    }
  }
  if (editId) {
    const idx = STATE.db.gastos.findIndex(g => g.id === editId);
    if (idx !== -1) {
      // Conservar hora original; si el usuario la editó, usar la nueva
      const horaRaw = document.getElementById('g-hora-edit')?.value;
      const horaEdit = horaRaw ? inputTimeToHora(horaRaw) : (STATE.db.gastos[idx].hora || horaActual());
      STATE.db.gastos[idx] = { ...STATE.db.gastos[idx], fecha, hora: horaEdit, monto, desc, cat, billeteraId };
    }
    cancelEditGasto();
  } else {
    registrarGastoConGMF({ id: uid(), fecha, hora: horaActual(), monto, desc, cat, billeteraId });
  }
  clearForm(['g-monto','g-desc']);
  renderAll();           // actualiza UI inmediatamente
  await saveDb();        // guarda en Firebase en background
  toast(editId ? 'Gasto actualizado ' : 'Gasto registrado', 'success');
}

function editGasto(id) {
  const item = STATE.db.gastos.find(g => g.id === id);
  if (!item) return;
  document.getElementById('g-fecha').value  = item.fecha;
  document.getElementById('g-monto').value  = item.monto;
  document.getElementById('g-desc').value   = item.desc;
  document.getElementById('g-cat').value    = item.cat || 'Otro';
  document.getElementById('gas-edit-id').value = id;
  // Mostrar hora original en el time picker
  const horaEl = document.getElementById('g-hora-edit');
  if (horaEl) horaEl.value = horaToInputTime(item.hora);
  const horaGroup = document.getElementById('g-hora-edit-group');
  if (horaGroup) horaGroup.style.display = '';
  document.getElementById('gas-form-title').textContent = 'Editar gasto';
  document.getElementById('gas-cancel-btn').style.display = '';
  document.getElementById('page-gastos').scrollIntoView({ behavior: 'smooth' });
}

function cancelEditGasto() {
  document.getElementById('gas-edit-id').value = '';
  document.getElementById('gas-form-title').textContent = 'Nuevo gasto';
  document.getElementById('gas-cancel-btn').style.display = 'none';
  const horaGroup = document.getElementById('g-hora-edit-group');
  if (horaGroup) horaGroup.style.display = 'none';
  clearForm(['g-monto','g-desc']);
}

async function deleteGasto(id) {
  if (!confirm('¿Eliminar este gasto?')) return;
  STATE.db.gastos = STATE.db.gastos.filter(g => g.id !== id);
  renderAll();
  await saveDb(['gastos']);
  toast('Gasto eliminado', 'info');
}

// Al cambiar mes, repoblar selector de días
function onGasFilterChange() {
  populateDayFilter('g-filter-month', 'g-filter-day', STATE.db.gastos);
  renderGastos();
}

function clearGasFilters() {
  document.getElementById('g-filter-month').value = '';
  document.getElementById('g-filter-day').value   = '';
  document.getElementById('g-filter-cat').value   = '';
  document.getElementById('g-filter-search').value = '';
  populateDayFilter('g-filter-month', 'g-filter-day', STATE.db.gastos);
  renderGastos();
}

function toggleAnalisisCat() {
  const panel = document.getElementById('gas-analysis');
  const btn   = document.getElementById('btn-toggle-cat');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  btn.textContent = visible ? '▼ Ver análisis' : '▲ Ocultar';
}

function renderGastos() {
  const filterM  = document.getElementById('g-filter-month').value;
  const filterD  = document.getElementById('g-filter-day').value;
  const filterC  = document.getElementById('g-filter-cat').value;
  const filterQ  = (document.getElementById('g-filter-search')?.value || '').toLowerCase().trim();

  let list = STATE.db.gastos.filter(g => g.cat !== 'Transferencia').slice();
  if (filterM) list = list.filter(g => ym(g.fecha) === filterM);
  if (filterD) list = list.filter(g => g.fecha === filterD);
  if (filterC) list = list.filter(g => g.cat === filterC);
  if (filterQ) list = list.filter(g =>
    (g.desc||'').toLowerCase().includes(filterQ) ||
    (g.cat||'').toLowerCase().includes(filterQ)
  );

  // Ordenar: más reciente primero (fecha + hora)
  list.sort((a, b) => {
    const fd = (b.fecha||'').localeCompare(a.fecha||'');
    if (fd !== 0) return fd;
    return convertirHora(b.hora) - convertirHora(a.hora);
  });

  const total = list.reduce((a, b) => a + Number(b.monto), 0);
  const label = filterD
    ? `Día ${filterD}` : filterM ? monthLabel(filterM) : 'Total general';
  document.getElementById('gas-total-mes').innerHTML = list.length
    ? `<span class="badge badge-red">${label}: ${fmt(total)} · ${list.length} registros</span>`
    : `<span class="badge badge-yellow">Sin resultados para este filtro</span>`;

  // Category analysis
  const catTotals = {};
  STATE.db.gastos.forEach(g => {
    catTotals[g.cat] = (catTotals[g.cat] || 0) + Number(g.monto);
  });
  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const totalAll = sorted.reduce((a, b) => a + b[1], 0);
  const COLORS = ['#ef4444','#f59e0b','#3b82f6','#10b981','#8b5cf6','#ec4899'];

  const analysisEl = document.getElementById('gas-analysis');
  if (sorted.length) {
    analysisEl.innerHTML = `
      <div style="margin-bottom:8px;">
        <span class="badge badge-red">Mayor gasto: ${sorted[0][0]}</span>
      </div>
      ${sorted.map(([cat, val], i) => `
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:.85rem;">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${COLORS[i%COLORS.length]};margin-right:6px;"></span>${cat}</span>
            <span style="color:var(--muted)">${fmt(val)} · ${Math.round(val/totalAll*100)}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:${Math.round(val/totalAll*100)}%;background:${COLORS[i%COLORS.length]}"></div>
          </div>
        </div>`).join('')}`;
  } else {
    analysisEl.innerHTML = '';
  }

  const tbody = document.getElementById('gas-tbody');
  const empty = document.getElementById('gas-empty');

  if (!list.length) {
    tbody.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = list.map(g => `
    <tr>
      <td>${g.fecha}</td>
      <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">${g.hora || '—'}</td>
      <td>${g.desc}</td>
      <td><span class="badge badge-yellow">${g.cat || '-'}</span></td>
      <td style="color:var(--red);font-weight:600">${fmt(g.monto)}</td>
      <td>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" onclick="editGasto('${g.id}')">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="deleteGasto('${g.id}')">️</button>
        </div>
      </td>
    </tr>`).join('');
}

/* ============================================================
   DEUDAS
   ============================================================ */
function onDeudaTipoChange() {
  const tipo = document.getElementById('d-tipo').value;
  const grp  = document.getElementById('d-billetera-group');
  if (grp) grp.style.display = tipo === 'prestamo' ? '' : 'none';
  // populate billetera select
  populateBilleteraSelects();
  const sel = document.getElementById('d-billetera');
  if (sel && tipo === 'prestamo') {
    sel.innerHTML = '<option value="">Sin asignar</option>';
    (STATE.db.billeteras||[]).forEach(b => {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre;
      sel.appendChild(o);
    });
  }
}

async function saveDeuda() {
  const nombre     = document.getElementById('d-nombre').value.trim();
  const total      = Number(document.getElementById('d-total').value);
  const fecha      = document.getElementById('d-fecha').value;
  const cuota      = Number(document.getElementById('d-cuota').value) || 0;
  const prox       = document.getElementById('d-prox').value;
  const interes    = Number(document.getElementById('d-interes').value) || 0;
  const tipo       = document.getElementById('d-tipo')?.value || 'compra';
  const billeteraId = tipo === 'prestamo' ? (document.getElementById('d-billetera')?.value || '') : '';

  if (!nombre) return toast('El nombre es obligatorio', 'error');
  if (!total)  return toast('El monto total es obligatorio', 'error');
  if (!fecha)  return toast('La fecha de inicio es obligatoria', 'error');
  if (tipo === 'prestamo' && !billeteraId) {
    if (!confirm('No seleccionaste una billetera. El dinero del préstamo no se sumará a ninguna cuenta. ¿Continuar?')) return;
  }

  STATE.db.deudas.push({ id: uid(), nombre, total, fecha, cuota, prox, interes, tipo, billeteraId, pagado: 0, pagos: [] });

  // Si es préstamo recibido, registrar como ingreso en la billetera
  if (tipo === 'prestamo') {
    const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
    STATE.db.ingresos.push({
      id: uid(), fecha,
      hora: horaActual(),
      monto: total,
      fuente: 'Préstamo recibido: ' + nombre,
      cat: 'Préstamo recibido',
      billeteraId,
      autoGenerado: true
    });
    const billNombre = bill ? ` → ${bill.nombre}` : '';
    toast(`Deuda creada${billNombre}. Dinero sumado como ingreso `, 'success');
  } else {
    toast('Deuda de compra creada', 'success');
  }

  clearForm(['d-nombre','d-total','d-cuota','d-interes']);
  document.getElementById('d-tipo').value = 'compra';
  onDeudaTipoChange();
  closeModal('modal-nueva-deuda');
  renderAll();
  await saveDb(['deudas','ingresos']);
}

function openAbonar(idx) {
  const d = STATE.db.deudas[idx];
  if (!d) return;
  document.getElementById('m-abonar-idx').value = idx;
  document.getElementById('m-abonar-nombre').value = d.nombre;
  document.getElementById('m-abonar-monto').value = d.cuota || '';
  document.getElementById('m-abonar-fecha').value = new Date().toISOString().slice(0,10);
  document.getElementById('m-abonar-nota').value = '';
  populateBilleteraSelects();
  openModal('modal-abonar');
}

async function registrarAbono() {
  const idx   = Number(document.getElementById('m-abonar-idx').value);
  const monto = Number(document.getElementById('m-abonar-monto').value);
  const fecha = document.getElementById('m-abonar-fecha').value;
  const nota  = document.getElementById('m-abonar-nota').value.trim();
  const d     = STATE.db.deudas[idx];

  if (!d)     return toast('Deuda no encontrada', 'error');
  if (!monto) return toast('El monto del abono es requerido', 'error');
  if (!fecha) return toast('La fecha es requerida', 'error');

  const falta = d.total - (d.pagado || 0);
  if (monto > falta) return toast('El abono supera el saldo pendiente', 'error');

  // Registrar abono en la deuda
  const abonoId = uid();
  d.pagado = (d.pagado || 0) + monto;
  d.pagos.push({ id: abonoId, fecha, monto, nota });

  // AUTO-REGISTRAR como gasto (categoría Crédito / Deuda) + 4x1000 si aplica
  const billeteraIdAbono = document.getElementById('m-abonar-billetera')?.value || '';
  registrarGastoConGMF({
    id: uid(), fecha, hora: horaActual(), monto,
    desc: 'Abono deuda: ' + d.nombre + (nota ? ' — ' + nota : ''),
    cat: 'Crédito / Deuda',
    billeteraId: billeteraIdAbono,
    autoGenerado: true, origenAbonoId: abonoId
  });

  renderAll();
  closeModal('modal-abonar');
  await saveDb(['deudas','gastos']);
  toast('Abono registrado y añadido automáticamente a gastos', 'success');
}

async function deleteDeuda(idx) {
  pedirPinParaAccion('Eliminar deuda', async () => {
    STATE.db.deudas.splice(idx, 1);
    renderAll();
    await saveDb(['deudas']);
    toast('Deuda eliminada', 'info');
  });
}

async function deleteAbono(dIdx, pId) {
  pedirPinParaAccion('Eliminar abono', async () => {
    const d = STATE.db.deudas[dIdx];
    const p = d.pagos.find(p => p.id === pId);
    if (!p) return;
    d.pagado -= p.monto;
    d.pagos   = d.pagos.filter(p2 => p2.id !== pId);
    renderAll();
    await saveDb(['deudas','gastos']);
    toast('Abono eliminado', 'info');
  });
}

// ══ Editar deuda básica ══
function openEditDeuda(idx) {
  const d = STATE.db.deudas[idx];
  if (!d) return;
  document.getElementById('med-idx').value    = idx;
  document.getElementById('med-nombre').value = d.nombre || '';
  document.getElementById('med-cuota').value  = d.cuota || '';
  document.getElementById('med-prox').value   = d.prox || '';
  document.getElementById('med-interes').value = d.interes || '';
  openModal('modal-edit-deuda');
}

async function saveEditDeuda() {
  const idx     = Number(document.getElementById('med-idx').value);
  const nombre  = document.getElementById('med-nombre').value.trim();
  const cuota   = Number(document.getElementById('med-cuota').value) || 0;
  const prox    = document.getElementById('med-prox').value;
  const interes = Number(document.getElementById('med-interes').value) || 0;
  const d = STATE.db.deudas[idx];
  if (!d)    return toast('Deuda no encontrada', 'error');
  if (!nombre) return toast('El nombre es obligatorio', 'error');
  d.nombre  = nombre;
  d.cuota   = cuota;
  d.prox    = prox;
  d.interes = interes;
  closeModal('modal-edit-deuda');
  renderAll();
  await saveDb(['deudas']);
  toast('Deuda actualizada', 'success');
}

// ══ Sumar más saldo a la misma deuda ══
function onMsdTipoChange() {
  const tipo = document.getElementById('msd-tipo').value;
  const grp  = document.getElementById('msd-billetera-group');
  if (grp) grp.style.display = tipo === 'prestamo' ? '' : 'none';
}

function openSumarDeuda(idx) {
  const d = STATE.db.deudas[idx];
  if (!d) return;
  document.getElementById('msd-idx').value  = idx;
  document.getElementById('msd-monto').value = '';
  document.getElementById('msd-desc').value  = '';
  document.getElementById('msd-fecha').value = new Date().toISOString().slice(0,10);
  document.getElementById('msd-tipo').value  = 'prestamo';
  onMsdTipoChange();
  // Info de la deuda actual
  const falta = Math.max(0, d.total - (d.pagado || 0));
  document.getElementById('msd-deuda-info').innerHTML =
    `<strong>${d.nombre}</strong><br>` +
    `Deuda actual: <strong>${fmt(d.total)}</strong> · ` +
    `Pagado: <strong style="color:var(--green)">${fmt(d.pagado||0)}</strong> · ` +
    `Pendiente: <strong style="color:var(--red)">${fmt(falta)}</strong>`;
  // Poblar billeteras
  const sel = document.getElementById('msd-billetera');
  sel.innerHTML = '<option value="">Sin asignar</option>';
  (STATE.db.billeteras||[]).forEach(b => {
    const saldo = saldoBilletera(b.id);
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldo);
    sel.appendChild(o);
  });
  openModal('modal-sumar-deuda');
}

async function confirmarSumarDeuda() {
  const idx         = Number(document.getElementById('msd-idx').value);
  const monto       = Number(document.getElementById('msd-monto').value);
  const fecha       = document.getElementById('msd-fecha').value;
  const desc        = document.getElementById('msd-desc').value.trim();
  const tipoMsd     = document.getElementById('msd-tipo').value; // 'prestamo' o 'compra'
  const billeteraId = tipoMsd === 'prestamo' ? (document.getElementById('msd-billetera').value || '') : '';
  const d           = STATE.db.deudas[idx];

  if (!d)     return toast('Deuda no encontrada', 'error');
  if (!monto || monto <= 0) return toast('El monto adicional debe ser mayor a 0', 'error');
  if (!fecha) return toast('La fecha es obligatoria', 'error');
  if (!desc)  return toast('El motivo / detalle es obligatorio', 'error');

  // Registrar el desembolso adicional en el historial de la deuda
  if (!d.desembolsos) d.desembolsos = [];
  const desembolsoId = uid();
  d.desembolsos.push({ id: desembolsoId, fecha, monto, desc, billeteraId, tipo: tipoMsd });

  // Aumentar el total de la deuda
  d.total = (d.total || 0) + monto;

  // Solo si es préstamo recibido, registrar como ingreso en billetera
  if (tipoMsd === 'prestamo' && billeteraId) {
    const bill = STATE.db.billeteras?.find(b => b.id === billeteraId);
    STATE.db.ingresos.push({
      id: uid(), fecha,
      hora: horaActual(),
      monto,
      fuente: 'Dinero adicional deuda: ' + d.nombre + ' — ' + desc,
      cat: 'Préstamo recibido',
      billeteraId,
      autoGenerado: true,
      origenDesembolsoId: desembolsoId
    });
    const bn = bill ? ` → ${bill.nombre}` : '';
    toast(`${fmt(monto)} sumados a la deuda${bn} `, 'success');
  } else if (tipoMsd === 'compra') {
    toast(`Compra a crédito de ${fmt(monto)} registrada — deuda aumentada `, 'success');
  } else {
    toast(`${fmt(monto)} sumados a la deuda `, 'success');
  }

  closeModal('modal-sumar-deuda');
  renderAll();
  await saveDb(['deudas', 'ingresos']);
}

async function deleteDesembolso(dIdx, desId) {
  pedirPinParaAccion('Eliminar saldo adicional', async () => {
    const d = STATE.db.deudas[dIdx];
    if (!d || !d.desembolsos) return;
    const des = d.desembolsos.find(x => x.id === desId);
    if (!des) return;
    d.total = Math.max(0, (d.total || 0) - des.monto);
    d.desembolsos = d.desembolsos.filter(x => x.id !== desId);
    renderAll();
    await saveDb(['deudas']);
    toast('Saldo adicional eliminado', 'info');
  });
}

function renderDeudas() {
  const container = document.getElementById('deudas-lista');
  const empty     = document.getElementById('deudas-empty');

  // Inject filter tabs if not present
  let tabsEl = document.getElementById('deudas-filter-tabs');
  if (!tabsEl) {
    tabsEl = document.createElement('div');
    tabsEl.id = 'deudas-filter-tabs';
    tabsEl.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;';
    tabsEl.innerHTML = `
      <button id="deudas-tab-pend" class="btn btn-primary btn-sm" onclick="setDeudasTab('pendientes')">Pendientes</button>
      <button id="deudas-tab-pag"  class="btn btn-ghost btn-sm"   onclick="setDeudasTab('pagadas')">Pagadas / Canceladas</button>
      <span id="deudas-tab-label" style="font-size:.8rem;color:var(--muted);margin-left:4px;"></span>`;
    container.parentNode.insertBefore(tabsEl, container);
  }

  const tab = window._deudasTab || 'pendientes';
  const q = (document.getElementById('deudas-search')?.value || '').toLowerCase().trim();
  const todosDeudas = STATE.db.deudas;
  const pendientes = todosDeudas.filter(d => Math.max(0, d.total - (d.pagado||0)) > 0);
  const pagadas    = todosDeudas.filter(d => Math.max(0, d.total - (d.pagado||0)) === 0);
  const listaBase  = tab === 'pagadas' ? pagadas : pendientes;
  const lista = q ? listaBase.filter(d => d.nombre?.toLowerCase().includes(q)) : listaBase;

  // Update tab buttons
  const tPend = document.getElementById('deudas-tab-pend');
  const tPag  = document.getElementById('deudas-tab-pag');
  const tLbl  = document.getElementById('deudas-tab-label');
  if (tPend) { tPend.className = tab==='pendientes'?'btn btn-primary btn-sm':'btn btn-ghost btn-sm'; }
  if (tPag)  { tPag.className  = tab==='pagadas'   ?'btn btn-primary btn-sm':'btn btn-ghost btn-sm'; }
  if (tLbl)  { tLbl.textContent = `${pendientes.length} pendiente${pendientes.length!==1?'s':''} · ${pagadas.length} cancelada${pagadas.length!==1?'s':''}`; }

  if (!lista.length) {
    container.innerHTML = '';
    empty.style.display = '';
    empty.querySelector?.('.empty-icon') && (empty.querySelector('.empty-icon').textContent = tab==='pagadas'?'':'');
    empty.querySelector?.('p') && (empty.querySelector('p').textContent = tab==='pagadas'?'No hay deudas canceladas aún.':'Sin deudas pendientes. ¡Excelente!');
    return;
  }
  empty.style.display = 'none';

  container.innerHTML = lista.map((d, i) => {
    const realIdx  = STATE.db.deudas.indexOf(d);
    const falta    = Math.max(0, d.total - (d.pagado || 0));
    const pct      = Math.min(100, Math.round((d.pagado || 0) / d.total * 100));
    const terminada = falta === 0;
    const cuotasRest = d.cuota ? Math.ceil(falta / d.cuota) : null;
    const expandId = `debt-expand-${realIdx}`;

    return `
    <div class="debt-card" style="padding:0;overflow:hidden;">
      <!-- Cabecera siempre visible: click para expandir -->
      <div onclick="toggleDeudaExpand('${expandId}')" style="display:flex;align-items:center;gap:14px;padding:16px 18px;cursor:pointer;user-select:none;">
        <!-- Indicador progreso circular mini -->
        <div style="position:relative;width:44px;height:44px;flex-shrink:0;">
          <svg width="44" height="44" viewBox="0 0 44 44">
            <circle cx="22" cy="22" r="18" fill="none" stroke="var(--border)" stroke-width="3"/>
            <circle cx="22" cy="22" r="18" fill="none"
              stroke="${terminada ? 'var(--green)' : pct > 60 ? 'var(--yellow)' : 'var(--red)'}"
              stroke-width="3" stroke-linecap="round"
              stroke-dasharray="${(2*Math.PI*18).toFixed(1)}"
              stroke-dashoffset="${((1 - pct/100) * 2*Math.PI*18).toFixed(1)}"
              transform="rotate(-90 22 22)"/>
          </svg>
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:var(--text);">${pct}%</span>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:.95rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${d.nombre}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-top:2px;">Desde ${formatFechaLarga(d.fecha)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-weight:700;font-size:1rem;color:${terminada?'var(--green)':'var(--red)'};">${fmt(falta)}</div>
          <div style="font-size:.7rem;color:var(--muted);">falta pagar</div>
        </div>
        <span class="badge ${terminada ? 'badge-green' : 'badge-red'}" style="flex-shrink:0;">${terminada ? '✓' : 'Pendiente'}</span>
        <svg id="${expandId}-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.5" style="flex-shrink:0;transition:transform .25s;"><polyline points="6 9 12 15 18 9"/></svg>
      </div>

      <!-- Contenido expandible -->
      <div id="${expandId}" style="display:none;border-top:1px solid var(--border);">
        <!-- Stats -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-bottom:1px solid var(--border);">
          <div style="padding:12px 16px;border-right:1px solid var(--border);">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Total deuda</div>
            <div style="font-weight:700;font-size:.95rem;color:var(--text);">${fmt(d.total)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border);">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Pagado</div>
            <div style="font-weight:700;font-size:.95rem;color:var(--green);">${fmt(d.pagado||0)}</div>
          </div>
          <div style="padding:12px 16px;">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Cuota sugerida</div>
            <div style="font-weight:700;font-size:.95rem;color:var(--text);">${d.cuota ? fmt(d.cuota) : '—'}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-bottom:1px solid var(--border);">
          <div style="padding:12px 16px;border-right:1px solid var(--border);">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Próximo pago</div>
            <div style="font-weight:600;font-size:.85rem;color:var(--text);">${d.prox ? formatFechaLarga(d.prox) : '—'}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border);">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Cuotas restantes</div>
            <div style="font-weight:700;font-size:.95rem;color:var(--text);">${cuotasRest ?? '—'}</div>
          </div>
          <div style="padding:12px 16px;">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Interés anual</div>
            <div style="font-weight:700;font-size:.95rem;color:var(--text);">${d.interes ? d.interes + '%' : '—'}</div>
          </div>
        </div>

        <!-- Acciones -->
        <div style="display:flex;gap:8px;padding:14px 16px;flex-wrap:wrap;border-bottom:1px solid var(--border);">
          ${!terminada ? `<button class="btn btn-success btn-sm" onclick="openAbonar(${realIdx})">+ Registrar abono</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="openSumarDeuda(${realIdx})">Agregar saldo</button>
          <button class="btn btn-ghost btn-sm" onclick="openEditDeuda(${realIdx})">Editar</button>
          <button class="btn btn-danger btn-sm" onclick="deleteDeuda(${realIdx})">Eliminar</button>
        </div>

        <!-- Historial de pagos -->
        ${d.pagos.length ? `
        <div style="padding:14px 16px;">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;">Historial de abonos (${d.pagos.length})</div>
          ${d.pagos.slice().reverse().map(p => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light);">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;"></div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:.83rem;font-weight:600;color:var(--text);">${formatFechaLarga(p.fecha)}</div>
                ${p.nota ? `<div style="font-size:.73rem;color:var(--muted);">${p.nota}</div>` : ''}
                ${p.autoGastoFijoId ? `<div style="font-size:.7rem;color:var(--accent);">Abono automático desde gasto fijo</div>` : ''}
              </div>
              <span style="font-weight:700;color:var(--green);font-size:.9rem;flex-shrink:0;">${fmt(p.monto)}</span>
              ${!p.autoGastoFijoId ? `<button onclick="deleteAbono(${realIdx},'${p.id}')" style="background:none;border:none;cursor:pointer;color:var(--light);padding:2px 5px;border-radius:4px;font-size:.8rem;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--light)'">✕</button>` : ''}
            </div>`).join('')}
        </div>` : ''}

        <!-- Desembolsos adicionales -->
        ${(d.desembolsos && d.desembolsos.length) ? `
        <div style="padding:14px 16px;border-top:1px solid var(--border);">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:10px;">Saldo adicional agregado (${d.desembolsos.length})</div>
          ${d.desembolsos.slice().reverse().map(des => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light);">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;"></div>
              <div style="flex:1;min-width:0;">
                <div style="font-size:.83rem;font-weight:600;color:var(--text);">${formatFechaLarga(des.fecha)}</div>
                ${des.desc ? `<div style="font-size:.73rem;color:var(--muted);">${des.desc}</div>` : ''}
              </div>
              <span style="font-weight:700;color:var(--accent);font-size:.9rem;flex-shrink:0;">+${fmt(des.monto)}</span>
              <button onclick="deleteDesembolso(${realIdx},'${des.id}')" style="background:none;border:none;cursor:pointer;color:var(--light);padding:2px 5px;border-radius:4px;font-size:.8rem;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--light)'">✕</button>
            </div>`).join('')}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function toggleDeudaExpand(id) {
  const el   = document.getElementById(id);
  const icon = document.getElementById(id + '-icon');
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  if (icon) icon.style.transform = open ? '' : 'rotate(180deg)';
}

function setDeudasTab(tab) {
  window._deudasTab = tab;
  renderDeudas();
}

/* ============================================================
   CONTRASEÑAS
   ============================================================ */
async function savePass() {
  const nom   = document.getElementById('p-nom').value.trim();
  const user  = document.getElementById('p-user').value.trim();
  const pass  = document.getElementById('p-pass').value;
  const notes = document.getElementById('p-notes').value.trim();

  if (!nom)  return toast('El nombre es obligatorio', 'error');
  if (!user) return toast('El usuario es obligatorio', 'error');
  if (!pass) return toast('La contraseña es obligatoria', 'error');

  STATE.db.pass.push({ id: uid(), nom, user, pass, notes });
  clearForm(['p-nom','p-user','p-pass','p-notes']);
  renderPass();
  await saveDb(['pass']);
  toast('Contraseña guardada', 'success');
}

async function deletePass(id) {
  if (!confirm('¿Eliminar esta contraseña?')) return;
  STATE.db.pass = STATE.db.pass.filter(p => p.id !== id);
  renderPass();
  await saveDb(['pass']);
  toast('Contraseña eliminada', 'info');
}

function togglePassVis(id, btn) {
  const input = document.getElementById('pval-' + id);
  if (input.type === 'password') { input.type = 'text'; btn.textContent = ''; }
  else                           { input.type = 'password'; btn.textContent = '️'; }
}

function copyPass(id) {
  const p = STATE.db.pass.find(p => p.id === id);
  if (!p) return;
  navigator.clipboard.writeText(p.pass).then(() => toast('Contraseña copiada al portapapeles', 'success'));
}

function renderPass(search = '') {
  let list = STATE.db.pass.slice();
  if (search) list = list.filter(p =>
    p.nom.toLowerCase().includes(search.toLowerCase()) ||
    p.user.toLowerCase().includes(search.toLowerCase())
  );

  const container = document.getElementById('pass-lista');
  const empty     = document.getElementById('pass-empty');

  if (!list.length) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  container.innerHTML = list.map(p => `
    <div class="pass-card">
      <div class="pass-info">
        <div class="pass-name">${p.nom}</div>
        <div class="pass-user">${p.user}${p.notes ? ' · ' + p.notes : ''}</div>
      </div>
      <div class="pass-controls">
        <input type="password" class="pass-val" id="pval-${p.id}" value="${p.pass}" readonly>
        <button class="btn btn-ghost btn-sm" onclick="togglePassVis('${p.id}',this)" title="Mostrar/ocultar">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm" onclick="copyPass('${p.id}')" title="Copiar">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn btn-danger btn-sm" onclick="deletePass('${p.id}')" title="Eliminar">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </div>`).join('');
}

/* ============================================================
   PRÉSTAMOS A TERCEROS
   ============================================================ */
function togglePrestStats() {
  const body = document.getElementById('prest-stats-body');
  const btn  = document.getElementById('prest-stats-toggle');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  if (btn) btn.textContent = open ? 'Ver resumen' : 'Ocultar resumen';
}

function toggleGFStats() {
  const visible = localStorage.getItem('gf_stats_visible') !== 'false';
  localStorage.setItem('gf_stats_visible', visible ? 'false' : 'true');
  renderGastosFijos();
}

function openModalNuevoGastoFijo() {
  ['gf-nombre','gf-monto','gf-dia','gf-notas'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('gf-cat').value = 'Arriendo';
  populateBilleteraSelects();
  populateGFDeudaSelect('gf-deuda-vinc', '');
  openModal('modal-nuevo-gasto-fijo');
}

function openModalNuevoPrestamo() {
  ['pr-nombre','pr-contacto','pr-monto','pr-interes','pr-desc'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('pr-fecha').value = today;
  document.getElementById('pr-vence').value = '';
  populateBilleteraSelects();
  openModal('modal-nuevo-prestamo');
}

async function savePrestamo() {
  const nombre      = document.getElementById('pr-nombre').value.trim();
  const contacto    = document.getElementById('pr-contacto').value.trim();
  const monto       = Number(document.getElementById('pr-monto').value);
  const fecha       = document.getElementById('pr-fecha').value;
  const vence       = document.getElementById('pr-vence').value;
  const interes     = Number(document.getElementById('pr-interes').value) || 0;
  const desc        = document.getElementById('pr-desc').value.trim();
  const billeteraId = document.getElementById('pr-billetera')?.value || '';

  if (!nombre)      return toast('El nombre del deudor es obligatorio', 'error');
  if (!monto)       return toast('El monto es obligatorio', 'error');
  if (!fecha)       return toast('La fecha es obligatoria', 'error');
  if (!billeteraId) return toast('Debes seleccionar de qué billetera sale el dinero', 'error');

  // Verificar saldo suficiente
  const saldo = saldoBilletera(billeteraId);
  if (saldo < monto) {
    const bill = STATE.db.billeteras.find(b => b.id === billeteraId);
    return toast(`Saldo insuficiente en ${bill?.nombre || 'la billetera'} (${fmt(saldo)})`, 'error');
  }

  const totalConInteres = interes > 0 ? monto * (1 + interes / 100) : monto;
  const billNombre = STATE.db.billeteras.find(b => b.id === billeteraId)?.nombre || '';

  // Registrar como gasto para que se descuente de la billetera
  registrarGastoConGMF({
    id: uid(), fecha, hora: horaActual(), monto,
    desc: 'Préstamo a: ' + nombre + (desc ? ' — ' + desc : ''),
    cat: 'Préstamo otorgado',
    billeteraId,
    autoGenerado: true
  });

  STATE.db.prestamos.push({
    id: uid(), nombre, contacto, monto, totalConInteres, fecha, vence, interes, desc,
    cobrado: 0, cobros: [], billeteraOrigen: billeteraId
  });

  clearForm(['pr-nombre','pr-contacto','pr-monto','pr-vence','pr-interes','pr-desc']);
  closeModal('modal-nuevo-prestamo');
  renderAll();
  await saveDb(['prestamos', 'gastos']);
  toast(`Préstamo registrado — descontado de ${billNombre}`, 'success');
}
function openCobro(idx) {
  const p = STATE.db.prestamos[idx];
  if (!p) return;
  document.getElementById('m-cobro-idx').value    = idx;
  document.getElementById('m-cobro-nombre').value = p.nombre;
  document.getElementById('m-cobro-monto').value  = '';
  document.getElementById('m-cobro-fecha').value  = new Date().toISOString().slice(0,10);
  document.getElementById('m-cobro-nota').value   = '';
  populateBilleteraSelects();
  openModal('modal-cobro');
}

async function registrarCobro() {
  const idx        = Number(document.getElementById('m-cobro-idx').value);
  const monto      = Number(document.getElementById('m-cobro-monto').value);
  const fecha      = document.getElementById('m-cobro-fecha').value;
  const nota       = document.getElementById('m-cobro-nota').value.trim();
  const billeteraId = document.getElementById('m-cobro-billetera')?.value || '';
  const p          = STATE.db.prestamos[idx];

  if (!p)     return toast('Préstamo no encontrado', 'error');
  if (!monto) return toast('El monto es requerido', 'error');
  if (!fecha) return toast('La fecha es requerida', 'error');

  const falta = p.totalConInteres - (p.cobrado || 0);
  if (monto > falta) return toast('El cobro supera el saldo pendiente', 'error');

  const cobroId = uid();
  p.cobrado = (p.cobrado || 0) + monto;
  p.cobros.push({ id: cobroId, fecha, monto, nota, billeteraId });

  // Auto-registrar como INGRESO con detalle del deudor
  const billNombre = billeteraId
    ? (STATE.db.billeteras.find(b=>b.id===billeteraId)?.nombre || '') : '';
  STATE.db.ingresos.push({
    id: uid(), fecha,
    hora: horaActual(),
    monto,
    fuente: 'Cobro préstamo: ' + p.nombre + (nota ? ' — ' + nota : ''),
    cat: 'Préstamo cobrado',
    billeteraId,
    autoGenerado: true,
    origenCobroId: cobroId
  });

  renderAll();
  closeModal('modal-cobro');
  await saveDb(['prestamos', 'ingresos']);
  const destino = billNombre ? ` → ${billNombre}` : '';
  toast(`Cobro registrado${destino} e ingreso generado `, 'success');
}

async function deleteCobro(pIdx, cId) {
  pedirPinParaAccion('Eliminar cobro', async () => {
    const p = STATE.db.prestamos[pIdx];
    const c = p.cobros.find(c => c.id === cId);
    if (!c) return;
    p.cobrado -= c.monto;
    p.cobros   = p.cobros.filter(c2 => c2.id !== cId);
    renderAll();
    await saveDb(['prestamos']);
    toast('Cobro eliminado', 'info');
  });
}

async function deletePrestamo(idx) {
  pedirPinParaAccion('Eliminar préstamo', async () => {
    STATE.db.prestamos.splice(idx, 1);
    renderAll();
    await saveDb(['prestamos']);
    toast('Préstamo eliminado', 'info');
  });
}

// ══ Ampliar préstamo existente (prestar más a la misma persona) ══
function openAmpliarPrestamo(idx) {
  const p = STATE.db.prestamos[idx];
  if (!p) return;
  document.getElementById('map-idx').value   = idx;
  document.getElementById('map-monto').value = '';
  document.getElementById('map-desc').value  = '';
  document.getElementById('map-fecha').value = new Date().toISOString().slice(0,10);
  const falta = Math.max(0, p.totalConInteres - (p.cobrado || 0));
  document.getElementById('map-prest-info').innerHTML =
    `<strong> ${p.nombre}</strong><br>` +
    `Prestado: <strong>${fmt(p.monto)}</strong> · ` +
    `Total a cobrar: <strong>${fmt(p.totalConInteres)}</strong> · ` +
    `Por cobrar: <strong style="color:var(--red)">${fmt(falta)}</strong>`;
  const sel = document.getElementById('map-billetera');
  sel.innerHTML = '<option value="">— Selecciona billetera —</option>';
  (STATE.db.billeteras||[]).forEach(b => {
    const saldo = saldoBilletera(b.id);
    const alcanza = true; // no bloqueamos, solo informamos
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldo);
    sel.appendChild(o);
  });
  openModal('modal-ampliar-prestamo');
}

async function confirmarAmpliarPrestamo() {
  const idx         = Number(document.getElementById('map-idx').value);
  const monto       = Number(document.getElementById('map-monto').value);
  const fecha       = document.getElementById('map-fecha').value;
  const desc        = document.getElementById('map-desc').value.trim();
  const billeteraId = document.getElementById('map-billetera').value;
  const p           = STATE.db.prestamos[idx];

  if (!p)     return toast('Préstamo no encontrado', 'error');
  if (!monto || monto <= 0) return toast('El monto adicional debe ser mayor a 0', 'error');
  if (!fecha) return toast('La fecha es obligatoria', 'error');
  if (!desc)  return toast('El motivo / detalle es obligatorio', 'error');
  if (!billeteraId) return toast('Debes seleccionar de qué billetera sale el dinero', 'error');

  // Verificar saldo
  const saldo = saldoBilletera(billeteraId);
  if (saldo < monto) {
    const bill = STATE.db.billeteras.find(b => b.id === billeteraId);
    return toast(`Saldo insuficiente en ${bill?.nombre || 'la billetera'} (${fmt(saldo)})`, 'error');
  }

  // Registrar el desembolso adicional en el historial del préstamo
  if (!p.desembolsos) p.desembolsos = [];
  const desId = uid();
  p.desembolsos.push({ id: desId, fecha, monto, desc, billeteraId });

  // Aumentar el monto y recalcular totalConInteres
  p.monto += monto;
  p.totalConInteres = p.interes > 0 ? Math.round(p.monto * (1 + p.interes / 100)) : p.monto;

  // Registrar como gasto en la billetera
  const billNombre = STATE.db.billeteras.find(b => b.id === billeteraId)?.nombre || '';
  registrarGastoConGMF({
    id: uid(), fecha, hora: horaActual(), monto,
    desc: 'Préstamo adicional a: ' + p.nombre + ' — ' + desc,
    cat: 'Préstamo otorgado',
    billeteraId,
    autoGenerado: true,
    origenDesembolsoId: desId
  });

  closeModal('modal-ampliar-prestamo');
  renderAll();
  await saveDb(['prestamos', 'gastos']);
  toast(`${fmt(monto)} desembolsados a ${p.nombre} y descontados de ${billNombre} `, 'success');
}

function diasParaVencer(fechaStr) {
  if (!fechaStr) return null;
  const hoy   = new Date(); hoy.setHours(0,0,0,0);
  const vence = new Date(fechaStr + 'T00:00:00');
  return Math.round((vence - hoy) / (1000 * 60 * 60 * 24));
}

function renderPrestamos() {
  const container = document.getElementById('prestamos-lista');
  const empty     = document.getElementById('prestamos-empty');
  const list      = STATE.db.prestamos;

  const totalPrestado  = list.reduce((a, p) => a + p.totalConInteres, 0);
  const totalCobrado   = list.reduce((a, p) => a + (p.cobrado || 0), 0);
  const totalPendiente = totalPrestado - totalCobrado;
  const vencidos       = list.filter(p => {
    const dias = diasParaVencer(p.vence);
    return dias !== null && dias < 0 && p.cobrado < p.totalConInteres;
  }).length;

  document.getElementById('prest-total-val').textContent     = fmt(totalPrestado);
  document.getElementById('prest-cobrado-val').textContent   = fmt(totalCobrado);
  document.getElementById('prest-pendiente-val').textContent = fmt(totalPendiente);
  document.getElementById('prest-total-sub').textContent     = list.length + ' préstamos';
  document.getElementById('prest-vencidos-sub').textContent  = vencidos > 0 ? vencidos + ' vencidos' : '';

  // ── Tabs filtro pendientes / cobrados ──
  if (!document.getElementById('prest-filter-tabs')) {
    const tabs = document.createElement('div');
    tabs.id = 'prest-filter-tabs';
    tabs.style.cssText = 'display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;';
    tabs.innerHTML = `
      <button id="prest-tab-pend" class="btn btn-primary btn-sm" onclick="setPrestamosTab('pendientes')">Pendientes</button>
      <button id="prest-tab-cob"  class="btn btn-ghost btn-sm"   onclick="setPrestamosTab('cobrados')">Saldados / Cobrados</button>
      <span id="prest-tab-lbl" style="font-size:.8rem;color:var(--muted);margin-left:4px;"></span>`;
    container.parentNode.insertBefore(tabs, container);
  }

  const tab        = window._prestamosTab || 'pendientes';
  const pendientes = list.filter(p => Math.max(0, p.totalConInteres - (p.cobrado||0)) > 0);
  const cobrados   = list.filter(p => Math.max(0, p.totalConInteres - (p.cobrado||0)) === 0);
  const lista      = tab === 'cobrados' ? cobrados : pendientes;

  const tPend = document.getElementById('prest-tab-pend');
  const tCob  = document.getElementById('prest-tab-cob');
  const tLbl  = document.getElementById('prest-tab-lbl');
  if (tPend) tPend.className = tab === 'pendientes' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  if (tCob)  tCob.className  = tab === 'cobrados'   ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  if (tLbl)  tLbl.textContent = `${pendientes.length} pendiente${pendientes.length!==1?'s':''} · ${cobrados.length} saldado${cobrados.length!==1?'s':''}`;

  if (!lista.length) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  // Search filter
  const qp = (document.getElementById('prestamos-search')?.value || '').toLowerCase().trim();
  const listaFiltrada = qp ? lista.filter(p => p.nombre?.toLowerCase().includes(qp)) : lista;

  if (!listaFiltrada.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:.85rem;padding:16px 0;">No se encontraron préstamos.</p>';
    return;
  }

  container.innerHTML = listaFiltrada.map((p) => {
    const i       = STATE.db.prestamos.indexOf(p);
    const falta   = Math.max(0, p.totalConInteres - (p.cobrado || 0));
    const pct     = Math.min(100, Math.round((p.cobrado || 0) / p.totalConInteres * 100));
    const saldado = falta === 0;
    const dias    = diasParaVencer(p.vence);
    const expandId = `prest-expand-${i}`;

    let diasBadge = '';
    if (p.vence && !saldado) {
      if (dias < 0)       diasBadge = `<span class="badge badge-red" style="font-size:.7rem;">Vencido hace ${Math.abs(dias)}d</span>`;
      else if (dias <= 7) diasBadge = `<span class="badge" style="background:var(--yellow-light);color:var(--yellow);font-size:.7rem;">Vence en ${dias}d</span>`;
    }

    return `
    <div class="debt-card" style="padding:0;overflow:hidden;">
      <div onclick="toggleDeudaExpand('${expandId}')" style="display:flex;align-items:center;gap:14px;padding:16px 18px;cursor:pointer;user-select:none;">
        <div style="position:relative;width:44px;height:44px;flex-shrink:0;">
          <svg width="44" height="44" viewBox="0 0 44 44">
            <circle cx="22" cy="22" r="18" fill="none" stroke="var(--border)" stroke-width="3"/>
            <circle cx="22" cy="22" r="18" fill="none"
              stroke="${saldado ? 'var(--green)' : pct > 60 ? 'var(--yellow)' : 'var(--accent)'}"
              stroke-width="3" stroke-linecap="round"
              stroke-dasharray="${(2*Math.PI*18).toFixed(1)}"
              stroke-dashoffset="${((1 - pct/100) * 2*Math.PI*18).toFixed(1)}"
              transform="rotate(-90 22 22)"/>
          </svg>
          <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:var(--text);">${pct}%</span>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:.95rem;color:var(--text);">${p.nombre}</div>
          <div style="font-size:.75rem;color:var(--muted);margin-top:2px;">${formatFechaLarga(p.fecha)}${p.contacto ? ' · ' + p.contacto : ''}</div>
          ${diasBadge}
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-weight:700;font-size:1rem;color:${saldado?'var(--green)':'var(--red)'};">${fmt(falta)}</div>
          <div style="font-size:.7rem;color:var(--muted);">por cobrar</div>
        </div>
        <span class="badge ${saldado ? 'badge-green' : 'badge-red'}" style="flex-shrink:0;">${saldado ? '✓' : 'Pendiente'}</span>
        <svg id="${expandId}-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.5" style="flex-shrink:0;transition:transform .25s;"><polyline points="6 9 12 15 18 9"/></svg>
      </div>

      <div id="${expandId}" style="display:none;border-top:1px solid var(--border);">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-bottom:1px solid var(--border);">
          <div style="padding:12px 16px;border-right:1px solid var(--border);">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Prestado</div>
            <div style="font-weight:700;font-size:.95rem;">${fmt(p.monto)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border);">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">Cobrado</div>
            <div style="font-weight:700;font-size:.95rem;color:var(--green);">${fmt(p.cobrado||0)}</div>
          </div>
          <div style="padding:12px 16px;">
            <div style="font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px;">${p.interes>0?'Con interés ('+p.interes+'%)':'Interés'}</div>
            <div style="font-weight:700;font-size:.95rem;color:${p.interes>0?'var(--yellow)':'var(--text)'};">${p.interes>0?fmt(p.totalConInteres):'—'}</div>
          </div>
        </div>
        ${p.vence ? `
        <div style="padding:10px 16px;border-bottom:1px solid var(--border);font-size:.82rem;color:var(--muted);">
          <span>Fecha de cobro: </span><strong style="color:${dias!==null&&dias<0&&!saldado?'var(--red)':'var(--text)'};">${formatFechaLarga(p.vence)}</strong>
        </div>` : ''}
        ${p.desc ? `<div style="padding:10px 16px;border-bottom:1px solid var(--border);font-size:.82rem;color:var(--muted);">${p.desc}</div>` : ''}

        <div style="display:flex;gap:8px;padding:14px 16px;flex-wrap:wrap;border-bottom:1px solid var(--border);">
          ${!saldado ? `<button class="btn btn-success btn-sm" onclick="openCobro(${i})">+ Registrar cobro</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="openAmpliarPrestamo(${i})">Prestar más</button>
          <button class="btn btn-danger btn-sm" onclick="deletePrestamo(${i})">Eliminar</button>
        </div>

        ${p.cobros.length ? `
        <div style="padding:14px 16px;">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:10px;">Historial de cobros (${p.cobros.length})</div>
          ${p.cobros.slice().reverse().map(c => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light);">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;"></div>
              <div style="flex:1;">
                <div style="font-size:.83rem;font-weight:600;">${formatFechaLarga(c.fecha)}</div>
                ${c.nota?`<div style="font-size:.73rem;color:var(--muted);">${c.nota}</div>`:''}
              </div>
              <span style="font-weight:700;color:var(--green);font-size:.9rem;">${fmt(c.monto)}</span>
              <button onclick="deleteCobro(${i},'${c.id}')" style="background:none;border:none;cursor:pointer;color:var(--light);padding:2px 5px;font-size:.8rem;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--light)'">✕</button>
            </div>`).join('')}
        </div>` : ''}

        ${(p.desembolsos&&p.desembolsos.length) ? `
        <div style="padding:14px 16px;border-top:1px solid var(--border);">
          <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:10px;">Desembolsos adicionales (${p.desembolsos.length})</div>
          ${p.desembolsos.slice().reverse().map(des => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border-light);">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0;"></div>
              <div style="flex:1;">
                <div style="font-size:.83rem;font-weight:600;">${formatFechaLarga(des.fecha)}</div>
                ${des.desc?`<div style="font-size:.73rem;color:var(--muted);">${des.desc}</div>`:''}
              </div>
              <span style="font-weight:700;color:var(--accent);font-size:.9rem;">+${fmt(des.monto)}</span>
            </div>`).join('')}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
  populateBilleteraSelects();
}

function setPrestamosTab(tab) {
  window._prestamosTab = tab;
  renderPrestamos();
}

/* ============================================================
   GASTOS FIJOS MENSUALES
   ============================================================ */

// Poblar selector de deudas en el formulario de gasto fijo
function populateGFDeudaSelect(selId, currentDeudaId = '') {
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option value="">— Sin vincular —</option>';
  (STATE.db.deudas || [])
    .filter(d => Math.max(0, d.total - (d.pagado || 0)) > 0) // solo deudas activas
    .forEach(d => {
      const falta = Math.max(0, d.total - (d.pagado || 0));
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.nombre} — pendiente: ${fmt(falta)}`;
      if (d.id === currentDeudaId) o.selected = true;
      sel.appendChild(o);
    });
}

async function saveGastoFijo() {
  const nombre      = document.getElementById('gf-nombre').value.trim();
  const monto       = Number(document.getElementById('gf-monto').value);
  const cat         = document.getElementById('gf-cat').value;
  const dia         = Number(document.getElementById('gf-dia').value) || 0;
  const notas       = document.getElementById('gf-notas').value.trim();
  const billeteraId = document.getElementById('gf-billetera')?.value || '';
  const deudaId     = document.getElementById('gf-deuda-vinc')?.value || '';

  if (!nombre) return toast('El nombre es obligatorio', 'error');
  if (!monto)  return toast('El valor es obligatorio', 'error');

  STATE.db.gastosFijos.push({ id: uid(), nombre, monto, cat, dia, notas, billeteraId, deudaId, pagos: {} });
  clearForm(['gf-nombre','gf-monto','gf-dia','gf-notas']);
  document.getElementById('gf-deuda-vinc').value = '';
  closeModal('modal-nuevo-gasto-fijo');
  renderGastosFijos();
  await saveDb(['gastosFijos']);
  const vincMsg = deudaId ? ' — vinculado a deuda' : '';
  toast('Gasto fijo agregado' + vincMsg, 'success');
}

async function deleteGastoFijo(id) {
  pedirPinParaAccion('Eliminar gasto fijo', async () => {
    STATE.db.gastosFijos = STATE.db.gastosFijos.filter(g => g.id !== id);
    renderGastosFijos();
    await saveDb(['gastosFijos']);
    toast('Gasto fijo eliminado', 'info');
  });
}

function openEditGastoFijo(id) {
  const gf = STATE.db.gastosFijos.find(g => g.id === id);
  if (!gf) return;

  let modal = document.getElementById('modal-edit-gasto-fijo');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-edit-gasto-fijo';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <div class="modal-title">Editar gasto fijo</div>
        <div class="form-grid">
          <div class="form-group">
            <label>Nombre *</label>
            <input type="text" class="form-control" id="mgf-nombre" placeholder="Nombre...">
          </div>
          <div class="form-group">
            <label>Monto mensual *</label>
            <input type="number" class="form-control" id="mgf-monto" placeholder="0" min="1">
          </div>
          <div class="form-group">
            <label>Categoría</label>
            <select class="form-control" id="mgf-cat">
              <option value="Arriendo"> Arriendo</option>
              <option value="Servicios"> Servicios</option>
              <option value="Internet"> Internet</option>
              <option value="Suscripción"> Suscripción</option>
              <option value="Crédito"> Crédito</option>
              <option value="Seguro">️ Seguro</option>
              <option value="Educación"> Educación</option>
              <option value="Salud"> Salud</option>
              <option value="Otro"> Otro</option>
            </select>
          </div>
          <div class="form-group">
            <label>Día de pago (1-31)</label>
            <input type="number" class="form-control" id="mgf-dia" placeholder="Ej: 5" min="1" max="31">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label>Notas</label>
            <input type="text" class="form-control" id="mgf-notas" placeholder="Opcional...">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label>Vincular con deuda (opcional)</label>
            <select class="form-control" id="mgf-deuda-vinc">
              <option value="">— Sin vincular —</option>
            </select>
            <small style="color:var(--muted);font-size:.72rem">Al marcar como pagado se abonará automáticamente a la deuda seleccionada</small>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="closeModal('modal-edit-gasto-fijo')">Cancelar</button>
          <button class="btn btn-primary" onclick="saveEditGastoFijo()">Guardar cambios</button>
        </div>
        <input type="hidden" id="mgf-id">
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }

  document.getElementById('mgf-id').value     = id;
  document.getElementById('mgf-nombre').value = gf.nombre || '';
  document.getElementById('mgf-monto').value  = gf.monto || '';
  document.getElementById('mgf-cat').value    = gf.cat || 'Otro';
  document.getElementById('mgf-dia').value    = gf.dia || '';
  document.getElementById('mgf-notas').value  = gf.notas || '';
  // Poblar selector de deudas
  populateGFDeudaSelect('mgf-deuda-vinc', gf.deudaId || '');
  openModal('modal-edit-gasto-fijo');
}

async function saveEditGastoFijo() {
  const id      = document.getElementById('mgf-id').value;
  const nombre  = document.getElementById('mgf-nombre').value.trim();
  const monto   = Number(document.getElementById('mgf-monto').value);
  const cat     = document.getElementById('mgf-cat').value;
  const dia     = Number(document.getElementById('mgf-dia').value) || 0;
  const notas   = document.getElementById('mgf-notas').value.trim();
  const deudaId = document.getElementById('mgf-deuda-vinc')?.value || '';

  if (!nombre) return toast('El nombre es obligatorio', 'error');
  if (!monto)  return toast('El monto es obligatorio', 'error');

  const gf = STATE.db.gastosFijos.find(g => g.id === id);
  if (!gf) return toast('Gasto fijo no encontrado', 'error');

  gf.nombre  = nombre;
  gf.monto   = monto;
  gf.cat     = cat;
  gf.dia     = dia;
  gf.notas   = notas;
  gf.deudaId = deudaId;

  closeModal('modal-edit-gasto-fijo');
  renderGastosFijos();
  await saveDb(['gastosFijos']);
  const vincMsg = deudaId ? ' — deuda vinculada →' : '';
  toast('Gasto fijo actualizado ' + vincMsg, 'success');
}

async function togglePagoGF(id) {
  const mesKey = document.getElementById('gf-mes-sel').value || currentYM();
  const gf     = STATE.db.gastosFijos.find(g => g.id === id);
  if (!gf) return;
  if (!gf.pagos) gf.pagos = {};

  const pagoData     = gf.pagos[mesKey];
  const estabaPagado = pagoData === true || (pagoData && pagoData.pagado);

  if (!estabaPagado) {
    // Marcar como pagado — abrir mini-modal para seleccionar billetera
    openModalPagoFijo(id, mesKey);
  } else {
    // ── Desmarcar: eliminar gasto, reintegrar dinero y revertir abono en deuda ──
    const deudaNombre = gf.deudaId
      ? (STATE.db.deudas.find(d => d.id === gf.deudaId)?.nombre || 'deuda vinculada')
      : null;
    const extraMsg = deudaNombre ? `\nTambién se revertirá el abono en "${deudaNombre}".` : '';

    const confirmed = await new Promise(resolve => {
      let m = document.getElementById('modal-desmarcar-gf');
      if (!m) {
        m = document.createElement('div');
        m.id = 'modal-desmarcar-gf';
        m.className = 'modal-overlay';
        m.innerHTML = `
          <div class="modal" style="max-width:400px;width:100%;">
            <div class="modal-title" style="display:flex;align-items:center;gap:10px;padding:20px 24px;">
              <div style="width:36px;height:36px;background:#b45309;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <div>
                <div style="font-size:1rem;font-weight:700;color:var(--text);">Desmarcar pago</div>
                <div style="font-size:.75rem;color:var(--muted);" id="dgf-sub"></div>
              </div>
              <button onclick="document.getElementById('modal-desmarcar-gf').classList.remove('open');window._dgfResolve&&window._dgfResolve(false);" style="margin-left:auto;background:none;border:none;font-size:1.2rem;color:var(--muted);cursor:pointer;">&#x2715;</button>
            </div>
            <div class="modal-body-wrap" style="padding:16px 24px;">
              <p style="font-size:.88rem;color:var(--muted);line-height:1.6;" id="dgf-msg"></p>
            </div>
            <div class="modal-actions" style="padding:16px 24px;gap:10px;">
              <button class="btn btn-ghost" onclick="document.getElementById('modal-desmarcar-gf').classList.remove('open');window._dgfResolve&&window._dgfResolve(false);" style="flex:1;">Cancelar</button>
              <button onclick="document.getElementById('modal-desmarcar-gf').classList.remove('open');window._dgfResolve&&window._dgfResolve(true);" style="flex:2;background:#b45309;color:#fff;border:none;border-radius:var(--radius-sm);padding:12px;font-size:.92rem;font-weight:700;cursor:pointer;">Desmarcar</button>
            </div>
          </div>`;
        document.body.appendChild(m);
      }
      document.getElementById('dgf-sub').textContent = gf.nombre + '  ·  ' + fmt(gf.monto);
      document.getElementById('dgf-msg').textContent = 'Se eliminará el gasto registrado y se reintegrarán ' + fmt(gf.monto) + ' a la billetera.' + (extraMsg ? ' ' + extraMsg : '');
      window._dgfResolve = resolve;
      m.classList.add('open');
    });
    if (!confirmed) return;

    // 1. Buscar el gasto auto-generado (3 estrategias en orden de precisión)
    let gastoIdx = -1;
    if (pagoData?.gastoId) {
      gastoIdx = STATE.db.gastos.findIndex(g => g.id === pagoData.gastoId);
    }
    if (gastoIdx === -1) {
      gastoIdx = STATE.db.gastos.findIndex(g =>
        g.gastoFijoId === gf.id && g.gastoFijoMes === mesKey
      );
    }
    if (gastoIdx === -1) {
      const fechaPago = typeof pagoData === 'object' ? pagoData.fecha : null;
      const billPago  = typeof pagoData === 'object' ? pagoData.billeteraId : null;
      gastoIdx = STATE.db.gastos.findIndex(g =>
        g.autoGenerado &&
        g.desc === ('Gasto fijo: ' + gf.nombre) &&
        (!fechaPago || g.fecha === fechaPago) &&
        (!billPago  || g.billeteraId === billPago)
      );
    }
    if (gastoIdx !== -1) STATE.db.gastos.splice(gastoIdx, 1);

    // 2. Revertir abono en deuda vinculada (si existía)
    let revertioAbono = false;
    if (pagoData?.abonoDeudaId && pagoData?.deudaId) {
      const deuda = STATE.db.deudas.find(d => d.id === pagoData.deudaId);
      if (deuda && deuda.pagos) {
        const abonoIdx = deuda.pagos.findIndex(p => p.id === pagoData.abonoDeudaId);
        if (abonoIdx !== -1) {
          deuda.pagado = Math.max(0, (deuda.pagado || 0) - deuda.pagos[abonoIdx].monto);
          deuda.pagos.splice(abonoIdx, 1);
          revertioAbono = true;
        }
      }
    }

    // 3. Resetear estado del pago
    gf.pagos[mesKey] = false;

    renderAll();
    await saveDb(['gastosFijos', 'gastos', 'deudas']);

    let msg = gastoIdx !== -1
      ? `↩️ Marcado como pendiente — ${fmt(gf.monto)} reintegrados`
      : '↩️ Marcado como pendiente';
    if (revertioAbono) msg += ' · abono en deuda revertido';
    toast(msg, 'info');
  }
}

function openModalPagoFijo(gfId, mesKey) {
  const gf = STATE.db.gastosFijos.find(g => g.id === gfId);
  if (!gf) return;
  const billeteras = STATE.db.billeteras || [];

  let modal = document.getElementById('modal-pago-fijo-billetera');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-pago-fijo-billetera';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal" style="max-width:420px;width:100%;">
        <div class="modal-title" style="display:flex;align-items:center;gap:10px;padding:20px 24px;">
          <div style="width:36px;height:36px;background:#0f2d6b;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          </div>
          <div>
            <div style="font-size:1rem;font-weight:700;color:var(--text);">Registrar pago</div>
            <div style="font-size:.75rem;color:var(--muted);" id="mpf-desc"></div>
          </div>
          <button onclick="closeModal('modal-pago-fijo-billetera')" style="margin-left:auto;background:none;border:none;font-size:1.2rem;color:var(--muted);cursor:pointer;">✕</button>
        </div>
        <div class="modal-body-wrap" style="padding:20px 24px;">
          <div class="form-group">
            <label>Sale de billetera *</label>
            <select class="form-control" id="mpf-billetera" style="height:44px;">
              <option value="">— Selecciona billetera —</option>
            </select>
            <div id="mpf-saldo-info" style="display:none;margin-top:6px;padding:8px 12px;background:var(--bg2);border-radius:var(--radius-sm);font-size:.82rem;display:flex;align-items:center;justify-content:space-between;"></div>
            <div id="mpf-aviso" style="display:none;margin-top:6px;font-size:.8rem;color:var(--red);font-weight:600;"></div>
          </div>
        </div>
        <div class="modal-actions" style="padding:16px 24px;gap:10px;">
          <button class="btn btn-ghost" onclick="closeModal('modal-pago-fijo-billetera')" style="flex:1;">Cancelar</button>
          <button id="mpf-confirmar" style="flex:2;background:#0f2d6b;color:#fff;border:none;border-radius:var(--radius-sm);padding:12px;font-size:.92rem;font-weight:700;cursor:pointer;">Confirmar pago</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }

  // Poblar datos
  document.getElementById('mpf-desc').textContent =
    `${gf.nombre}  ·  ${fmt(gf.monto)}`;
  const sel = document.getElementById('mpf-billetera');
  sel.innerHTML = '<option value="">— Selecciona billetera (obligatorio) —</option>';

  let hayAlguna = false;
  billeteras.forEach(b => {
    const saldo = saldoBilletera(b.id);
    const alcanza = saldo >= gf.monto;
    const o = document.createElement('option');
    o.value = b.id;
    o.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre +
      ' — ' + fmt(saldo) + (alcanza ? '' : ' saldo insuficiente');
    o.disabled = !alcanza;
    if (!alcanza) o.style.color = 'var(--red)';
    if (gf.billeteraId === b.id && alcanza) o.selected = true;
    sel.appendChild(o);
    if (alcanza) hayAlguna = true;
  });

  // Aviso si ninguna billetera alcanza
  const avisoEl = document.getElementById('mpf-aviso');
  if (avisoEl) {
    if (!hayAlguna) {
      avisoEl.style.display = '';
      avisoEl.textContent = 'Ninguna billetera tiene saldo suficiente para cubrir ' + fmt(gf.monto);
    } else {
      avisoEl.style.display = 'none';
    }
  }
  sel.style.border = '';

  // Asignar handler al botón confirmar
  const btn = document.getElementById('mpf-confirmar');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', async () => {
    const billeteraUsada = document.getElementById('mpf-billetera').value;
    if (!billeteraUsada) {
      const s = document.getElementById('mpf-billetera');
      s.style.border = '2px solid var(--red)';
      setTimeout(() => s.style.border = '', 2000);
      return toast('Debes seleccionar de qué billetera sale el dinero', 'error');
    }
    closeModal('modal-pago-fijo-billetera');
    await confirmarPagoFijo(gfId, mesKey, billeteraUsada);
  });

  openModal('modal-pago-fijo-billetera');
}

async function confirmarPagoFijo(gfId, mesKey, billeteraUsada) {
  const gf = STATE.db.gastosFijos.find(g => g.id === gfId);
  if (!gf) return;
  if (!gf.pagos) gf.pagos = {};

  // Validar saldo suficiente
  const saldo = saldoBilletera(billeteraUsada);
  if (saldo < gf.monto) {
    return toast(`Saldo insuficiente. Disponible: ${fmt(saldo)} — Necesario: ${fmt(gf.monto)}`, 'error');
  }

  const now   = new Date();
  const fecha = now.toISOString().slice(0,10);
  const hora  = horaActual();

  const gastoId = uid();
  gf.pagos[mesKey] = { pagado: true, fecha, hora, billeteraId: billeteraUsada, gastoId };

  const billObj = STATE.db.billeteras?.find(b => b.id === billeteraUsada);

  // ── Registrar gasto (descuenta de billetera) ──
  registrarGastoConGMF({
    id: gastoId, fecha, hora,
    monto: gf.monto,
    desc: 'Gasto fijo: ' + gf.nombre,
    cat: gf.cat || 'Servicios',
    billeteraId: billeteraUsada,
    autoGenerado: true,
    gastoFijoId: gf.id,
    gastoFijoMes: mesKey
  });

  // ── Si está vinculado a una deuda, registrar abono automático ──
  let mensajeDeuda = '';
  if (gf.deudaId) {
    const deuda = STATE.db.deudas.find(d => d.id === gf.deudaId);
    if (deuda) {
      const falta = Math.max(0, deuda.total - (deuda.pagado || 0));
      if (falta > 0) {
        const montoAbono = Math.min(gf.monto, falta); // no abonar más de lo que falta
        const abonoId    = uid();
        deuda.pagado = (deuda.pagado || 0) + montoAbono;
        if (!deuda.pagos) deuda.pagos = [];
        deuda.pagos.push({
          id: abonoId,
          fecha,
          monto: montoAbono,
          nota: `Abono automático desde gasto fijo: ${gf.nombre}`,
          autoGastoFijoId: gf.id,
          autoGastoFijoMes: mesKey
        });
        // Guardar referencia del abono en el registro del pago
        gf.pagos[mesKey].abonoDeudaId = abonoId;
        gf.pagos[mesKey].deudaId      = gf.deudaId;
        mensajeDeuda = ` ·  Abono de ${fmt(montoAbono)} aplicado a "${deuda.nombre}"`;
      } else {
        mensajeDeuda = ` · La deuda "${deuda.nombre}" ya estaba saldada`;
      }
    }
  }

  renderAll();
  await saveDb(['gastosFijos', 'gastos', 'deudas']);
  const dest = billObj ? ` (de ${billObj.nombre})` : '';
  toast(`Pagado${dest} — ${fmt(gf.monto)}${mensajeDeuda}`, 'success');
}

function autoResetGFIfNeeded() {
  // Reiniciar pagos automáticamente el 1ro de cada mes
  const hoy = new Date();
  if (hoy.getDate() !== 1) return; // solo el día 1
  const mesKey = currentYM();
  const lastReset = localStorage.getItem('gf_last_reset');
  if (lastReset === mesKey) return; // ya se reinició este mes
  // Marcar todos como pendientes para este mes (no borrar historial)
  // Los pagos de meses anteriores se conservan — solo no pre-marcar este mes
  localStorage.setItem('gf_last_reset', mesKey);
  console.log('Auto-reset gastos fijos para', mesKey);
}

async function resetPagosGF() {
  const mesKey = document.getElementById('gf-mes-sel').value || currentYM();
  if (!confirm(`¿Reiniciar todos los pagos de ${monthLabel(mesKey)}?`)) return;
  STATE.db.gastosFijos.forEach(g => {
    if (!g.pagos) g.pagos = {};
    g.pagos[mesKey] = false;
  });
  renderGastosFijos();
  await saveDb(['gastosFijos']);
  toast('Pagos reiniciados para el mes', 'info');
}

function populateGFMesSel() {
  const sel   = document.getElementById('gf-mes-sel');
  const cur   = sel.value || currentYM();
  const now   = new Date();
  sel.innerHTML = '';
  // Show 6 months back + 3 forward
  for (let i = -6; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const v = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = monthLabel(v);
    if (v === cur) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderGastosFijos() {
  populateGFMesSel();
  // Poblar selector de deuda en el formulario de nuevo gasto fijo
  populateGFDeudaSelect('gf-deuda-vinc', '');

  const mesKey  = document.getElementById('gf-mes-sel').value || currentYM();
  const list    = STATE.db.gastosFijos;
  const grid    = document.getElementById('gf-grid');
  const empty   = document.getElementById('gf-empty');
  const resumen = document.getElementById('gf-resumen');

  const totalMes    = list.reduce((a, g) => a + g.monto, 0);
  const pagados     = list.filter(g => { const p = g.pagos && g.pagos[mesKey]; return p === true || (p && p.pagado); });
  const pendientes  = list.filter(g => { const p = g.pagos && g.pagos[mesKey]; return !p || (p && !p.pagado); });
  const totalPagado = pagados.reduce((a, g) => a + g.monto, 0);
  const totalPend   = pendientes.reduce((a, g) => a + g.monto, 0);
  const pct         = totalMes > 0 ? Math.round(totalPagado / totalMes * 100) : 0;
  const mes         = monthLabel(mesKey);

  const color = pct===100?'var(--green)':pct>50?'var(--yellow)':'var(--accent)';
  const gfStatsVisible = localStorage.getItem('gf_stats_visible') !== 'false';
  resumen.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;flex-wrap:wrap;">
      <!-- Conteo siempre visible -->
      <span style="font-size:.82rem;font-weight:600;color:var(--muted);white-space:nowrap;flex-shrink:0;">${pagados.length}/${list.length}</span>
      <!-- Stats ocultables -->
      <div id="gf-stats-nums" style="display:${gfStatsVisible?'flex':'none'};align-items:center;gap:8px;flex-wrap:nowrap;min-width:0;">
        <span style="color:var(--border);">·</span>
        <span style="font-size:.92rem;font-weight:700;color:var(--green);white-space:nowrap;">${fmt(totalPagado)}</span>
        <span style="color:var(--border);">·</span>
        <span style="font-size:.92rem;font-weight:700;color:${totalPend>0?'var(--red)':'var(--green)'};white-space:nowrap;">${fmt(totalPend)}</span>
      </div>
      <!-- Barra progreso -->
      <div class="progress-bar" style="flex:1;height:6px;border-radius:10px;min-width:40px;max-width:140px;flex-shrink:1;">
        <div class="progress-fill" style="width:${pct}%;background:${color};border-radius:10px;transition:width .4s ease;"></div>
      </div>
      <span style="font-size:.78rem;color:var(--muted);flex-shrink:0;">${pct}%</span>
      <!-- Botón ojo -->
      <button onclick="toggleGFStats()" title="${gfStatsVisible?'Ocultar montos':'Mostrar montos'}" style="background:none;border:none;cursor:pointer;color:var(--muted);padding:2px 4px;flex-shrink:0;display:flex;align-items:center;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--muted)'">
        ${gfStatsVisible
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
        }
      </button>
    </div>`;

  if (!list.length) {
    grid.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  const CAT_ICONS = {
    'Arriendo':'','Servicios':'','Internet':'','Suscripción':'',
    'Crédito':'','Seguro':'️','Educación':'','Salud':'','Otro':''
  };

  // Sort: pending first, then by dia
  const sorted = list.slice().sort((a, b) => {
    const pA = a.pagos && a.pagos[mesKey] ? 1 : 0;
    const pB = b.pagos && b.pagos[mesKey] ? 1 : 0;
    if (pA !== pB) return pA - pB;
    return (a.dia||99) - (b.dia||99);
  });

  grid.innerHTML = sorted.map(g => {
    const _pval = g.pagos && g.pagos[mesKey];
    const pagado = _pval === true || (_pval && _pval.pagado);
    const pagadoFecha = (_pval && _pval.fecha) ? _pval.fecha : '';
    const now = new Date();
    const diasMes = g.dia > 0 ? g.dia - now.getDate() : null;
    let diasBadge = '';
    if (!pagado && diasMes !== null) {
      if (diasMes < 0)       diasBadge = `<span class="badge badge-red" style="font-size:.7rem;">Venció hace ${Math.abs(diasMes)}d</span>`;
      else if (diasMes === 0) diasBadge = `<span class="badge" style="background:var(--yellow-light);color:var(--yellow);font-size:.7rem;">Vence hoy</span>`;
      else if (diasMes <= 5)  diasBadge = `<span class="badge" style="background:var(--yellow-light);color:var(--yellow);font-size:.7rem;">Vence en ${diasMes}d</span>`;
      else                    diasBadge = `<span style="font-size:.72rem;color:var(--muted);">Día ${g.dia}</span>`;
    }
    const deudaVinc = g.deudaId ? STATE.db.deudas.find(d => d.id === g.deudaId) : null;

    return `
    <div style="background:var(--card);border:1px solid ${pagado?'var(--border)':'var(--border)'};border-left:3px solid ${pagado?'var(--green)':'var(--red)'};border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px;${pagado?'opacity:.7;':''}">
      <!-- Fila 1: nombre + meta -->
      <div style="margin-bottom:8px;">
        <div style="font-weight:700;font-size:.93rem;color:var(--text);">${g.nombre}</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;">
          <span style="font-size:.72rem;color:var(--muted);">${g.cat}${g.notas?' · '+g.notas:''}</span>
          ${diasBadge}
          ${deudaVinc?`<span class="badge badge-blue" style="font-size:.68rem;">→ ${deudaVinc.nombre}</span>`:''}
        </div>
        ${pagadoFecha?`<div style="font-size:.7rem;color:var(--muted);margin-top:2px;">Pagado: ${formatFechaLarga(pagadoFecha)}</div>`:''}
      </div>
      <!-- Fila 2: monto + botones -->
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="font-weight:800;font-size:1.05rem;color:${pagado?'var(--green)':'var(--text)'};flex:1;">${fmt(g.monto)}</div>
        <button onclick="togglePagoGF('${g.id}')" style="height:32px;padding:0 14px;border:none;border-radius:7px;background:${pagado?'var(--bg2)':'#0f2d6b'};color:${pagado?'var(--muted)':'#fff'};font-size:.75rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;">
          ${pagado ? 'Desmarcar' : 'Pagar'}
        </button>
        <button onclick="openEditGastoFijo('${g.id}')" style="height:32px;width:32px;border:1px solid var(--border);border-radius:7px;background:none;cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button onclick="deleteGastoFijo('${g.id}')" style="height:32px;width:32px;border:1px solid var(--border);border-radius:7px;background:none;cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');
}

/* ============================================================
   INVERSIONES — Centris Style (tabla + modal + detalle)
   ============================================================ */

// ─── Formatters ──────────────────────────────────────────────
const fmtCOP = n => '$' + Number(n||0).toLocaleString('es-CO',{minimumFractionDigits:0,maximumFractionDigits:0});
const fmtNum = n => Number(n||0).toLocaleString('es-CO');

// ─── Storage helpers ─────────────────────────────────────────
function getInversiones()     { return STATE.db.inversiones || []; }
function getVentasInv(id)     { return (STATE.db.ventasInv||[]).filter(v=>v.invId===id); }
function saveVentasInv(arr)   { STATE.db.ventasInv = arr; saveDb(); }
function addVentaInv(v)       { if(!STATE.db.ventasInv) STATE.db.ventasInv=[]; v.id=uid(); v.creadoEn=new Date().toISOString(); STATE.db.ventasInv.push(v); saveDb(); }
function deleteVentaInv(id)   { STATE.db.ventasInv=(STATE.db.ventasInv||[]).filter(v=>v.id!==id); saveDb(); }

// ─── Calculations ─────────────────────────────────────────────
function calcInversion(inv) {
  // Capital del pedido INICIAL únicamente (usando unidadesIniciales, no inv.unidades)
  const unidadesIniciales = Number(inv.unidadesIniciales || inv.unidades || 0);
  const capitalBase = Number(inv.precioUSD || 0) * unidadesIniciales * Number(inv.tasa || 0);
  const envioBase   = Number(inv.envioInicial !== undefined ? inv.envioInicial : inv.envio || 0);
  const otrosBase   = Number(inv.otrosCostosInicial !== undefined ? inv.otrosCostosInicial : inv.otrosCostos || 0);
  // Cada renovación ya guarda su propio costo total (inversionNueva)
  const capitalRenovaciones = (inv.renovaciones || []).reduce((s, r) => s + Number(r.inversionNueva || 0), 0);
  const totalGastosAdicionales = (inv.gastosAdicionales || []).reduce((s, g) => s + Number(g.monto || 0), 0);
  return capitalBase + envioBase + otrosBase + capitalRenovaciones + totalGastosAdicionales;
}

function enriquecerInversion(inv) {
  const ventas         = getVentasInv(inv.id);
  const inversionTotal = calcInversion(inv);
  const cantidad       = Number(inv.unidades||0);
  const costoUnitario  = cantidad > 0 ? inversionTotal / cantidad : 0;
  const unidadesVendidas = ventas.reduce((s,v)=>s+(v.cantidad||0), 0);
  const totalRecuperado  = ventas.reduce((s,v)=>s+((v.cantidad||0)*(v.precioUnitario||0)), 0);
  const stockActual    = cantidad - unidadesVendidas;
  const costoVendido   = costoUnitario * unidadesVendidas;
  const ganancia       = totalRecuperado - costoVendido;
  const recuperacionPct = inversionTotal > 0 ? (totalRecuperado/inversionTotal)*100 : 0;
  let estadoStock = 'ok';
  if (stockActual === 0) estadoStock = 'agotado';
  else if (cantidad > 0 && stockActual <= Math.ceil(cantidad*0.2)) estadoStock = 'bajo';
  return { ...inv, inversionTotal, costoUnitario, unidadesVendidas,
    totalRecuperado, stockActual, ganancia, recuperacionPct, estadoStock, ventas,
    gastosAdicionales: inv.gastosAdicionales || [],
    renovaciones: inv.renovaciones || [] };
}

function getResumenInversiones() {
  const lista = getInversiones().map(enriquecerInversion);
  return {
    totalInvertido:    lista.reduce((s,p)=>s+p.inversionTotal,0),
    totalRecuperado:   lista.reduce((s,p)=>s+p.totalRecuperado,0),
    gananciaTotal:     lista.reduce((s,p)=>s+p.ganancia,0),
    stockTotal:        lista.reduce((s,p)=>s+p.stockActual,0),
    vendidasTotal:     lista.reduce((s,p)=>s+p.unidadesVendidas,0),
    activas:           lista.filter(p=>p.estado==='activa').length,
    cerradas:          lista.filter(p=>p.estado==='cerrada').length,
    lista,
  };
}

// ─── Badge helpers ────────────────────────────────────────────
function invBadgeEstado(e) {
  const m = { activa:['badge-green','Activa'], cerrada:['badge-blue','Cerrada'],
               pausada:['badge-yellow','Pausada'] };
  const [cls,lbl] = m[e]||['badge-yellow',e];
  return `<span class="badge ${cls}">${lbl}</span>`;
}
function invBadgeStock(e) {
  const m = { ok:['badge-green','OK'], bajo:['badge-yellow','Stock bajo'], agotado:['badge-red','Agotado'] };
  const [cls,lbl] = m[e]||['badge-yellow',e];
  return `<span class="badge ${cls}">${lbl}</span>`;
}

// ─── Render principal ──────────────────────────────────────────
function renderInversiones() {
  populateInvTipoFilter();
  const r      = getResumenInversiones();
  const search = (document.getElementById('inv-search')?.value||'').toLowerCase();
  const fEst   = document.getElementById('inv-filter-estado')?.value||'';
  const fTipo  = document.getElementById('inv-filter-tipo')?.value||'';

  // KPIs
  const elCap = document.getElementById('inv-capital');
  const elVal = document.getElementById('inv-valor');
  const elGan = document.getElementById('inv-ganancia');
  const elAct = document.getElementById('inv-activas');
  const elSto = document.getElementById('inv-stock-total');
  const elVen = document.getElementById('inv-vendidas-total');
  if(elCap) elCap.textContent = fmtCOP(r.totalInvertido);
  if(elVal) elVal.textContent = fmtCOP(r.totalRecuperado);
  if(elGan) { elGan.textContent = fmtCOP(r.gananciaTotal); elGan.className='stat-value '+(r.gananciaTotal>=0?'positive':'negative'); }
  if(elAct) elAct.textContent = r.activas;
  if(elSto) elSto.textContent = fmtNum(r.stockTotal);
  if(elVen) elVen.textContent = fmtNum(r.vendidasTotal);
  const sub1=document.getElementById('inv-capital-sub'); if(sub1) sub1.textContent=r.lista.length+' inversiones';
  const sub2=document.getElementById('inv-ganancia-pct');
  if(sub2) { const p=r.totalInvertido>0?((r.gananciaTotal/r.totalInvertido)*100).toFixed(1):0; sub2.textContent=(r.gananciaTotal>=0?'↑ +':'↓ ')+p+'% rentabilidad'; }
  const sub3=document.getElementById('inv-cerradas-sub'); if(sub3) sub3.textContent=r.cerradas+' cerradas';

  // ── Tabs de navegación del módulo ──
  renderInvTabs();

  // Solo renderizar contenido de productos si ese tab está activo
  if ((window._invTab || 'productos') !== 'productos') return;

  // Asegurar que el contenedor del listado tenga ID correcto
  const listaCards = document.getElementById('inv-lista-cards');
  const empty = document.getElementById('inversiones-empty');

  // Filtrar
  let lista = r.lista.slice();
  if(search) lista = lista.filter(p=>(p.nombre||'').toLowerCase().includes(search)||(p.sku||'').toLowerCase().includes(search));
  if(fEst)   lista = lista.filter(p=>p.estado===fEst);
  if(fTipo)  lista = lista.filter(p=>p.tipo===fTipo);

  if(!lista.length) {
    if(listaCards) listaCards.innerHTML = '';
    if(empty) empty.style.display='';
    return;
  }
  if(empty) empty.style.display='none';

  if(listaCards) listaCards.innerHTML = lista.map(p => {
    const idx = STATE.db.inversiones.indexOf(STATE.db.inversiones.find(i=>i.id===p.id));
    const ganColor = p.ganancia>=0?'var(--green)':'var(--red)';
    const stockColor = p.estadoStock==='agotado'?'var(--red)':p.estadoStock==='bajo'?'var(--yellow)':'var(--text)';
    const letra = (p.nombre||'?')[0].toUpperCase();
    const avatar = p.imagen
      ? `<img src="${p.imagen}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:10px;flex-shrink:0;" onerror="this.style.display='none'">`
      : `<div style="width:44px;height:44px;border-radius:10px;background:var(--accent-light);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1rem;flex-shrink:0;">${letra}</div>`;
    return `
    <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 18px;margin-bottom:10px;">
      <!-- Cabecera -->
      <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px;">
        ${avatar}
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:.95rem;color:var(--text);">${p.nombre}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap;">
            ${p.sku?`<code style="font-size:.7rem;background:var(--bg2);border:1px solid var(--border);padding:1px 6px;border-radius:4px;color:var(--muted);">${p.sku}</code>`:''}
            <span style="font-size:.72rem;color:var(--muted);">${p.tipo||''}</span>
            ${invBadgeEstado(p.estado)}
          </div>
        </div>
        <!-- Acciones -->
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button onclick="openDetalleInv('${p.id}')" title="Ver detalle" style="width:30px;height:30px;border:1px solid var(--border);border-radius:7px;background:none;cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--muted)'">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button onclick="openModalNuevaInversion('${p.id}')" title="Editar" style="width:30px;height:30px;border:1px solid var(--border);border-radius:7px;background:none;cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--muted)'">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button onclick="deleteInversion(${idx})" title="Eliminar" style="width:30px;height:30px;border:1px solid var(--border);border-radius:7px;background:none;cursor:pointer;color:var(--muted);display:flex;align-items:center;justify-content:center;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--muted)'">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <!-- Stats en grid -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:12px;">
        <div style="padding:10px 12px;border-right:1px solid var(--border);">
          <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:3px;">Inversión</div>
          <div style="font-weight:700;font-size:.9rem;">${fmtCOP(p.inversionTotal)}</div>
        </div>
        <div style="padding:10px 12px;border-right:1px solid var(--border);">
          <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:3px;">Recuperado</div>
          <div style="font-weight:700;font-size:.9rem;color:var(--green);">${fmtCOP(p.totalRecuperado)}</div>
        </div>
        <div style="padding:10px 12px;">
          <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:3px;">Ganancia</div>
          <div style="font-weight:700;font-size:.9rem;color:${ganColor};">${p.ganancia>=0?'+':''}${fmtCOP(p.ganancia)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
        <span style="font-size:.78rem;color:var(--muted);">Stock: <strong style="color:${stockColor};">${fmtNum(p.stockActual)}</strong> ${invBadgeStock(p.estadoStock)}</span>
        <span style="color:var(--border);">·</span>
        <span style="font-size:.78rem;color:var(--muted);">Vendidas: <strong>${fmtNum(p.unidadesVendidas)}</strong></span>
      </div>
      <!-- Acciones operativas -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button onclick="openModalVentaInv('${p.id}')" style="height:32px;padding:0 12px;border:1px solid var(--border);border-radius:7px;background:var(--green);color:#fff;font-size:.75rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
          Registrar venta
        </button>
        <button onclick="openModalRenovarStock('${p.id}')" style="height:32px;padding:0 12px;border:1px solid var(--border);border-radius:7px;background:var(--card);color:var(--text);font-size:.75rem;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:5px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.46"/></svg>
          Renovar stock
        </button>
      </div>
    </div>`;
  }).join('');
}

// ── Dashboard de movimientos globales de inversiones ──
function renderInvTabs() {
  const page = document.getElementById('page-inversiones');
  if (!page) return;

  // Crear tabs si no existen
  if (!document.getElementById('inv-tabs-bar')) {
    const tabBar = document.createElement('div');
    tabBar.id = 'inv-tabs-bar';
    tabBar.style.cssText = 'display:flex;gap:4px;margin-bottom:20px;border-bottom:2px solid var(--border);padding-bottom:0;';
    tabBar.innerHTML = `
      <button id="inv-tab-btn-productos" onclick="setInvTab('productos')"
        style="padding:8px 20px;font-size:.88rem;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;color:var(--muted);transition:all .2s">
        Productos
      </button>
      <button id="inv-tab-btn-movimientos" onclick="setInvTab('movimientos')"
        style="padding:8px 20px;font-size:.88rem;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;color:var(--muted);transition:all .2s">
        Movimientos
      </button>`;
    const statsGrid = page.querySelector('.stats-grid');
    if (statsGrid) statsGrid.after(tabBar);
    else page.querySelector('.page-header-row').after(tabBar);
  }

  // Actualizar estilos de tabs
  const tab = window._invTab || 'productos';
  ['productos','movimientos'].forEach(t => {
    const btn = document.getElementById(`inv-tab-btn-${t}`);
    if (!btn) return;
    btn.style.borderBottomColor = t === tab ? 'var(--accent)' : 'transparent';
    btn.style.color = t === tab ? 'var(--accent)' : 'var(--muted)';
  });

  // Mostrar/ocultar secciones por ID (más robusto que querySelector)
  const listadoSec = document.getElementById('inv-listado-sec');
  const movSec     = document.getElementById('inv-movimientos-sec');

  if (tab === 'movimientos') {
    if (listadoSec) listadoSec.style.display = 'none';
    renderInvMovimientos();
    if (movSec) movSec.style.display = '';
  } else {
    if (movSec) movSec.style.display = 'none';
    if (listadoSec) listadoSec.style.display = '';
  }
}

function setInvTab(tab) {
  window._invTab = tab;
  // Animación de carga de 0.5s antes de renderizar
  const page = document.getElementById('page-inversiones');
  if (!page) return;

  // Mostrar spinner en el área de contenido
  let spinner = document.getElementById('inv-tab-spinner');
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.id = 'inv-tab-spinner';
    spinner.style.cssText = 'display:flex;justify-content:center;align-items:center;padding:40px 0;';
    spinner.innerHTML = `<div style="width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .5s linear infinite;"></div>`;
    const tabBar = document.getElementById('inv-tabs-bar');
    if (tabBar) tabBar.after(spinner);
  }

  // Ocultar todo el contenido durante la carga
  const listadoSec = document.getElementById('inv-listado-sec');
  const movSec     = document.getElementById('inv-movimientos-sec');
  if (listadoSec) listadoSec.style.display = 'none';
  if (movSec)     movSec.style.display = 'none';
  spinner.style.display = 'flex';

  // Actualizar tabs visualmente de inmediato
  ['productos','movimientos'].forEach(t => {
    const btn = document.getElementById(`inv-tab-btn-${t}`);
    if (!btn) return;
    btn.style.borderBottomColor = t === tab ? 'var(--accent)' : 'transparent';
    btn.style.color = t === tab ? 'var(--accent)' : 'var(--muted)';
  });

  // Renderizar tras 0.5s
  setTimeout(() => {
    spinner.style.display = 'none';
    renderInversiones();
  }, 500);
}

function renderInvMovimientos() {
  // Crear o reutilizar el contenedor — va después del tabs bar
  let sec = document.getElementById('inv-movimientos-sec');
  if (!sec) {
    sec = document.createElement('div');
    sec.id = 'inv-movimientos-sec';
    sec.style.marginBottom = '20px';
    const tabBar = document.getElementById('inv-tabs-bar');
    if (tabBar) tabBar.after(sec);
    else {
      const page = document.getElementById('page-inversiones');
      if (page) page.appendChild(sec);
    }
  }

  // Recolectar todos los movimientos de todas las inversiones
  const movs = [];

  (STATE.db.inversiones || []).forEach(inv => {
    const p = enriquecerInversion(inv);

    // Capital inicial invertido
    movs.push({
      fecha: inv.fecha || '—',
      tipo: 'capital',
      concepto: `Capital: ${inv.nombre}`,
      producto: inv.nombre,
      monto: -p.inversionTotal,
      label: 'Inversión inicial',
      color: 'var(--red)',
      signo: '-',
    });

    // Renovaciones de stock
    (inv.renovaciones || []).forEach(r => {
      movs.push({
        fecha: r.fecha || inv.fecha || '—',
        tipo: 'renovacion',
        concepto: `Renovación stock: ${inv.nombre}`,
        producto: inv.nombre,
        monto: -(r.inversionNueva || 0),
        label: 'Renovación stock',
        color: 'var(--orange)',
        signo: '-',
      });
    });

    // Gastos adicionales
    (inv.gastosAdicionales || []).forEach(g => {
      movs.push({
        fecha: g.fecha || '—',
        tipo: 'gasto_adic',
        concepto: `Gasto: ${g.desc} (${inv.nombre})`,
        producto: inv.nombre,
        monto: -Number(g.monto || 0),
        label: g.desc || 'Gasto adicional',
        color: 'var(--red)',
        signo: '-',
      });
    });

    // Ventas registradas
    const ventas = (STATE.db.ventasInv || []).filter(v => v.invId === inv.id);
    ventas.forEach(v => {
      const total = (v.cantidad || 0) * (v.precioUnitario || 0);
      movs.push({
        fecha: v.fecha || '—',
        tipo: 'venta',
        concepto: `Venta: ${inv.nombre}${v.cliente ? ' → ' + v.cliente : ''}`,
        producto: inv.nombre,
        monto: total,
        label: `${v.cantidad} uds × ${fmtCOP(v.precioUnitario)}`,
        color: 'var(--green)',
        signo: '+',
      });
    });
  });

  // Ordenar por fecha descendente
  movs.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  if (!movs.length) { sec.innerHTML = ''; return; }

  const totalEntradas = movs.filter(m=>m.monto>0).reduce((a,m)=>a+m.monto,0);
  const totalSalidas  = movs.filter(m=>m.monto<0).reduce((a,m)=>a+Math.abs(m.monto),0);

  const TIPO_LABELS = { capital:'Capital invertido', renovacion:'Renovación stock', gasto_adic:'Gasto adicional', venta:'Venta' };
  const TIPO_BADGE  = { capital:'badge-red', renovacion:'badge-yellow', gasto_adic:'badge-red', venta:'badge-green' };

  // Filtro por tipo
  const filtroActual = window._invMovFiltro || '';

  sec.innerHTML = `
    <div class="section" style="margin-bottom:16px;">
      <div class="section-header" style="margin-bottom:12px;">
        <span class="section-title">Movimientos de inversiones</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${['','capital','renovacion','gasto_adic','venta'].map(t => `
            <button class="btn btn-sm ${filtroActual===t?'btn-primary':'btn-ghost'}"
              onclick="window._invMovFiltro='${t}';renderInvMovimientos()">
              ${t===''?'Todos':TIPO_LABELS[t]}
            </button>`).join('')}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;border-left:4px solid var(--green);">
          <div style="font-size:.75rem;color:var(--muted);font-weight:500">Total recuperado (ventas)</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--green)">${fmtCOP(totalEntradas)}</div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;border-left:4px solid var(--red);">
          <div style="font-size:.75rem;color:var(--muted);font-weight:500">Total invertido (costos)</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--red)">${fmtCOP(totalSalidas)}</div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Producto</th>
              <th>Concepto</th>
              <th>Tipo</th>
              <th>Monto</th>
            </tr>
          </thead>
          <tbody>
            ${(filtroActual ? movs.filter(m=>m.tipo===filtroActual) : movs).map(m=>`
              <tr>
                <td style="white-space:nowrap;color:var(--muted);font-size:.82rem">${m.fecha}</td>
                <td style="font-weight:600;font-size:.85rem">${m.producto}</td>
                <td style="font-size:.82rem;color:var(--muted)">${m.label}</td>
                <td><span class="badge ${TIPO_BADGE[m.tipo]||'badge-blue'}" style="font-size:.72rem">${TIPO_LABELS[m.tipo]||m.tipo}</span></td>
                <td style="font-weight:700;white-space:nowrap;color:${m.monto>=0?'var(--green)':'var(--red)'}">
                  ${m.signo}${fmtCOP(Math.abs(m.monto))}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function populateInvTipoFilter() {
  const tipos = [...new Set(getInversiones().map(i=>i.tipo).filter(Boolean))];
  const sel   = document.getElementById('inv-filter-tipo');
  if(!sel) return;
  const cur   = sel.value;
  sel.innerHTML = '<option value="">Todos los tipos</option>';
  tipos.forEach(t => {
    const opt=document.createElement('option'); opt.value=t; opt.textContent=t;
    if(t===cur) opt.selected=true; sel.appendChild(opt);
  });
}

// ─── Modal nueva / editar inversión ───────────────────────────
function openModalNuevaInversion(id=null) {
  const inv = id ? STATE.db.inversiones.find(i=>i.id===id) : null;
  const titulo = inv ? 'Editar inversión' : 'Nueva inversión';
  const ymd = new Date().toISOString().slice(0,10);

  const overlay = document.getElementById('modal-inv-form-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:620px;width:100%;">
      <div class="modal-title">${titulo}
        <button onclick="closeInvModal()" style="float:right;background:none;border:none;font-size:1rem;color:var(--muted);cursor:pointer;">✕</button>
      </div>
      <div class="modal-body-wrap">
        <div style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border-light);">
          <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:10px;">Identificación</div>
          <div class="form-grid">
            <div class="form-group"><label>SKU / Código</label>
              <input type="text" class="form-control" id="fi-sku" value="${inv?.sku||''}" placeholder="Ej: B0002DI16A">
            </div>
            <div class="form-group"><label>Nombre del producto *</label>
              <input type="text" class="form-control" id="fi-nombre" value="${inv?.nombre||''}" placeholder="Ej: TETRA 3.7oz">
            </div>
            <div class="form-group"><label>Tipo</label>
              <select class="form-control" id="fi-tipo">
                ${['Producto importado','Acciones','Criptomonedas','Finca raíz','CDT / Ahorro','Negocio propio','Préstamo con interés','Otro']
                  .map(t=>`<option value="${t}" ${(inv?.tipo||'Producto importado')===t?'selected':''}>${t}</option>`).join('')}
              </select>
            </div>
            <div class="form-group"><label>Plataforma / Proveedor</label>
              <input type="text" class="form-control" id="fi-plataforma" value="${inv?.plataforma||''}" placeholder="Amazon, MercadoLibre...">
            </div>
            <div class="form-group"><label>Link del producto</label>
              <input type="text" class="form-control" id="fi-link" value="${inv?.link||''}" placeholder="https://amazon.com/...">
            </div>
            <div class="form-group"><label>URL imagen del producto</label>
              <input type="text" class="form-control" id="fi-imagen" value="${inv?.imagen||''}" placeholder="https://... o pega URL de imagen">
            </div>
            <div class="form-group"><label>Categoría</label>
              <input type="text" class="form-control" id="fi-cat" value="${inv?.categoria||''}" placeholder="Electrónica, Mascotas...">
            </div>
          </div>
        </div>
        <div style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border-light);">
          <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:10px;">Costos e inversión</div>
          <div class="form-grid">
            <div class="form-group"><label>Precio compra USD *</label>
              <input type="number" class="form-control" id="fi-precio-usd" value="${inv?.precioUSD||''}" step="0.01" placeholder="0.00" oninput="calcPreviewInv()">
            </div>
            <div class="form-group"><label>Tasa dólar (COP) *</label>
              <input type="number" class="form-control" id="fi-tasa" value="${inv?.tasa||4200}" oninput="calcPreviewInv()">
            </div>
            <div class="form-group"><label>Cantidad comprada *</label>
              <input type="number" class="form-control" id="fi-unidades" value="${inv?.unidades||''}" placeholder="Ej: 6" oninput="calcPreviewInv()">
            </div>
            <div class="form-group"><label>Envío internacional (COP)</label>
              <input type="number" class="form-control" id="fi-envio" value="${inv?.envio||0}" placeholder="0" oninput="calcPreviewInv()">
            </div>
            <div class="form-group"><label>Otros costos (COP)</label>
              <input type="number" class="form-control" id="fi-otros" value="${inv?.otrosCostos||0}" placeholder="0" oninput="calcPreviewInv()">
            </div>
            <div class="form-group"><label>Precio sugerido venta (COP)</label>
              <input type="number" class="form-control" id="fi-precio-sugerido" value="${inv?.precioSugerido||''}" placeholder="0">
            </div>
          </div>
          <div id="inv-preview" style="margin-top:10px;padding:10px 14px;background:var(--accent-light);border-radius:var(--radius-sm);font-size:.875rem;color:var(--accent2);display:flex;gap:24px;">
            <div>Inversión total: <strong id="prev-inv-total">—</strong></div>
            <div>Costo unitario: <strong id="prev-inv-unit">—</strong></div>
          </div>
        </div>
        <div>
          <div style="font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;margin-bottom:10px;">Estado y fuente de dinero</div>
          <div class="form-grid">
            <div class="form-group"><label>Fecha de compra *</label>
              <input type="date" class="form-control" id="fi-fecha" value="${inv?.fecha||ymd}">
            </div>
            <div class="form-group"><label>Estado</label>
              <select class="form-control" id="fi-estado">
                <option value="activa" ${(inv?.estado||'activa')==='activa'?'selected':''}>Activa</option>
                <option value="pausada" ${inv?.estado==='pausada'?'selected':''}>Pausada</option>
                <option value="cerrada" ${inv?.estado==='cerrada'?'selected':''}>Cerrada</option>
              </select>
            </div>
            <div class="form-group"><label> Dinero sale de *</label>
              <select class="form-control" id="fi-billetera" onchange="calcPreviewInv()">
                <option value="">— Selecciona billetera (obligatorio) —</option>
                ${(STATE.db.billeteras||[]).map(b=>{
                  const saldo = saldoBilletera(b.id);
                  const invTotalPreview = 0; // se validará al guardar
                  return `<option value="${b.id}"
                    ${(inv?.billeteraId===b.id)?'selected':''}
                    style="color:${saldo>0?'inherit':'var(--red)'}"
                  >${(BILL_ICONOS[b.tipo]||'')+' '+b.nombre+' — '+fmt(saldo)}</option>`;
                }).join('')}
              </select>
              <small style="color:var(--muted);font-size:.72rem">El costo total se descontará de esta billetera</small>
              <div id="fi-bill-aviso" style="display:none;margin-top:5px;font-size:.78rem;color:var(--red);font-weight:600;"></div>
            </div>
            <div class="form-group"><label> Unidades en bodega (recibidas)</label>
              <input type="number" class="form-control" id="fi-bodega" value="${inv?.unidadesEnBodega||''}" placeholder="0">
              <small style="color:var(--muted);font-size:.72rem">Cuántas ya tienes físicamente</small>
            </div>
            <div class="form-group" style="grid-column:1/-1"><label>Notas / Observaciones</label>
              <input type="text" class="form-control" id="fi-notas" value="${inv?.notas||''}" placeholder="Pedido Amazon #, observaciones...">
            </div>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeInvModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarInversion('${id||''}')">
          ${inv?'Guardar cambios':'Crear inversión'}
        </button>
      </div>
    </div>`;
  overlay.style.display='flex';
  setTimeout(calcPreviewInv, 50);
}

function closeInvModal() {
  const o=document.getElementById('modal-inv-form-overlay');
  if(o) { o.style.display='none'; o.innerHTML=''; }
}

function calcPreviewInv() {
  const usd  = parseFloat(document.getElementById('fi-precio-usd')?.value)||0;
  const tasa = parseFloat(document.getElementById('fi-tasa')?.value)||0;
  const cant = parseFloat(document.getElementById('fi-unidades')?.value)||0;
  const env  = parseFloat(document.getElementById('fi-envio')?.value)||0;
  const otr  = parseFloat(document.getElementById('fi-otros')?.value)||0;
  const inv  = (usd*tasa*cant)+env+otr;
  const unit = cant>0?inv/cant:0;
  const e1=document.getElementById('prev-inv-total'); if(e1) e1.textContent=fmtCOP(inv);
  const e2=document.getElementById('prev-inv-unit');  if(e2) e2.textContent=fmtCOP(unit);

  // Actualizar aviso de saldo en tiempo real
  const billSel = document.getElementById('fi-billetera');
  const aviso   = document.getElementById('fi-bill-aviso');
  if (billSel && aviso && billSel.value && inv > 0) {
    const saldo = saldoBilletera(billSel.value);
    if (saldo < inv) {
      aviso.style.display = '';
      aviso.textContent = `Saldo insuficiente. Disponible: ${fmt(saldo)} — Necesario: ${fmtCOP(inv)}`;
    } else {
      aviso.style.display = '';
      aviso.textContent = `Saldo suficiente. Quedarán ${fmt(saldo - inv)} tras la compra`;
      aviso.style.color = 'var(--green)';
    }
  } else if (aviso) {
    aviso.style.display = 'none';
  }
}

async function guardarInversion(id=null) {
  const nombre    = document.getElementById('fi-nombre')?.value.trim();
  const precioUSD = parseFloat(document.getElementById('fi-precio-usd')?.value)||0;
  const tasa      = parseFloat(document.getElementById('fi-tasa')?.value)||0;
  const unidades  = parseInt(document.getElementById('fi-unidades')?.value)||0;
  const fecha     = document.getElementById('fi-fecha')?.value;

  if(!nombre) return toast('El nombre es obligatorio','error');
  if(!precioUSD && !document.getElementById('fi-envio')?.value) return toast('Ingresa el costo de compra','error');
  if(!fecha)  return toast('La fecha es obligatoria','error');

  const billeteraId = document.getElementById('fi-billetera')?.value || '';
  const envioVal    = parseFloat(document.getElementById('fi-envio')?.value)||0;
  const otrosVal    = parseFloat(document.getElementById('fi-otros')?.value)||0;
  const invTotal    = (precioUSD * tasa * unidades) + envioVal + otrosVal;

  // Solo validar billetera obligatoria al CREAR (al editar no se descuenta dinero)
  if (!id || id === '') {
    if (!billeteraId) {
      const sel = document.getElementById('fi-billetera');
      if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(()=>sel.style.border='',2000); }
      const aviso = document.getElementById('fi-bill-aviso');
      if (aviso) { aviso.style.display=''; aviso.textContent='Debes seleccionar de qué billetera sale el dinero'; }
      return toast('Debes seleccionar de qué billetera sale el dinero', 'error');
    }
    if (invTotal > 0) {
      const saldo = saldoBilletera(billeteraId);
      if (saldo < invTotal) {
        const sel = document.getElementById('fi-billetera');
        if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(()=>sel.style.border='',2000); }
        const aviso = document.getElementById('fi-bill-aviso');
        const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
        if (aviso) { aviso.style.display=''; aviso.textContent=`Saldo insuficiente en ${bill?.nombre||'billetera'}. Disponible: ${fmt(saldo)} — Necesario: ${fmtCOP(invTotal)}`; }
        return toast(`Saldo insuficiente. Disponible: ${fmt(saldo)} — Necesario: ${fmtCOP(invTotal)}`, 'error');
      }
    }
  }

  const datos = {
    nombre, sku: document.getElementById('fi-sku')?.value.trim(),
    tipo: document.getElementById('fi-tipo')?.value,
    plataforma: document.getElementById('fi-plataforma')?.value.trim(),
    link: document.getElementById('fi-link')?.value.trim(),
    imagen: document.getElementById('fi-imagen')?.value.trim(),
    categoria: document.getElementById('fi-cat')?.value.trim(),
    precioUSD, capitalUSD: precioUSD * unidades, tasa, capitalCOP: 0,
    unidades,
    unidadesIniciales: unidades,
    unidadesEnBodega: parseInt(document.getElementById('fi-bodega')?.value)||unidades,
    envio: envioVal,
    envioInicial: envioVal,
    otrosCostos: otrosVal,
    otrosCostosInicial: otrosVal,
    precioSugerido: parseFloat(document.getElementById('fi-precio-sugerido')?.value)||0,
    fecha, estado: document.getElementById('fi-estado')?.value||'activa',
    notas: document.getElementById('fi-notas')?.value.trim(),
    billeteraId,
  };

  if(id && id!=='') {
    const idx = STATE.db.inversiones.findIndex(i=>i.id===id);
    if(idx!==-1) STATE.db.inversiones[idx] = { ...STATE.db.inversiones[idx], ...datos };
    toast('Inversión actualizada','success');
  } else {
    STATE.db.inversiones.push({ id:uid(), ...datos });
    // Descontar de billetera si fue seleccionada
    if (billeteraId && invTotal > 0) {
      const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
      STATE.db.gastos.push({
        id: uid(), fecha,
        hora: horaActual(),
        monto: Math.round(invTotal),
        desc: 'Inversión: ' + nombre,
        cat: 'Inversión',
        billeteraId,
        autoGenerado: true
      });
      const bn = bill ? ` (de ${bill.nombre})` : '';
      toast(`Inversión creada${bn} · ${fmtCOP(invTotal)} descontado `, 'success');
    } else {
      toast('Inversión creada', 'success');
    }
  }
  renderAll();
  closeInvModal();
  await saveDb(['inversiones','gastos']);
}

// ─── Modal venta inversión ────────────────────────────────────
function openModalVentaInv(invId) {
  const inv = STATE.db.inversiones.find(i=>i.id===invId);
  if(!inv) return;
  const p = enriquecerInversion(inv);
  const ymd = new Date().toISOString().slice(0,10);

  const overlay = document.getElementById('modal-inv-form-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px;width:100%;">
      <div class="modal-title">Registrar venta
        <button onclick="closeInvModal()" style="float:right;background:none;border:none;font-size:1rem;color:var(--muted);cursor:pointer;">✕</button>
      </div>
      <div class="modal-body-wrap">
        <div style="display:flex;align-items:center;gap:12px;padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid var(--border-light);">
          ${inv.imagen
            ? `<img src="${inv.imagen}" alt="${inv.nombre}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0;"
                 onerror="this.style.display='none'">`
            : `<div style="width:44px;height:44px;border-radius:8px;background:var(--accent-light);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;">${(inv.nombre||'?')[0].toUpperCase()}</div>`}
          <div>
            <div style="font-weight:700">${inv.nombre}</div>
            <div style="font-size:.82rem;color:var(--muted)">Stock disponible: <strong style="color:var(--text)">${p.stockActual}</strong> uds · Precio sugerido: ${fmtCOP(inv.precioSugerido||0)}</div>
          </div>
        </div>
        <div class="form-grid">
          <div class="form-group"><label>Fecha de venta *</label>
            <input type="date" class="form-control" id="fv-fecha" value="${ymd}">
          </div>
          <div class="form-group"><label>Cantidad *</label>
            <input type="number" class="form-control" id="fv-cant" min="1" max="${p.stockActual}" placeholder="Ej: 2" oninput="onFvBilleteraChange()">
          </div>
          <div class="form-group" style="grid-column:1/-1"><label>Precio unitario de venta (COP) *</label>
            <input type="number" class="form-control" id="fv-precio" min="1" placeholder="${inv.precioSugerido||'Ej: 180000'}" oninput="onFvBilleteraChange()">
          </div>
          <div class="form-group"><label>Cliente / Referencia</label>
            <input type="text" class="form-control" id="fv-cliente" placeholder="Nombre opcional">
          </div>
          <div class="form-group"><label>Observación</label>
            <input type="text" class="form-control" id="fv-obs" placeholder="Notas opcionales">
          </div>
          <div class="form-group" style="grid-column:1/-1"><label> Dinero ingresa a *</label>
            <select class="form-control" id="fv-billetera" onchange="onFvBilleteraChange()">
              <option value="">— Selecciona billetera (obligatorio) —</option>
              ${(STATE.db.billeteras||[]).map(b=>{
                const s=saldoBilletera(b.id);
                return `<option value="${b.id}">${(BILL_ICONOS[b.tipo]||'')+' '+b.nombre+' — '+fmt(s)}</option>`;
              }).join('')}
            </select>
            <div id="fv-bill-preview" style="display:none;margin-top:6px;padding:8px 12px;border-radius:var(--radius-sm);font-size:.83rem;font-weight:600;"></div>
            <small style="color:var(--muted);font-size:.72rem">El dinero de la venta se sumará a esta billetera</small>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeInvModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="guardarVentaInv('${invId}',${p.stockActual})">Registrar venta</button>
      </div>
    </div>`;
  overlay.style.display='flex';
}

function onFvBilleteraChange() {
  const sel     = document.getElementById('fv-billetera');
  const preview = document.getElementById('fv-bill-preview');
  if (!preview || !sel) return;
  const precio = parseFloat(document.getElementById('fv-precio')?.value)||0;
  const cant   = parseInt(document.getElementById('fv-cant')?.value)||0;
  if (!sel.value) { preview.style.display='none'; return; }
  const saldo       = saldoBilletera(sel.value);
  const totalVenta  = precio * cant;
  const saldoFuturo = saldo + totalVenta;
  preview.style.display = '';
  if (totalVenta > 0) {
    preview.style.background = 'var(--green-light)';
    preview.style.color = 'var(--green)';
    preview.innerHTML = `Saldo actual: <strong>${fmt(saldo)}</strong> → tras venta: <strong>${fmt(saldoFuturo)}</strong> <span style="color:var(--muted);font-weight:400">(+${fmt(totalVenta)})</span>`;
  } else {
    preview.style.background = 'var(--bg2)';
    preview.style.color = 'var(--muted)';
    preview.innerHTML = `Saldo actual: <strong>${fmt(saldo)}</strong> — ingresa cantidad y precio para ver el total`;
  }
}

async function guardarVentaInv(invId, stockDisp) {
  const fecha    = document.getElementById('fv-fecha')?.value;
  const cantidad = parseInt(document.getElementById('fv-cant')?.value)||0;
  const precio   = parseFloat(document.getElementById('fv-precio')?.value)||0;
  const cliente  = document.getElementById('fv-cliente')?.value.trim();
  const obs      = document.getElementById('fv-obs')?.value.trim();
  const billeteraId = document.getElementById('fv-billetera')?.value || '';

  if(!fecha)    return toast('La fecha es obligatoria','error');
  if(!cantidad) return toast('La cantidad debe ser mayor a 0','error');
  if(cantidad>stockDisp) return toast('Stock insuficiente. Disponible: '+stockDisp,'error');
  if(!precio)   return toast('El precio de venta es obligatorio','error');
  if(!billeteraId) {
    const sel = document.getElementById('fv-billetera');
    if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(() => sel.style.border = '', 2000); }
    return toast('Debes seleccionar en qué billetera ingresa el dinero de la venta','error');
  }
  const ventaId = uid();
  addVentaInv({ id: ventaId, invId, fecha, cantidad, precioUnitario:precio, cliente, obs, billeteraId });

  const inv = STATE.db.inversiones.find(i=>i.id===invId);
  const billNombre = STATE.db.billeteras?.find(b=>b.id===billeteraId)?.nombre || '';
  // Calcular ganancia real: precio_venta - costo_unitario
  const totalInvCap = inv ? (
    Number(inv.capitalCOP||0) +
    (Number(inv.precioUSD||0)*Number(inv.unidades||1)*Number(inv.tasa||0)) +
    Number(inv.envio||0) + Number(inv.otrosCostos||0)
  ) : 0;
  const costoUnit = (inv && inv.unidades > 0) ? totalInvCap / inv.unidades : 0;
  const gananciaVenta = (precio - costoUnit) * cantidad; // solo la ganancia neta
  const totalVenta = precio * cantidad;

  // Registrar el ingreso total de la venta en la billetera seleccionada
  STATE.db.ingresos.push({
    id:uid(), fecha,
    hora: horaActual(),
    monto: Math.round(totalVenta),
    fuente:'Venta inversión: '+(inv?.nombre||'Producto')+(cliente?' — '+cliente:''),
    cat:'Inversión',
    billeteraId,
    autoGenerado:true,
    esRecuperacionInversion: true,
    origenVentaId: ventaId   // ← AGREGA ESTA LÍNEA
  });

  renderAll();
  closeInvModal();
  await saveDb(['ventasInv','ingresos']);
  const destino = billNombre ? ` → ${billNombre}` : '';
  toast('Venta registrada' + destino + (gananciaVenta > 0 ? ' — ganancia: ' + fmtCOP(Math.round(gananciaVenta)) : '') + ' ','success');
}

// ─── Detalle inversión (vista completa) ───────────────────────
function openDetalleInv(invId) {
  navigate('detalle-inv', invId);
}

function renderDetalleInv(invId) {
  const rawInv = STATE.db.inversiones.find(i=>i.id===invId);
  if(!rawInv) { navigate('inversiones'); return; }
  const p = enriquecerInversion(rawInv);
  const invIdx = STATE.db.inversiones.indexOf(rawInv);

  const pct = p.inversionTotal>0?((p.totalRecuperado/p.inversionTotal)*100).toFixed(1):0;

  // Calcular totales de movimientos del producto
  const totalGastosAdic = (p.gastosAdicionales||[]).reduce((a,g)=>a+Number(g.monto),0);
  const totalEnvios = Number(rawInv.envio||0) + (rawInv.renovaciones||[]).reduce((a,r)=>a+Number(r.envio||0),0);
  const totalCapital = p.inversionTotal - totalGastosAdic - totalEnvios;

  document.getElementById('page-detalle-inv').innerHTML = `
    <div class="page-header-row">
      <div>
        <button class="btn btn-ghost btn-sm" onclick="navigate('inversiones')" style="margin-bottom:8px;">&#x2190; Volver</button>
        <p class="page-title">${p.nombre}</p>
        <p class="page-sub" style="margin-bottom:0">${p.tipo||''}${p.plataforma?' · '+p.plataforma:''}${p.sku?' · SKU: '+p.sku:''}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="openModalVentaInv('${p.id}')">+ Registrar venta</button>
        <button class="btn btn-success" onclick="openModalRenovarStock('${p.id}')">Renovar stock</button>
        <button class="btn btn-danger btn-sm" onclick="openModalGastoAdicionalInv('${p.id}')">+ Gasto adicional</button>
        <button class="btn btn-ghost" onclick="openModalNuevaInversion('${p.id}')">Editar</button>
      </div>
    </div>

    <!-- KPIs del producto -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:20px;">
      ${[
        ['var(--red)',    'Capital invertido',    fmtCOP(totalCapital),          `${fmtNum(p.unidades||0)} unidades`],
        ['var(--orange)', 'Envíos pagados',        fmtCOP(totalEnvios),           'costos de logística'],
        ['var(--red)',    'Gastos adicionales',    fmtCOP(totalGastosAdic),       `${(p.gastosAdicionales||[]).length} registros`],
        ['var(--green)',  'Total recuperado',      fmtCOP(p.totalRecuperado),     `${pct}% de lo invertido`],
        [p.ganancia>=0?'var(--green)':'var(--red)', 'Ganancia neta', fmtCOP(p.ganancia), `${p.unidadesVendidas} uds vendidas`],
        ['var(--orange)', 'Stock actual',          fmtNum(p.stockActual)+' uds', invBadgeStock(p.estadoStock)],
      ].map(([color,lbl,val,sub])=>`
        <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);
          padding:14px 16px;border-left:4px solid ${color};box-shadow:var(--shadow);">
          <div style="font-size:.72rem;color:var(--muted);font-weight:500;margin-bottom:4px">${lbl}</div>
          <div style="font-size:1.1rem;font-weight:700;margin-bottom:2px;color:${color}">${val}</div>
          <div style="font-size:.72rem;color:var(--muted)">${sub}</div>
        </div>`).join('')}
    </div>

    <!-- Barra de progreso de ventas -->
    ${p.unidades>0?`
    <div class="section" style="padding:14px 18px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;font-size:.82rem;color:var(--muted);margin-bottom:6px;">
        <span>Progreso de ventas — ${p.unidadesVendidas} de ${p.unidades} unidades</span>
        <span style="font-weight:700">${Math.round((p.unidadesVendidas/p.unidades)*100)}%</span>
      </div>
      <div class="progress-bar" style="height:10px;">
        <div class="progress-fill" style="width:${Math.min(100,Math.round((p.unidadesVendidas/p.unidades)*100))}%;background:var(--accent)"></div>
      </div>
    </div>`:''}

    <!-- Info del producto + precios -->
    <div class="det-grid" style="margin-bottom:20px;">
      <div class="section" style="padding:20px;">
        ${p.imagen
          ? `<img src="${p.imagen}" alt="${p.nombre}" style="width:100%;height:160px;object-fit:cover;border-radius:var(--radius-sm);margin-bottom:16px;"
               onerror="this.outerHTML='<div style=\\'width:100%;height:160px;border-radius:var(--radius-sm);background:linear-gradient(135deg,var(--accent-light),var(--purple-light));color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:3.5rem;margin-bottom:16px;\\'>${(p.nombre||'?')[0].toUpperCase()}</div>'">`
          : `<div style="width:100%;height:160px;border-radius:var(--radius-sm);background:linear-gradient(135deg,var(--accent-light),var(--purple-light));
              color:var(--accent);display:flex;align-items:center;justify-content:center;font-size:3.5rem;margin-bottom:16px;">
              ${(p.nombre||'?')[0].toUpperCase()}
             </div>`}
        ${[
          ['SKU', p.sku ? `<code style="font-family:var(--font-mono);font-size:.78rem;background:var(--bg2);border:1px solid var(--border);padding:2px 6px;border-radius:4px;color:var(--muted)">${p.sku}</code>` : '—'],
          ['Categoría', p.categoria||'—'],
          ['Proveedor', p.plataforma||'—'],
          ['Estado', invBadgeEstado(p.estado)],
          ['Stock', invBadgeStock(p.estadoStock)],
          ['Fecha compra', p.fecha||'—'],
          ['Link', p.link?`<a href="${p.link}" target="_blank" style="color:var(--accent);font-size:.85rem">Ver producto ↗</a>`:'—'],
        ].map(([lbl,val])=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border-light);font-size:.875rem;">
            <span style="color:var(--muted);font-size:.8rem">${lbl}</span>
            <span>${val}</span>
          </div>`).join('')}
        ${p.notas?`<div style="margin-top:10px;font-size:.82rem;color:var(--muted);font-style:italic">${p.notas}</div>`:''}
        ${p.estado!=='cerrada'?`
        <div style="margin-top:16px;display:flex;gap:8px;">
          ${p.estado==='activa'?`<button class="btn btn-ghost btn-sm" style="flex:1" onclick="cambiarEstadoInv(${invIdx},'cerrada')">Cerrar inversión</button>`:''}
          ${p.estado==='activa'?`<button class="btn btn-ghost btn-sm" style="flex:1" onclick="cambiarEstadoInv(${invIdx},'pausada')">Pausar</button>`:''}
          ${p.estado==='pausada'?`<button class="btn btn-ghost btn-sm" style="flex:1" onclick="cambiarEstadoInv(${invIdx},'activa')">Activar</button>`:''}
        </div>`:''}
      </div>

      <div class="section" style="padding:20px;">
        <div style="font-size:.8rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px;">Estructura de costos</div>
        ${[
          ['Precio USD c/u',    `$${p.precioUSD||0} USD`],
          ['Tasa de cambio',    fmtCOP(p.tasa||0)],
          ['Costo unitario COP', fmtCOP(p.costoUnitario)],
          ['Envío base',        fmtCOP(rawInv.envio||0)],
          ['Otros costos',      fmtCOP(rawInv.otrosCostos||0)],
          ['Precio sugerido',   `<strong style="color:var(--accent)">${fmtCOP(p.precioSugerido||0)}</strong>`],
        ].map(([lbl,val])=>`
          <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border-light);font-size:.875rem;">
            <span style="color:var(--muted);font-size:.8rem">${lbl}</span>
            <span>${val}</span>
          </div>`).join('')}
      </div>
    </div>

    <!-- Renovaciones -->
    ${p.renovaciones && p.renovaciones.length ? `
    <div class="section" style="margin-bottom:14px;">
      <div class="section-header">
        <span class="section-title">Renovaciones de stock (${p.renovaciones.length})</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Fecha</th><th>Unidades</th><th>USD c/u</th><th>Tasa</th><th>Envío</th><th>Inversión</th><th>Notas</th></tr></thead>
          <tbody>
            ${[...p.renovaciones].reverse().map(r=>`
              <tr>
                <td>${r.fecha||'—'}</td>
                <td>+${r.nuevasUnidades}</td>
                <td>$${r.precioUSD}</td>
                <td>${fmtCOP(r.tasa)}</td>
                <td style="color:var(--orange)">${fmtCOP(r.envio||0)}</td>
                <td style="font-weight:600">${fmtCOP(r.inversionNueva)}</td>
                <td style="color:var(--muted);font-size:.82rem">${r.notas||'—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <!-- Gastos adicionales -->
    <div class="section" style="margin-bottom:14px;">
      <div class="section-header">
        <span class="section-title">Gastos adicionales</span>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:.82rem;color:var(--muted)">${(p.gastosAdicionales||[]).length} registros · Total: <strong style="color:var(--red)">${fmtCOP(totalGastosAdic)}</strong></span>
          <button class="btn btn-danger btn-sm" onclick="openModalGastoAdicionalInv('${p.id}')">+ Agregar</button>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Fecha</th><th>Concepto</th><th>Monto</th><th>Billetera</th><th>Notas</th><th></th></tr></thead>
          <tbody>
            ${!(p.gastosAdicionales||[]).length
              ? '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;font-style:italic">Sin gastos adicionales registrados</td></tr>'
              : [...(p.gastosAdicionales||[])].sort((a,b)=>new Date(b.fecha)-new Date(a.fecha)).map(g => {
                  const bill = STATE.db.billeteras?.find(b=>b.id===g.billeteraId);
                  return `<tr>
                    <td style="white-space:nowrap">${g.fecha||'—'}</td>
                    <td style="font-weight:600">${g.desc}</td>
                    <td style="color:var(--red);font-weight:600">${fmtCOP(g.monto)}</td>
                    <td style="color:var(--muted);font-size:.82rem">${bill?bill.nombre:'—'}</td>
                    <td style="color:var(--muted);font-size:.82rem">${g.notas||'—'}</td>
                    <td><button class="btn btn-danger btn-sm" onclick="eliminarGastoAdicionalInv('${g.id}','${p.id}')">
                      <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                    </button></td>
                  </tr>`;
                }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Historial de ventas -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">Historial de ventas</span>
        <span style="font-size:.82rem;color:var(--muted)">${p.ventas.length} registros · <strong style="color:var(--green)">${fmtCOP(p.totalRecuperado)}</strong> recuperado</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Fecha</th><th>Cantidad</th><th>Precio unit.</th><th>Total</th><th>Cliente</th><th>Observación</th><th></th></tr></thead>
          <tbody>
            ${!p.ventas.length
              ? '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:28px;font-style:italic">Sin ventas registradas</td></tr>'
              : [...p.ventas].sort((a,b)=>new Date(b.fecha)-new Date(a.fecha)).map(v=>`
                <tr>
                  <td>${v.fecha||'—'}</td>
                  <td style="font-weight:600">${v.cantidad}</td>
                  <td>${fmtCOP(v.precioUnitario)}</td>
                  <td style="font-weight:700;color:var(--green)">${fmtCOP((v.cantidad||0)*(v.precioUnitario||0))}</td>
                  <td style="color:var(--muted)">${v.cliente||'—'}</td>
                  <td style="color:var(--muted)">${v.obs||'—'}</td>
                  <td><button class="btn btn-danger btn-sm" onclick="eliminarVentaInv('${v.id}','${p.id}')">
                    <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                  </button></td>
                </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
async function eliminarVentaInv(ventaId, invId) {
  if(!confirm('¿Eliminar esta venta?')) return;

  // Eliminar el ingreso asociado en billeteras e ingresos
  const idx = STATE.db.ingresos.findIndex(i => i.origenVentaId === ventaId);
  if (idx !== -1) STATE.db.ingresos.splice(idx, 1);

  deleteVentaInv(ventaId);
  renderDetalleInv(invId);
  renderAll();
  await saveDb(['ventasInv', 'ingresos']);
  toast('Venta e ingreso asociado eliminados', 'info');
}

async function deleteInversion(idx) {
  const inv = STATE.db.inversiones[idx];
  if (!inv) return;
  pedirPinParaAccion(`Eliminar "${inv.nombre}"`, async () => {
    STATE.db.ventasInv = (STATE.db.ventasInv||[]).filter(v=>v.invId!==inv.id);
    STATE.db.inversiones.splice(idx,1);
    renderAll();
    await saveDb(['inversiones','ventasInv']);
    toast('Inversión eliminada','info');
  });
}

async function cambiarEstadoInv(idx, estado) {
  const inv = STATE.db.inversiones[idx];
  if (!inv) return;
  inv.estado = estado;
  if (estado === 'cerrada') {
    const p = enriquecerInversion(inv);
    if (p.ganancia > 0) {
      // Al cerrar: solo registrar la GANANCIA NETA como ingreso
      STATE.db.ingresos.push({
        id: uid(),
        fecha: new Date().toISOString().slice(0, 10),
        hora: horaActual(),
        monto: Math.round(p.ganancia),
        fuente: 'Ganancia inversión cerrada: ' + inv.nombre,
        cat: 'Inversión',
        autoGenerado: true
      });
      toast(`Inversión cerrada — ganancia ${fmtCOP(Math.round(p.ganancia))} registrada `, 'success');
    } else {
      toast('Inversión cerrada', 'success');
    }
  }
  renderAll();
  await saveDb(['inversiones', 'ingresos']);
}

// ─── Renovar stock ───────────────────────────────────────────
function openModalRenovarStock(invId) {
  const inv = STATE.db.inversiones.find(i=>i.id===invId);
  if (!inv) return;
  const p = enriquecerInversion(inv);
  const ymd = new Date().toISOString().slice(0,10);

  const billeterasOpts = (STATE.db.billeteras||[]).map(b => {
    const s = saldoBilletera(b.id);
    return `<option value="${b.id}" style="color:${s>0?'inherit':'var(--red)'}">
      ${BILL_ICONOS[b.tipo]||''} ${b.nombre} — ${fmt(s)}
    </option>`;
  }).join('');

  const overlay = document.getElementById('modal-inv-form-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:480px;width:100%;">
      <div class="modal-title"> Renovar stock — ${inv.nombre}
        <button onclick="closeInvModal()" style="float:right;background:none;border:none;font-size:1rem;color:var(--muted);cursor:pointer;">✕</button>
      </div>
      <div class="modal-body-wrap">
        <div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:16px;font-size:.85rem;color:var(--muted)">
          Stock actual: <strong style="color:var(--text)">${p.stockActual} uds</strong> ·
          Costo unitario actual: <strong style="color:var(--text)">${fmtCOP(p.costoUnitario)}</strong>
        </div>
        <div class="form-grid">
          <div class="form-group"><label>Nuevas unidades *</label>
            <input type="number" class="form-control" id="rs-unidades" placeholder="Ej: 6" oninput="calcRenovarPreview()">
          </div>
          <div class="form-group"><label>Precio compra USD *</label>
            <input type="number" class="form-control" id="rs-precio-usd" value="${inv.precioUSD||''}" step="0.01" oninput="calcRenovarPreview()">
          </div>
          <div class="form-group"><label>Tasa dólar (COP)</label>
            <input type="number" class="form-control" id="rs-tasa" value="${inv.tasa||4200}" oninput="calcRenovarPreview()">
          </div>
          <div class="form-group"><label>Envío (COP)</label>
            <input type="number" class="form-control" id="rs-envio" value="0" oninput="calcRenovarPreview()">
          </div>
          <div class="form-group"><label>Otros costos (COP)</label>
            <input type="number" class="form-control" id="rs-otros" value="0" oninput="calcRenovarPreview()">
          </div>
          <div class="form-group"><label>Nuevo precio sugerido venta</label>
            <input type="number" class="form-control" id="rs-precio-venta" value="${inv.precioSugerido||''}" placeholder="0">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label> Dinero sale de *</label>
            <select class="form-control" id="rs-billetera" onchange="calcRenovarPreview()">
              <option value="">— Selecciona billetera (obligatorio) —</option>
              ${billeterasOpts}
            </select>
            <div id="rs-bill-aviso" style="display:none;margin-top:5px;font-size:.78rem;font-weight:600;"></div>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label>Fecha *</label>
            <input type="date" class="form-control" id="rs-fecha" value="${ymd}">
          </div>
          <div class="form-group" style="grid-column:1/-1"><label>Notas</label>
            <input type="text" class="form-control" id="rs-notas" placeholder="Ej: Segundo pedido Amazon...">
          </div>
        </div>
        <div id="rs-preview" style="margin-top:12px;padding:10px 14px;background:var(--accent-light);border-radius:var(--radius-sm);font-size:.875rem;color:var(--accent2);display:flex;gap:20px;flex-wrap:wrap;">
          <div>Inversión nueva: <strong id="rs-inv-total">—</strong></div>
          <div>Costo unitario nuevo: <strong id="rs-inv-unit">—</strong></div>
          <div>Stock resultante: <strong id="rs-stock-result">—</strong></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeInvModal()">Cancelar</button>
        <button class="btn btn-success" onclick="confirmarRenovarStock('${invId}',${p.stockActual})"> Confirmar renovación</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
  setTimeout(calcRenovarPreview, 50);
}

function calcRenovarPreview() {
  const usd    = parseFloat(document.getElementById('rs-precio-usd')?.value)||0;
  const tasa   = parseFloat(document.getElementById('rs-tasa')?.value)||0;
  const nuevas = parseInt(document.getElementById('rs-unidades')?.value)||0;
  const env    = parseFloat(document.getElementById('rs-envio')?.value)||0;
  const otros  = parseFloat(document.getElementById('rs-otros')?.value)||0;
  const inv    = (usd*tasa*nuevas)+env+otros;
  const unit   = nuevas>0?inv/nuevas:0;
  const e1=document.getElementById('rs-inv-total');  if(e1) e1.textContent=fmtCOP(inv);
  const e2=document.getElementById('rs-inv-unit');   if(e2) e2.textContent=fmtCOP(unit);
  const e3=document.getElementById('rs-stock-result'); if(e3) e3.textContent=nuevas+' uds nuevas';

  // Aviso de saldo en tiempo real
  const billSel = document.getElementById('rs-billetera');
  const aviso   = document.getElementById('rs-bill-aviso');
  if (billSel && aviso && billSel.value && inv > 0) {
    const saldo = saldoBilletera(billSel.value);
    if (saldo < inv) {
      aviso.style.display = '';
      aviso.style.color = 'var(--red)';
      aviso.textContent = `Saldo insuficiente. Disponible: ${fmt(saldo)} — Necesario: ${fmtCOP(inv)}`;
    } else {
      aviso.style.display = '';
      aviso.style.color = 'var(--green)';
      aviso.textContent = `Saldo suficiente. Quedarán ${fmt(saldo - inv)} tras la compra`;
    }
  } else if (aviso) {
    aviso.style.display = 'none';
  }
}

async function confirmarRenovarStock(invId, stockActual) {
  const nuevas      = parseInt(document.getElementById('rs-unidades')?.value)||0;
  const precioUSD   = parseFloat(document.getElementById('rs-precio-usd')?.value)||0;
  const tasa        = parseFloat(document.getElementById('rs-tasa')?.value)||0;
  const envio       = parseFloat(document.getElementById('rs-envio')?.value)||0;
  const otros       = parseFloat(document.getElementById('rs-otros')?.value)||0;
  const precioV     = parseFloat(document.getElementById('rs-precio-venta')?.value)||0;
  const fecha       = document.getElementById('rs-fecha')?.value;
  const notas       = document.getElementById('rs-notas')?.value.trim();
  const billeteraId = document.getElementById('rs-billetera')?.value || '';

  if (!nuevas)    return toast('Ingresa la cantidad de unidades', 'error');
  if (!precioUSD) return toast('Ingresa el precio de compra en USD', 'error');
  if (!fecha)     return toast('La fecha es obligatoria', 'error');

  // Billetera obligatoria
  if (!billeteraId) {
    const sel = document.getElementById('rs-billetera');
    if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(()=>sel.style.border='',2000); }
    return toast('Debes seleccionar de qué billetera sale el dinero', 'error');
  }

  const idx = STATE.db.inversiones.findIndex(i=>i.id===invId);
  if (idx === -1) return toast('Inversión no encontrada', 'error');

  const inv = STATE.db.inversiones[idx];
  const inversionNueva = (precioUSD * tasa * nuevas) + envio + otros;

  // Validar saldo suficiente
  const saldo = saldoBilletera(billeteraId);
  if (saldo < inversionNueva) {
    const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
    return toast(`Saldo insuficiente en ${bill?.nombre||'billetera'}. Disponible: ${fmt(saldo)} — Necesario: ${fmtCOP(inversionNueva)}`, 'error');
  }

  // Actualizar inversión: sumar unidades (costos se leen de renovaciones[] en calcInversion)
  inv.unidades    = (inv.unidades || 0) + nuevas;
  inv.precioUSD   = precioUSD;
  inv.tasa        = tasa;
  if (precioV > 0) inv.precioSugerido = precioV;

  // Guardar en historial de renovaciones
  if (!inv.renovaciones) inv.renovaciones = [];
  inv.renovaciones.push({
    id: uid(), fecha, nuevasUnidades: nuevas,
    precioUSD, tasa, envio, otros, inversionNueva,
    billeteraId, notas: notas || ''
  });

  // Descontar de billetera
  const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
  STATE.db.gastos.push({
    id: uid(), fecha,
    hora: horaActual(),
    monto: Math.round(inversionNueva),
    desc: `Renovación stock: ${inv.nombre}${notas?' — '+notas:''}`,
    cat: 'Inversión',
    billeteraId,
    autoGenerado: true
  });

  closeInvModal();
  renderAll();
  await saveDb(['inversiones','gastos']);
  const bn = bill ? ` (de ${bill.nombre})` : '';
  toast(`Stock renovado: +${nuevas} uds · ${fmtCOP(inversionNueva)} descontado${bn} `, 'success');
}

// ─── These old single-file functions kept for backward compat ──
function saveInversion() { openModalNuevaInversion(); }
function openActualizarInversion() {}
function actualizarInversion() {}

// ─── Gasto adicional de inversión ────────────────────────────
function openModalGastoAdicionalInv(invId) {
  const inv = STATE.db.inversiones.find(i=>i.id===invId);
  if (!inv) return;
  const ymd = new Date().toISOString().slice(0,10);

  const billeterasOpts = (STATE.db.billeteras||[]).map(b => {
    const s = saldoBilletera(b.id);
    return `<option value="${b.id}" style="color:${s>0?'inherit':'var(--red)'}">
      ${BILL_ICONOS[b.tipo]||''} ${b.nombre} — ${fmt(s)}
    </option>`;
  }).join('');

  const overlay = document.getElementById('modal-inv-form-overlay');
  overlay.innerHTML = `
    <div class="modal" style="max-width:440px;width:100%;">
      <div class="modal-title">Gasto adicional — ${inv.nombre}
        <button onclick="closeInvModal()" style="float:right;background:none;border:none;font-size:1rem;color:var(--muted);cursor:pointer;">✕</button>
      </div>
      <div class="modal-body-wrap">
        <p style="color:var(--muted);font-size:.85rem;margin-bottom:16px;">
          Registra cualquier gasto relacionado con esta inversión: publicidad, empaque, envío local, comisiones, etc.
        </p>
        <div class="form-grid">
          <div class="form-group"><label>Fecha *</label>
            <input type="date" class="form-control" id="ga-fecha" value="${ymd}">
          </div>
          <div class="form-group"><label>Monto (COP) *</label>
            <input type="number" class="form-control" id="ga-monto" placeholder="0" min="1" oninput="calcGastoAdicPreview()">
          </div>
          <div class="form-group" style="grid-column:1/-1"><label>Concepto / Detalle *</label>
            <input type="text" class="form-control" id="ga-desc" placeholder="Ej: Publicidad Meta, empaque, envío local...">
          </div>
          <div class="form-group" style="grid-column:1/-1">
            <label> Dinero sale de *</label>
            <select class="form-control" id="ga-billetera" onchange="calcGastoAdicPreview()">
              <option value="">— Selecciona billetera (obligatorio) —</option>
              ${billeterasOpts}
            </select>
            <div id="ga-bill-aviso" style="display:none;margin-top:5px;font-size:.78rem;font-weight:600;"></div>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label>Notas adicionales</label>
            <input type="text" class="form-control" id="ga-notas" placeholder="Observaciones opcionales...">
          </div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeInvModal()">Cancelar</button>
        <button class="btn btn-danger" onclick="confirmarGastoAdicionalInv('${invId}')"> Registrar gasto</button>
      </div>
    </div>`;
  overlay.style.display = 'flex';
}

function calcGastoAdicPreview() {
  const monto   = parseFloat(document.getElementById('ga-monto')?.value)||0;
  const billSel = document.getElementById('ga-billetera');
  const aviso   = document.getElementById('ga-bill-aviso');
  if (!billSel || !aviso) return;
  if (billSel.value && monto > 0) {
    const saldo = saldoBilletera(billSel.value);
    if (saldo < monto) {
      aviso.style.display = '';
      aviso.style.color   = 'var(--red)';
      aviso.textContent   = `Saldo insuficiente. Disponible: ${fmt(saldo)} — Necesario: ${fmt(monto)}`;
    } else {
      aviso.style.display = '';
      aviso.style.color   = 'var(--green)';
      aviso.textContent   = `Saldo suficiente. Quedarán ${fmt(saldo - monto)} tras el gasto`;
    }
  } else {
    aviso.style.display = 'none';
  }
}

async function confirmarGastoAdicionalInv(invId) {
  const fecha       = document.getElementById('ga-fecha')?.value;
  const monto       = parseFloat(document.getElementById('ga-monto')?.value)||0;
  const desc        = document.getElementById('ga-desc')?.value.trim();
  const billeteraId = document.getElementById('ga-billetera')?.value || '';
  const notas       = document.getElementById('ga-notas')?.value.trim();

  if (!fecha)  return toast('La fecha es obligatoria', 'error');
  if (!monto)  return toast('El monto debe ser mayor a 0', 'error');
  if (!desc)   return toast('El concepto es obligatorio', 'error');
  if (!billeteraId) {
    const sel = document.getElementById('ga-billetera');
    if (sel) { sel.style.border='2px solid var(--red)'; setTimeout(()=>sel.style.border='',2000); }
    return toast('Debes seleccionar de qué billetera sale el dinero', 'error');
  }

  const saldo = saldoBilletera(billeteraId);
  if (saldo < monto) {
    const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
    return toast(`Saldo insuficiente en ${bill?.nombre||'billetera'}. Disponible: ${fmt(saldo)}`, 'error');
  }

  const idx = STATE.db.inversiones.findIndex(i=>i.id===invId);
  if (idx === -1) return toast('Inversión no encontrada', 'error');
  const inv = STATE.db.inversiones[idx];

  // Guardar en historial de gastos adicionales de la inversión
  if (!inv.gastosAdicionales) inv.gastosAdicionales = [];
  const gastoId = uid();
  inv.gastosAdicionales.push({ id: gastoId, fecha, monto, desc, billeteraId, notas: notas||'', hora: horaActual() });

  // Registrar como gasto real (descuenta de billetera)
  const bill = STATE.db.billeteras?.find(b=>b.id===billeteraId);
  STATE.db.gastos.push({
    id: uid(), fecha,
    hora: horaActual(),
    monto: Math.round(monto),
    desc: `Gasto inv. [${inv.nombre}]: ${desc}`,
    cat: 'Inversión',
    billeteraId,
    autoGenerado: true,
    invGastoId: gastoId
  });

  closeInvModal();
  renderDetalleInv(invId);
  await saveDb(['inversiones','gastos']);
  const bn = bill ? ` (de ${bill.nombre})` : '';
  toast(`Gasto registrado${bn}: ${fmt(monto)} `, 'success');
}

async function eliminarGastoAdicionalInv(gastoId, invId) {
  if (!confirm('¿Eliminar este gasto adicional?')) return;
  const inv = STATE.db.inversiones.find(i=>i.id===invId);
  if (!inv || !inv.gastosAdicionales) return;
  inv.gastosAdicionales = inv.gastosAdicionales.filter(g=>g.id!==gastoId);
  // También eliminar el gasto real vinculado
  STATE.db.gastos = STATE.db.gastos.filter(g=>g.invGastoId!==gastoId);
  renderDetalleInv(invId);
  await saveDb(['inversiones','gastos']);
  toast('Gasto eliminado', 'info');
}

/* ============================================================
   EXPORT
   ============================================================ */
/* ============================================================
   BILLETERAS — Dónde está tu dinero
   ============================================================ */

const BILL_ICONOS = {
  'Nequi':'N','Bancolombia':'BC','Efectivo':'$','Daviplata':'D',
  'Banco':'B','BBVA':'BB','Ahorro':'A','PayPal':'PP','Otro':'+'
};
const BILL_COLORS = {
  'Nequi':'var(--purple)','Bancolombia':'var(--yellow)','Efectivo':'var(--green)',
  'Daviplata':'var(--red)','Banco':'var(--accent)','BBVA':'var(--accent)',
  'Ahorro':'var(--teal)','PayPal':'var(--accent)','Otro':'var(--muted)'
};

function getBilleteras() { return STATE.db.billeteras || []; }

function saldoBilletera(id) {
  const b = getBilleteras().find(b => b.id === id);
  if (!b) return 0;
  let saldo = Number(b.saldoInicial || 0);
  // Incluir TODOS los ingresos y gastos (incluyendo transferencias antiguas del sistema viejo)
  saldo += STATE.db.ingresos.filter(i => i.billeteraId === id).reduce((a,i)=>a+Number(i.monto),0);
  saldo -= STATE.db.gastos.filter(g => g.billeteraId === id).reduce((a,g)=>a+Number(g.monto),0);
  // Transferencias nuevas (colección separada) — solo las que NO tienen ya un ingreso/gasto equivalente
  const transfs = (STATE.db.transferencias || []).filter(t => !t.legado);
  saldo -= transfs.filter(t => t.origenId === id).reduce((a,t)=>a+Number(t.monto),0);
  saldo += transfs.filter(t => t.destinoId === id).reduce((a,t)=>a+Number(t.monto),0);
  return saldo;
}

function openModalBilletera(id=null) {
  const b = id ? getBilleteras().find(b=>b.id===id) : null;
  const tipos = ['Nequi','Efectivo','Bancolombia','Daviplata','Banco','BBVA','Ahorro','PayPal','Otro'];

  // Usar modal estándar
  let mo = document.getElementById('modal-billetera');
  if (!mo) {
    mo = document.createElement('div');
    mo.className = 'modal-overlay';
    mo.id = 'modal-billetera';
    document.body.appendChild(mo);
    mo.addEventListener('click', e => { if (e.target === mo) mo.classList.remove('open'); });
  }

  mo.innerHTML = `
    <div class="modal" style="max-width:440px;width:100%;">
      <div class="modal-title" style="display:flex;align-items:center;gap:10px;padding:20px 24px;">
        <div style="width:36px;height:36px;background:#0f2d6b;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
        </div>
        <div>
          <div style="font-size:1rem;font-weight:700;color:var(--text);">${b?'Editar billetera':'Nueva billetera'}</div>
          <div style="font-size:.75rem;color:var(--muted);">${b?'Modifica los datos de tu cuenta':'Registra una cuenta o método de pago'}</div>
        </div>
        <button onclick="closeModal('modal-billetera')" style="margin-left:auto;background:none;border:none;font-size:1.2rem;color:var(--muted);cursor:pointer;">✕</button>
      </div>
      <div class="modal-body-wrap" style="padding:20px 24px;display:flex;flex-direction:column;gap:12px;">
        <div class="form-group">
          <label>Nombre *</label>
          <input type="text" class="form-control" id="fb-nombre" value="${b?.nombre||''}" placeholder="Ej: Nequi personal, Efectivo..." style="height:44px;width:100%;">
        </div>
        <div class="form-group">
          <label>Tipo</label>
          <select class="form-control" id="fb-tipo" style="height:44px;width:100%;">
            ${tipos.map(t=>`<option value="${t}" ${(b?.tipo||'Otro')===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Color</label>
          <select class="form-control" id="fb-color" style="height:44px;width:100%;">
            <option value="var(--accent)" ${(!b?.color||b?.color==='var(--accent)')?'selected':''}>Azul</option>
            <option value="var(--green)"  ${b?.color==='var(--green)'?'selected':''}>Verde</option>
            <option value="var(--purple)" ${b?.color==='var(--purple)'?'selected':''}>Morado</option>
            <option value="var(--red)"    ${b?.color==='var(--red)'?'selected':''}>Rojo</option>
            <option value="var(--yellow)" ${b?.color==='var(--yellow)'?'selected':''}>Amarillo</option>
            <option value="var(--teal)"   ${b?.color==='var(--teal)'?'selected':''}>Teal</option>
            <option value="var(--orange)" ${b?.color==='var(--orange)'?'selected':''}>Naranja</option>
          </select>
        </div>
        <div class="form-group">
          <label>Saldo inicial (COP)</label>
          <input type="number" class="form-control" id="fb-saldo" value="${b?.saldoInicial||0}" placeholder="0" style="height:44px;width:100%;">
          <small style="color:var(--muted);font-size:.72rem;">Cuánto tienes actualmente en esta cuenta</small>
        </div>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg2);">
          <input type="checkbox" id="fb-cobra4x1000" ${b?.cobra4x1000?'checked':''} style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;flex-shrink:0;">
          <div>
            <div style="font-weight:600;font-size:.88rem;">Cobra 4x1000 (GMF)</div>
            <div style="font-size:.72rem;color:var(--muted);margin-top:2px;">Para cuentas bancarias. El impuesto se registra automáticamente en cada retiro.</div>
          </div>
        </label>
      </div>
      <div class="modal-actions" style="padding:16px 24px;gap:10px;">
        <button class="btn btn-ghost" onclick="closeModal('modal-billetera')" style="flex:1;">Cancelar</button>
        <button onclick="guardarBilletera('${id||''}')" style="flex:2;background:#0f2d6b;color:#fff;border:none;border-radius:var(--radius-sm);padding:12px;font-size:.92rem;font-weight:700;cursor:pointer;">
          ${b?'Guardar cambios':'Crear billetera'}
        </button>
      </div>
    </div>`;
  mo.classList.add('open');
}

async function guardarBilletera(id='') {
  const cobra4x1000 = document.getElementById('fb-cobra4x1000')?.checked || false;
  const nombre = document.getElementById('fb-nombre')?.value.trim();
  const tipo   = document.getElementById('fb-tipo')?.value;
  const saldo  = parseFloat(document.getElementById('fb-saldo')?.value) || 0;
  const color  = document.getElementById('fb-color')?.value;

  if (!nombre) return toast('El nombre es obligatorio', 'error');

  if (id) {
    const idx = STATE.db.billeteras.findIndex(b=>b.id===id);
    if (idx !== -1) STATE.db.billeteras[idx] = { ...STATE.db.billeteras[idx], nombre, tipo, saldoInicial: saldo, color, cobra4x1000 };
    toast('Billetera actualizada', 'success');
  } else {
    STATE.db.billeteras.push({ id: uid(), nombre, tipo, saldoInicial: saldo, color, cobra4x1000 });
    
    toast('Billetera creada', 'success');
  }
  closeModal('modal-billetera');
  renderBilleteras();
  populateBilleteraSelects();
  await saveDb(['billeteras']);
  
}

async function deleteBilletera(id) {
  const b = getBilleteras().find(b=>b.id===id);
  if (!b) return;
  pedirPinParaAccion(`Eliminar "${b.nombre}"`, async () => {
    STATE.db.billeteras = STATE.db.billeteras.filter(x=>x.id!==id);
    renderBilleteras();
    populateBilleteraSelects();
    await saveDb(['billeteras']);
    toast('Billetera eliminada', 'info');
  });
}

// ─── Transferencia entre billeteras ──────────────────────────
function openModalTransferencia() {
  const list = getBilleteras();
  if (list.length < 2) {
    return toast('Necesitas al menos 2 billeteras para transferir', 'error');
  }

  // Poblar selects
  ['tr-origen','tr-destino'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = `<option value="">— Selecciona ${id==='tr-origen'?'origen':'destino'} —</option>`;
    list.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldoBilletera(b.id));
      sel.appendChild(opt);
    });
  });

  // Fecha por defecto = hoy
  const fechaEl = document.getElementById('tr-fecha');
  if (fechaEl) fechaEl.value = new Date().toISOString().slice(0,10);

  // Limpiar campos
  const montoEl = document.getElementById('tr-monto');
  const descEl  = document.getElementById('tr-desc');
  if (montoEl) montoEl.value = '';
  if (descEl)  descEl.value  = '';
  document.getElementById('tr-saldo-origen').textContent = '';
  document.getElementById('tr-saldo-post').style.display = 'none';

  // Listener origen para mostrar saldo disponible
  const origenSel = document.getElementById('tr-origen');
  origenSel.onchange = () => {
    const id = origenSel.value;
    const saldoEl = document.getElementById('tr-saldo-origen');
    if (id) {
      const s = saldoBilletera(id);
      saldoEl.textContent = 'Saldo disponible: ' + fmt(s);
      saldoEl.style.color = s > 0 ? 'var(--green)' : 'var(--red)';
    } else {
      saldoEl.textContent = '';
    }
    onTrMontoChange();
  };

  openModal('modal-transferencia');
}

function onTrMontoChange() {
  const origenId = document.getElementById('tr-origen')?.value;
  const monto    = parseFloat(document.getElementById('tr-monto')?.value) || 0;
  const postEl   = document.getElementById('tr-saldo-post');
  if (!postEl) return;
  if (origenId && monto > 0) {
    const saldoActual = saldoBilletera(origenId);
    const saldoPost   = saldoActual - monto;
    postEl.style.display = '';
    postEl.innerHTML = `Saldo restante en origen: <strong style="color:${saldoPost>=0?'var(--green)':'var(--red)'}">${fmt(saldoPost)}</strong>`;
  } else {
    postEl.style.display = 'none';
  }
}

function openModalTransferenciaDesde(billId) {
  openModalTransferencia();
  // Pre-seleccionar origen
  setTimeout(() => {
    const sel = document.getElementById('tr-origen');
    if (sel) {
      sel.value = billId;
      sel.dispatchEvent(new Event('change'));
    }
  }, 50);
}

async function ejecutarTransferencia() {
  const origenId  = document.getElementById('tr-origen')?.value;
  const destinoId = document.getElementById('tr-destino')?.value;
  const monto     = parseFloat(document.getElementById('tr-monto')?.value) || 0;
  const fecha     = document.getElementById('tr-fecha')?.value;
  const descExtra = document.getElementById('tr-desc')?.value.trim();

  if (!origenId)  {
    document.getElementById('tr-origen').style.border = '2px solid var(--red)';
    setTimeout(() => document.getElementById('tr-origen').style.border = '', 2000);
    return toast('Selecciona la billetera de origen', 'error');
  }
  if (!destinoId) {
    document.getElementById('tr-destino').style.border = '2px solid var(--red)';
    setTimeout(() => document.getElementById('tr-destino').style.border = '', 2000);
    return toast('Selecciona la billetera de destino', 'error');
  }
  if (origenId === destinoId) return toast('El origen y destino no pueden ser iguales', 'error');
  if (!monto || monto <= 0)  return toast('El monto debe ser mayor a 0', 'error');
  if (!fecha)                return toast('La fecha es obligatoria', 'error');

  const saldoOrigen = saldoBilletera(origenId);
  if (monto > saldoOrigen) {
    return toast(`Saldo insuficiente en origen. Disponible: ${fmt(saldoOrigen)}`, 'error');
  }

  const bOrigen  = getBilleteras().find(b=>b.id===origenId);
  const bDestino = getBilleteras().find(b=>b.id===destinoId);
  const hora     = horaActual();
  const label    = descExtra || `Transferencia ${bOrigen?.nombre} → ${bDestino?.nombre}`;

  // ── Guardar en colección separada "transferencias" ──
  // NO se registra como ingreso ni gasto para no afectar totales
  if (!STATE.db.transferencias) STATE.db.transferencias = [];
  STATE.db.transferencias.push({
    id: uid(), fecha, hora,
    monto,
    desc: label,
    origenId,
    destinoId,
    origenNombre: bOrigen?.nombre || '',
    destinoNombre: bDestino?.nombre || '',
  });

  closeModal('modal-transferencia');
  renderAll();
  await saveDb(['transferencias']);
  toast(`${fmt(monto)} transferido de ${bOrigen?.nombre} a ${bDestino?.nombre}`, 'success');
}

function verMovimientosBilletera(id) {
  const b = getBilleteras().find(b=>b.id===id);
  if (!b) return;

  const transfs = (STATE.db.transferencias||[]).filter(t=>!t.legado);
  const movs = [
    ...STATE.db.ingresos.filter(i=>i.billeteraId===id && i.cat!=='Transferencia').map(i=>({...i,tipo:'ingreso'})),
    ...STATE.db.gastos.filter(g=>g.billeteraId===id && g.cat!=='Transferencia').map(g=>({...g,tipo:'gasto'})),
    ...transfs.filter(t=>t.destinoId===id).map(t=>({
      id:t.id, fecha:t.fecha, hora:t.hora,
      fuente:`↙ Transferencia desde ${t.origenNombre}`,
      monto:t.monto, tipo:'transferencia-entrada'
    })),
    ...transfs.filter(t=>t.origenId===id).map(t=>({
      id:t.id, fecha:t.fecha, hora:t.hora,
      fuente:`↗ Transferencia a ${t.destinoNombre}`,
      monto:t.monto, tipo:'transferencia-salida'
    })),
  ]

  // Calcular saldo acumulado
  let saldoAcc = Number(b.saldoInicial||0);
  // Recorrer en orden cronológico para calcular saldo
  const movsOrden = [...movs].reverse();
  const saldos = [];
  movsOrden.forEach(m => {
    if (m.tipo === 'ingreso') saldoAcc += Number(m.monto);
    else saldoAcc -= Number(m.monto);
    saldos.push(saldoAcc);
  });
  saldos.reverse();

  const sec = document.getElementById('bill-movimientos');
  const title = document.getElementById('bill-mov-title');
  const tbody = document.getElementById('bill-mov-tbody');
  if (!sec) return;



  title.textContent = ` Movimientos — ${b.nombre}`;
  sec.style.display = '';

  if (!movs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;font-style:italic">Sin movimientos registrados aún</td></tr>';
    sec.scrollIntoView({ behavior:'smooth', block:'nearest' });
    return;
  }

  const esEntrada = m.tipo==='ingreso'||m.tipo==='transferencia-entrada';
  const color = esEntrada ? 'var(--green)' : 'var(--red)';
  const badgeClass = esEntrada ? 'badge-green' : 'badge-red';
  const badgeLabel = m.tipo==='transferencia-entrada' ? '↙ entrada'
                  : m.tipo==='transferencia-salida'  ? '↗ salida'
                  : m.tipo==='ingreso' ? 'Ingreso' : 'Gasto';
  const signo = esEntrada ? '+' : '-';

  tbody.innerHTML = movs.map((m,i) => `
    <tr>
      <td style="white-space:nowrap">${m.fecha||'—'}</td>
      <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">${m.hora||'—'}</td>
      <td>${m.fuente||m.desc||'—'}</td>
      <td><span class="badge ${m.tipo==='ingreso'?'badge-green':'badge-red'}">${m.cat==='Transferencia'?'↺ transferencia':m.tipo}</span></td>
      <td style="color:${m.tipo==='ingreso'?'var(--green)':'var(--red)'};font-weight:600;white-space:nowrap">
        ${m.tipo==='ingreso'?'+':'-'}${fmt(m.monto)}
      </td>
      <td style="font-weight:600;white-space:nowrap;color:${saldos[i]>=0?'var(--text)':'var(--red)'}">${fmt(saldos[i])}</td>
    </tr>`).join('');

  sec.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

// ── Modal Nuevo Ingreso (módulo unificado) ──
function openModalNuevoIngreso() {
  const sel = document.getElementById('mi-billetera');
  const montoEl = document.getElementById('mi-monto');

  if (montoEl) {
    montoEl.value = '';
    montoEl.oninput = () => onMiBilleteraChange();
  }

  if (sel) {
    sel.innerHTML = '<option value="">— Selecciona billetera —</option>';
    getBilleteras().forEach(b => {
      const o = document.createElement('option');
      o.value = b.id;
      o.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldoBilletera(b.id));
      sel.appendChild(o);
    });
    sel.onchange = () => onMiBilleteraChange();
  }

  if (document.getElementById('mi-fuente')) document.getElementById('mi-fuente').value = '';
  if (document.getElementById('mi-fecha')) document.getElementById('mi-fecha').value = new Date().toISOString().slice(0,10);
  if (document.getElementById('mi-saldo-info')) document.getElementById('mi-saldo-info').style.display = 'none';

  openModal('modal-nuevo-ingreso');
}

async function saveIngresoModal() {
  const monto = getMontoValue('mi-monto');
  const fuente = document.getElementById('mi-fuente').value.trim();
  const fecha = document.getElementById('mi-fecha').value;
  const cat = document.getElementById('mi-cat').value;
  const billeteraId = document.getElementById('mi-billetera').value;
  if (!monto || monto <= 0) return toast('El monto debe ser mayor a 0', 'error');
  if (!fuente) return toast('La descripción es obligatoria', 'error');
  if (!fecha) return toast('La fecha es obligatoria', 'error');
  STATE.db.ingresos.push({ id:uid(), fecha, hora:horaActual(), monto, fuente, cat, billeteraId });
  closeModal('modal-nuevo-ingreso');
  showLoading();
  await saveDb(['ingresos']);
  hideLoading();
  renderAll();
  toast('Ingreso registrado ', 'success');
}

function openModalNuevoGasto() {
  const sel = document.getElementById('mg-billetera');
  const fechaEl = document.getElementById('mg-fecha');
  const montoEl = document.getElementById('mg-monto');

  if (fechaEl) fechaEl.value = new Date().toISOString().slice(0,10);
  if (montoEl) {
    montoEl.value = '';
    // Recarga el select cada vez que cambia el monto
    montoEl.oninput = () => {
      calcularPreview4x1000();
      poblarBilleterasGasto();
      onMgBilleteraChange();
    };
  }
  if (document.getElementById('mg-desc')) document.getElementById('mg-desc').value = '';
  if (document.getElementById('mg-4x1000-preview')) document.getElementById('mg-4x1000-preview').style.display = 'none';
  if (document.getElementById('mg-saldo-info')) document.getElementById('mg-saldo-info').style.display = 'none';

  poblarBilleterasGasto();
  openModal('modal-nuevo-gasto');
}

function poblarBilleterasGasto() {
  const sel = document.getElementById('mg-billetera');
  if (!sel) return;

  const monto = getMontoValue('mg-monto');
  const valorAnterior = sel.value;

  sel.innerHTML = '<option value="">— Selecciona billetera —</option>';

  const billeteras = getBilleteras();
  let hayAlguna = false;

  billeteras.forEach(b => {
    const saldo = saldoBilletera(b.id);
    const alcanza = monto === 0 || saldo >= monto;
    const opt = document.createElement('option');
    opt.value = b.id;

    if (alcanza) {
      opt.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldo);
      hayAlguna = true;
    } else {
      opt.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — Saldo insuficiente (' + fmt(saldo) + ')';
      opt.disabled = true;
      opt.style.color = '#999';
    }

    // Restaurar selección previa si sigue siendo válida
    if (b.id === valorAnterior && alcanza) opt.selected = true;

    sel.appendChild(opt);
  });

  // Si el monto es mayor a lo que tiene cualquier billetera, mostrar aviso
  const aviso = document.getElementById('mg-sin-saldo-aviso');
  if (aviso) {
    if (monto > 0 && !hayAlguna) {
      aviso.style.display = 'flex';
      aviso.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        Ninguna billetera tiene ${fmt(monto)} disponibles. Reduce el monto o recarga una billetera.
      `;
    } else {
      aviso.style.display = 'none';
    }
  }

  // Si la billetera seleccionada ya no es válida, resetear
  if (valorAnterior && sel.value !== valorAnterior) {
    sel.value = '';
    if (document.getElementById('mg-saldo-info')) {
      document.getElementById('mg-saldo-info').style.display = 'none';
    }
  }
}

function onMiBilleteraChange() {
  const sel = document.getElementById('mi-billetera');
  const info = document.getElementById('mi-saldo-info');
  if (!sel || !info) return;
  if (!sel.value) { info.style.display = 'none'; return; }

  const s = saldoBilletera(sel.value);
  const monto = getMontoValue('mi-monto');
  const saldoPost = s + monto;

  info.style.display = 'flex';
  info.style.flexDirection = 'column';
  info.style.gap = '6px';
  info.style.background = 'var(--green-light)';
  info.style.padding = '10px 12px';
  info.style.borderRadius = 'var(--radius-sm)';
  info.style.border = '1px solid rgba(5,150,105,.2)';

  info.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--muted);font-size:.78rem;">Saldo actual</span>
      <strong style="color:var(--green)">${fmt(s)}</strong>
    </div>
    ${monto > 0 ? `
    <div style="height:1px;background:rgba(0,0,0,.06);"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--muted);font-size:.78rem;">+ Ingreso</span>
      <strong style="color:var(--green);font-size:.82rem;">+${fmt(monto)}</strong>
    </div>
    <div style="height:1px;background:rgba(0,0,0,.1);"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--text);font-size:.82rem;font-weight:600;">Quedaría en </span>
      <strong style="color:var(--green);font-size:1rem;">${fmt(saldoPost)}</strong>
    </div>
    ` : ''}
  `;
}

function onMgBilleteraChange() {
  const sel = document.getElementById('mg-billetera');
  const info = document.getElementById('mg-saldo-info');
  if (!sel || !info) return;
  if (!sel.value) { info.style.display = 'none'; return; }

  const s = saldoBilletera(sel.value);
  const monto = getMontoValue('mg-monto');
  const saldoPost = s - monto;
  const alcanza = monto === 0 || saldoPost >= 0;

  info.style.display = 'flex';
  info.style.flexDirection = 'column';
  info.style.gap = '6px';
  info.style.background = alcanza ? 'var(--green-light)' : 'var(--red-light)';
  info.style.padding = '10px 12px';
  info.style.borderRadius = 'var(--radius-sm)';
  info.style.border = `1px solid ${alcanza ? 'rgba(5,150,105,.2)' : 'rgba(220,38,38,.2)'}`;

  info.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--muted);font-size:.78rem;">Saldo disponible</span>
      <strong style="color:${s > 0 ? 'var(--green)' : 'var(--red)'}">${fmt(s)}</strong>
    </div>
    ${monto > 0 ? `
    <div style="height:1px;background:rgba(0,0,0,.06);"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--muted);font-size:.78rem;">Quedaría después</span>
      <strong style="color:${alcanza ? 'var(--green)' : 'var(--red)'};font-size:.95rem;">${fmt(saldoPost)}</strong>
    </div>
     ` : ''}
  `;
}

function calcularPreview4x1000() {
  const monto = getMontoValue('mg-monto');
  const billId = document.getElementById('mg-billetera')?.value;
  const preview = document.getElementById('mg-4x1000-preview');
  const texto = document.getElementById('mg-4x1000-texto');
  if (!preview || !texto) return;
  const bill = getBilleteras().find(b=>b.id===billId);
  if (bill?.cobra4x1000 && monto > 0) {
    const gmf = Math.round(monto * 0.004);
    texto.textContent = `⚠️ Esta billetera cobra 4x1000. Se registrará ${fmt(gmf)} adicional como impuesto.`;
    preview.style.display = '';
  } else {
    preview.style.display = 'none';
  }
}

// Estado de visibilidad de balances en movimientos
let _movBalancesVisible = false;

function toggleMovBalances() {
  _movBalancesVisible = !_movBalancesVisible;
  renderMovimientos();
}

function setMovRangoMesActual() {
  const hoy = new Date();
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth()+1).padStart(2,'0');
  const primerDia = `${y}-${m}-01`;
  const ultimoDia = new Date(y, hoy.getMonth()+1, 0);
  const ult = `${y}-${m}-${String(ultimoDia.getDate()).padStart(2,'0')}`;
  const desde = document.getElementById('mov-filter-desde');
  const hasta = document.getElementById('mov-filter-hasta');
  if (desde) desde.value = primerDia;
  if (hasta) hasta.value = ult;
  renderMovimientos();
}

function clearMovRango() {
  const desde = document.getElementById('mov-filter-desde');
  const hasta = document.getElementById('mov-filter-hasta');
  if (desde) desde.value = '';
  if (hasta) hasta.value = '';
  renderMovimientos();
}

function renderMovimientos() {
  const filtroTipo  = document.getElementById('mov-filter-tipo')?.value || '';
  const filtroDesde = document.getElementById('mov-filter-desde')?.value || '';
  const filtroHasta = document.getElementById('mov-filter-hasta')?.value || '';
  const filtroCat   = document.getElementById('mov-filter-cat')?.value || '';
  const filtroText  = (document.getElementById('mov-filter-search')?.value || '').toLowerCase();

  let items = [
    ...STATE.db.ingresos.filter(i=>i.cat!=='Transferencia').map(i=>({...i,tipo:'ingreso'})),
    ...STATE.db.gastos.filter(g=>g.cat!=='Transferencia').map(g=>({...g,tipo:'gasto'})),
  ].sort((a,b)=>{
    const fd=(b.fecha||'').localeCompare(a.fecha||'');
    if (fd !== 0) return fd;
    const hd = convertirHora(b.hora) - convertirHora(a.hora);
    if (hd !== 0) return hd;
    // Desempate por timestamp exacto (garantiza gasto antes que su 4x1000)
    return (b.ts||0) - (a.ts||0);
  });

  if (filtroTipo)   items = items.filter(i=>i.tipo===filtroTipo);
  if (filtroDesde)  items = items.filter(i=>(i.fecha||'') >= filtroDesde);
  if (filtroHasta)  items = items.filter(i=>(i.fecha||'') <= filtroHasta);
  if (filtroCat)    items = items.filter(i=>i.cat===filtroCat);
  if (filtroText)   items = items.filter(i=>(i.fuente||i.desc||'').toLowerCase().includes(filtroText)||(i.cat||'').toLowerCase().includes(filtroText));

  // Poblar cats
  const cats = [...new Set([
    ...STATE.db.ingresos.map(i=>i.cat),
    ...STATE.db.gastos.map(g=>g.cat)
  ].filter(c=>c && c!=='Transferencia'))].sort();
  const catSel = document.getElementById('mov-filter-cat');
  if (catSel) {
    const cur = catSel.value;
    catSel.innerHTML = '<option value="">Todas las categorías</option>';
    cats.forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      if (c===cur) o.selected=true;
      catSel.appendChild(o);
    });
  }

  const totalIng = items.filter(i=>i.tipo==='ingreso').reduce((a,i)=>a+Number(i.monto),0);
  const totalGas = items.filter(i=>i.tipo==='gasto').reduce((a,i)=>a+Number(i.monto),0);
  const balance  = totalIng - totalGas;

  const resumen = document.getElementById('mov-resumen');
  if (resumen) {
    const eyeOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const eyeClosed = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    const mask = '•••••';
    resumen.innerHTML = `<div style="display:flex;align-items:center;gap:14px;padding:4px 0;flex-wrap:wrap;">
      <span style="color:var(--muted);font-size:.8rem;font-weight:600;">${items.length} mov.</span>
      <span style="font-size:.8rem;color:var(--muted);">Ingresos: <strong style="color:var(--green);">${_movBalancesVisible ? fmt(totalIng) : mask}</strong></span>
      <span style="font-size:.8rem;color:var(--muted);">Gastos: <strong style="color:var(--red);">${_movBalancesVisible ? fmt(totalGas) : mask}</strong></span>
      <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
        <button onclick="toggleMovBalances()" style="background:none;border:1px solid var(--border);border-radius:8px;padding:3px 10px;cursor:pointer;color:var(--muted);display:flex;align-items:center;gap:5px;font-size:.78rem;">
          ${_movBalancesVisible ? eyeOpen : eyeClosed} ${_movBalancesVisible ? 'Ocultar' : 'Mostrar'}
        </button>
        <button onclick="clearMovFilters()" title="Limpiar filtros" style="background:none;border:1px solid var(--border);border-radius:8px;padding:3px 8px;cursor:pointer;color:var(--muted);font-size:.78rem;line-height:1;">&#x2715;</button>
      </div>
    </div>`;
  }

  const lista = document.getElementById('mov-lista');
  if (!lista) return;
  if (!items.length) {
    lista.innerHTML = '<p style="text-align:center;color:var(--muted);padding:32px;">Sin movimientos para el período seleccionado</p>';
    return;
  }

  // Agrupar por fecha
  const grupos = {};
  items.forEach(i => { (grupos[i.fecha]||=[]).push(i); });

  lista.innerHTML = Object.entries(grupos).sort((a,b)=>b[0].localeCompare(a[0])).map(([fecha, movs]) => {
    const fechaLabel = (() => {
      const d = new Date(fecha+'T12:00:00');
      return d.toLocaleDateString('es-CO',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    })();
    return `<div style="margin-bottom:16px;">
      <div style="font-size:.78rem;color:var(--muted);font-weight:600;padding:6px 0;border-bottom:1px solid var(--border);margin-bottom:4px;text-transform:capitalize;">${fechaLabel}</div>
      ${movs.map(m => {
        const esIng = m.tipo==='ingreso';
        const label = m.fuente || m.desc || '—';
        const montoMostrar = `${esIng?'+':'-'}${fmt(m.monto)}`;
        const billNombre = STATE.db.billeteras?.find(b=>b.id===m.billeteraId)?.nombre || '';
        const procedencia = esIng
          ? (billNombre ? `→ ${billNombre}` : '')
          : (billNombre ? `← ${billNombre}` : '');
        return `<div style="display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--border);">
          <div style="width:38px;height:38px;border-radius:50%;background:${esIng?'var(--green)':'var(--red)'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:1rem;flex-shrink:0;">
            ${esIng?'↑':'↓'}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:.92rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</div>
            <div style="font-size:.74rem;color:var(--muted);margin-top:2px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
              ${m.cat ? `<span style="background:var(--bg2);border-radius:4px;padding:1px 6px;">${m.cat}</span>` : ''}
              ${procedencia ? `<span style="color:var(--accent);font-weight:600;">${procedencia}</span>` : ''}
              ${m.hora ? `<span style="opacity:.7;">${m.hora}</span>` : ''}
            </div>
          </div>
          <div style="font-weight:700;font-size:.95rem;color:${esIng?'var(--green)':'var(--red)'};white-space:nowrap;flex-shrink:0;">
            ${montoMostrar}
          </div>
          <button onclick="abrirEditarMov('${m.tipo}','${m.id}')" title="Editar" style="background:none;border:none;cursor:pointer;color:var(--light);padding:4px 6px;border-radius:6px;flex-shrink:0;transition:color .15s;" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--light)'">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button onclick="pedirCodigoEliminarMov('${m.tipo}','${m.id}')" title="Eliminar" style="background:none;border:none;cursor:pointer;color:var(--light);padding:4px 6px;border-radius:6px;flex-shrink:0;transition:color .15s;" onmouseover="this.style.color='var(--red)'" onmouseout="this.style.color='var(--light)'">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}

function abrirEditarMov(tipo, id) {
  const item = tipo === 'ingreso'
    ? STATE.db.ingresos.find(i => i.id === id)
    : STATE.db.gastos.find(g => g.id === id);
  if (!item) return;

  const esIng = tipo === 'ingreso';
  const color = esIng ? '#0f2d6b' : '#7f0000';
  const flechaSVG = esIng
    ? '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'
    : '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>';

  // Header dinámico
  document.getElementById('em-header-icon').style.background = color;
  document.getElementById('em-header-icon').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${flechaSVG}</svg>`;
  document.getElementById('em-titulo').textContent    = esIng ? 'Editar ingreso' : 'Editar gasto';
  document.getElementById('em-subtitulo').textContent = esIng ? 'El dinero entrará a la billetera seleccionada' : 'El dinero saldrá de la billetera seleccionada';
  document.getElementById('em-monto-label').textContent = esIng ? 'Monto a ingresar' : 'Monto del gasto';
  document.getElementById('em-bill-label').textContent  = esIng ? 'Entra a' : 'Sale de';

  // Botón guardar con color del tipo
  const btn = document.getElementById('em-btn-guardar');
  btn.style.background = color;
  btn.style.color = '#fff';
  document.getElementById('em-btn-icon').innerHTML = flechaSVG;

  // Datos
  document.getElementById('em-id').value    = id;
  document.getElementById('em-tipo').value  = tipo;
  const emInput = document.getElementById('em-monto');
  emInput.value = item.monto ? String(parseInt(item.monto)) : '';
  document.getElementById('em-desc').value  = item.fuente || item.desc || '';
  document.getElementById('em-fecha').value = item.fecha || '';
  document.getElementById('em-hora').value  = horaToInputTime(item.hora || '');

  // Disparar formato visual del monto
  fmtMontoInput(document.getElementById('em-monto'));

  // Poblar billeteras con saldo
  const selBill = document.getElementById('em-billetera');
  selBill.innerHTML = '<option value="">— Sin billetera —</option>';
  getBilleteras().forEach(b => {
    const o = document.createElement('option');
    o.value = b.id;
    const saldo = saldoBilletera(b.id);
    o.textContent = `${b.nombre}  —  ${fmt(saldo)}`;
    if (b.id === item.billeteraId) {
      o.selected = true;
      o.style.fontWeight = '700';
    }
    selBill.appendChild(o);
  });

  // Info de saldo bajo el select
  const updateSaldoInfo = () => {
    let info = document.getElementById('em-saldo-info');
    if (!info) {
      info = document.createElement('div');
      info.id = 'em-saldo-info';
      info.style.cssText = 'margin-top:6px;padding:8px 12px;background:var(--bg2);border-radius:var(--radius-sm);font-size:.82rem;color:var(--muted);display:flex;align-items:center;justify-content:space-between;';
      selBill.parentNode.appendChild(info);
    }
    const bid = selBill.value;
    if (!bid) { info.style.display = 'none'; return; }
    const bill = getBilleteras().find(b => b.id === bid);
    const s = saldoBilletera(bid);
    const esActual = bid === item.billeteraId;
    info.style.display = 'flex';
    info.innerHTML = `<span>${bill?.nombre || ''}${esActual ? ' <span style="font-size:.7rem;background:var(--accent-light);color:var(--accent);border-radius:4px;padding:1px 5px;font-weight:700;">actual</span>' : ''}</span><strong style="color:${s>=0?'var(--green)':'var(--red)'};">${fmt(s)}</strong>`;
  };
  selBill.onchange = updateSaldoInfo;
  updateSaldoInfo();

  // Poblar categorías según tipo
  const selCat = document.getElementById('em-cat');
  const cats = esIng
    ? ['Salario','Freelance','Negocio','Inversión','Arriendo','Otro']
    : ['Alimentación','Transporte','Salud','Servicios','Educación','Entretenimiento','Ropa','Hogar','Negocio','Impuestos','Otro'];
  selCat.innerHTML = cats.map(c =>
    `<option value="${c}" ${c === item.cat ? 'selected' : ''}>${c}</option>`
  ).join('');

  openModal('modal-editar-mov');
}

async function guardarEdicionMov() {
  const id        = document.getElementById('em-id').value;
  const tipo      = document.getElementById('em-tipo').value;
  const monto     = getMontoValue('em-monto');
  const desc      = document.getElementById('em-desc').value.trim();
  const fecha     = document.getElementById('em-fecha').value;
  const cat       = document.getElementById('em-cat').value;
  const billId    = document.getElementById('em-billetera').value;
  const horaRaw   = document.getElementById('em-hora').value;
  const hora      = horaRaw ? inputTimeToHora(horaRaw) : null;

  if (!monto || monto <= 0) return toast('El monto debe ser mayor a 0', 'error');
  if (!desc)                return toast('La descripción es obligatoria', 'error');

  closeModal('modal-editar-mov');
  showLoading();

  if (tipo === 'ingreso') {
    const idx = STATE.db.ingresos.findIndex(i => i.id === id);
    if (idx === -1) { hideLoading(); return; }
    STATE.db.ingresos[idx] = { ...STATE.db.ingresos[idx], monto, fuente: desc, fecha, cat, billeteraId: billId, ...(hora && { hora }) };
    await saveDb(['ingresos']);
  } else {
    const idx = STATE.db.gastos.findIndex(g => g.id === id);
    if (idx === -1) { hideLoading(); return; }
    STATE.db.gastos[idx] = { ...STATE.db.gastos[idx], monto, desc, fecha, cat, billeteraId: billId, ...(hora && { hora }) };
    await saveDb(['gastos']);
  }

  hideLoading();
  renderAll();
  toast('Movimiento actualizado ', 'success');
}

function pedirCodigoEliminarMov(tipo, id) {
  const modal = document.getElementById('modal-eliminar-mov');
  if (!modal) return;
  // Guardar datos en el modal
  modal.dataset.tipo = tipo;
  modal.dataset.id   = id;
  // Limpiar input y error
  const inp = document.getElementById('mov-del-codigo');
  const err = document.getElementById('mov-del-error');
  if (inp) { inp.value = ''; }
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  modal.classList.add('open');
  setTimeout(() => { if (inp) inp.focus(); }, 150);
}

async function confirmarEliminarMov() {
  const modal = document.getElementById('modal-eliminar-mov');
  const inp   = document.getElementById('mov-del-codigo');
  const err   = document.getElementById('mov-del-error');
  if (!modal || !inp) return;

  const entered = inp.value.trim();
  const enteredHash = await sha256(entered);
  const u = window.__CURRENT_USER;
  let correctHash;
  if (!u || u.isAdmin) {
    correctHash = localStorage.getItem('fp_pin_hash');
  } else {
    try { correctHash = await window.__FB.loadPin(); } catch(e) { correctHash = null; }
  }
  if (enteredHash !== correctHash) {
    if (err) { err.textContent = 'PIN incorrecto.'; err.style.display = 'block'; }
    inp.value = '';
    inp.focus();
    inp.classList.add('mov-del-shake');
    setTimeout(() => inp.classList.remove('mov-del-shake'), 500);
    return;
  }

  const tipo = modal.dataset.tipo;
  const id   = modal.dataset.id;
  modal.classList.remove('open');

  showLoading();
  if (tipo === 'ingreso') {
    STATE.db.ingresos = STATE.db.ingresos.filter(i => i.id !== id);
    await saveDb(['ingresos']);
  } else {
    STATE.db.gastos = STATE.db.gastos.filter(g => g.id !== id);
    await saveDb(['gastos']);
  }
  hideLoading();
  renderAll();
  toast('Movimiento eliminado', 'info');
}

function cancelarEliminarMov() {
  const modal = document.getElementById('modal-eliminar-mov');
  if (modal) modal.classList.remove('open');
}

/* ============================================================
   MULTI-USUARIO
   ============================================================ */
const MODULOS_DISPONIBLES = [
  { id: 'movimientos', label: 'Movimientos' },
  { id: 'deudas',      label: 'Deudas' },
  { id: 'prestamos',   label: 'Préstamos' },
  { id: 'fijos',       label: 'Gastos Fijos' },
  { id: 'inversiones', label: 'Inversiones' },
  { id: 'billeteras',  label: 'Billeteras' },
  { id: 'reportes',    label: 'Reportes' },
  { id: 'claves',      label: 'Contraseñas' },
];

function renderConfigUsuarios() {
  cargarPerfil(); // refrescar nombre/foto al entrar a config
  const section = document.getElementById('config-usuarios-section');
  const lista   = document.getElementById('config-usuarios-lista');
  if (!section) return;
  const user = window.__CURRENT_USER;
  if (!user || !user.isAdmin) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (!lista) return;
  lista.innerHTML = '<p style="color:var(--muted);font-size:.85rem;">Cargando...</p>';

  window.__FB.getUsuarios().then(usuarios => {
    if (!usuarios.length) {
      lista.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:16px;">No hay usuarios creados aún.</p>';
      return;
    }
    lista.innerHTML = usuarios.map(u => {
      const activo = u.activo !== false;
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);opacity:${activo?1:.5};">
        <div style="width:36px;height:36px;border-radius:50%;background:${activo?'var(--accent-light)':'var(--bg2)'};display:flex;align-items:center;justify-content:center;font-weight:700;color:${activo?'var(--accent)':'var(--muted)'};font-size:.9rem;flex-shrink:0;">
          ${(u.nombre||'?')[0].toUpperCase()}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:.9rem;">${u.nombre}</div>
          <div style="font-size:.72rem;color:var(--muted);">${activo?'Activo':'Desactivado'} · ${(u.modulos||[]).length||'Todos'} módulos</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="abrirEditarUsuario('${u.id}')" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer;color:var(--accent);font-size:.75rem;font-weight:600;">Editar</button>
          <button onclick="pedirCodigoDesactivar('${u.id}','${u.nombre}',${activo})" style="background:none;border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer;color:${activo?'var(--red)':'var(--green)'};font-size:.75rem;font-weight:600;">${activo?'Desactivar':'Activar'}</button>
        </div>
      </div>`;
    }).join('');
  });
}

function abrirModalNuevoUsuario() {
  document.getElementById('nu-nombre').value = '';
  document.getElementById('nu-pin').value = '';
  openModal('modal-nuevo-usuario');
}

async function guardarNuevoUsuario() {
  const nombre = document.getElementById('nu-nombre').value.trim();
  const pin    = document.getElementById('nu-pin').value.trim();
  if (!nombre) return toast('El nombre es obligatorio', 'error');
  if (pin.length !== 4 || !/^\d+$/.test(pin)) return toast('El PIN debe ser 4 dígitos', 'error');
  const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5);
  const pinHash = await sha256(pin);
  showLoading();
  try {
    await window.__FB.createUsuario(id, nombre, pinHash);
    hideLoading();
    closeModal('modal-nuevo-usuario');
    toast(`Usuario "${nombre}" creado `, 'success');
    renderConfigUsuarios();
  } catch(e) {
    hideLoading();
    toast('Error creando usuario', 'error');
    console.error(e);
  }
}

// ── Editar usuario ──
let _editUserId = null;
async function abrirEditarUsuario(id) {
  const usuarios = await window.__FB.getUsuarios();
  const u = usuarios.find(x => x.id === id);
  if (!u) return;
  _editUserId = id;
  document.getElementById('eu-nombre').value = u.nombre || '';
  // Poblar checkboxes de módulos
  const cont = document.getElementById('eu-modulos');
  const activos = u.modulos || MODULOS_DISPONIBLES.map(m => m.id); // si no tiene, todos activos
  cont.innerHTML = MODULOS_DISPONIBLES.map(m => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:.85rem;">
      <input type="checkbox" value="${m.id}" ${activos.includes(m.id)?'checked':''} style="width:16px;height:16px;accent-color:var(--accent);">
      ${m.label}
    </label>`).join('');
  openModal('modal-editar-usuario');
}

async function guardarEdicionUsuario() {
  if (!_editUserId) return;
  const nombre = document.getElementById('eu-nombre').value.trim();
  if (!nombre) return toast('El nombre es obligatorio', 'error');
  const modulosChecked = [...document.getElementById('eu-modulos').querySelectorAll('input:checked')].map(i => i.value);
  showLoading();
  try {
    const { setDoc, doc } = window.__FB;
    await window.__FB.updateUsuario(_editUserId, { nombre, modulos: modulosChecked });
    hideLoading();
    closeModal('modal-editar-usuario');
    toast('Usuario actualizado ', 'success');
    renderConfigUsuarios();
  } catch(e) {
    hideLoading();
    toast('Error actualizando usuario', 'error');
    console.error(e);
  }
}

// ── Desactivar/Activar con código ──
let _toggleUserId = null, _toggleNombre = null, _toggleActivo = null;
function pedirCodigoDesactivar(id, nombre, activo) {
  _toggleUserId = id; _toggleNombre = nombre; _toggleActivo = activo;
  const inp = document.getElementById('du-codigo');
  const err = document.getElementById('du-error');
  const titulo = document.getElementById('du-titulo');
  if (inp) inp.value = '';
  if (err) { err.style.display='none'; err.textContent=''; }
  if (titulo) titulo.textContent = activo ? `Desactivar a "${nombre}"` : `Activar a "${nombre}"`;
  openModal('modal-desactivar-usuario');
  setTimeout(() => { if(inp) inp.focus(); }, 150);
}

async function confirmarDesactivarUsuario() {
  const entered2 = document.getElementById('du-codigo').value.trim();
  const err    = document.getElementById('du-error');
  const enteredHash2 = await sha256(entered2);
  const correctHash2 = localStorage.getItem('fp_pin_hash'); // solo admin puede desactivar
  if (enteredHash2 !== correctHash2) {
    if (err) { err.textContent='PIN incorrecto.'; err.style.display='block'; }
    document.getElementById('du-codigo').value = '';
    document.getElementById('du-codigo').classList.add('mov-del-shake');
    setTimeout(() => document.getElementById('du-codigo').classList.remove('mov-del-shake'), 500);
    return;
  }
  closeModal('modal-desactivar-usuario');
  showLoading();
  try {
    await window.__FB.updateUsuario(_toggleUserId, { activo: !_toggleActivo });
    hideLoading();
    toast(`Usuario "${_toggleNombre}" ${_toggleActivo ? 'desactivado' : 'activado'}`, 'info');
    renderConfigUsuarios();
  } catch(e) {
    hideLoading();
    toast('Error actualizando usuario', 'error');
  }
}

function openModalNuevaDeuda() {
  // Limpiar campos
  ['d-nombre','d-total','d-cuota','d-interes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('d-fecha').value = today;
  document.getElementById('d-prox').value  = today;
  document.getElementById('d-tipo').value  = 'compra';
  onDeudaTipoChange();
  openModal('modal-nueva-deuda');
}

function clearMovFilters() {
  ['mov-filter-tipo','mov-filter-cat'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  const s=document.getElementById('mov-filter-search'); if(s) s.value='';
  clearMovRango();
}

async function saveGastoModal() {
  const monto = getMontoValue('mg-monto');
  const desc = document.getElementById('mg-desc').value.trim();
  const fecha = document.getElementById('mg-fecha').value;
  const cat = document.getElementById('mg-cat').value;
  const billeteraId = document.getElementById('mg-billetera').value;

  if (!monto || monto <= 0) return toast('El monto debe ser mayor a 0', 'error');
  if (!desc) return toast('La descripción es obligatoria', 'error');
  if (!billeteraId) return toast('Selecciona la billetera', 'error');

  // Validar saldo suficiente
  const saldo = saldoBilletera(billeteraId);
  if (monto > saldo) {
    const bill = getBilleteras().find(b => b.id === billeteraId);
    // Marcar el select en rojo
    const sel = document.getElementById('mg-billetera');
    if (sel) { sel.style.border = '2px solid var(--red)'; setTimeout(() => sel.style.border = '', 2500); }
    return toast(`Saldo insuficiente en ${bill?.nombre || 'la billetera'}. Disponible: ${fmt(saldo)} — Necesitas: ${fmt(monto)}`, 'error');
  }

  const bill = getBilleteras().find(b => b.id === billeteraId);
  const cobra4x1000 = bill?.cobra4x1000 || false;
  const gmf = cobra4x1000 ? Math.round(monto * 0.004) : 0;

  const _ts = Date.now();
  STATE.db.gastos.push({ id: uid(), fecha, hora: horaActual(), monto, desc, cat, billeteraId, ts: _ts });
  if (gmf > 0) {
    STATE.db.gastos.push({
      id: uid(), fecha, hora: horaActual(), monto: gmf,
      desc: `4x1000 sobre ${fmt(monto)}`, cat: 'Impuestos', billeteraId, ts: _ts + 1
    });
  }
  closeModal('modal-nuevo-gasto');
  showLoading();
  await saveDb(['gastos']);
  hideLoading();
  renderAll();
  toast(gmf > 0 ? `Retiro registrado + 4x1000 (${fmt(gmf)}) ` : 'Retiro registrado ', 'success');
}

function verMovimientosBilletera(id) {
  const b = getBilleteras().find(b=>b.id===id);
  if (!b) return;

  // Transferencias nuevas (colección separada, no legacy)
  const transfs = (STATE.db.transferencias || []).filter(t => !t.legado);

  // Todos los movimientos: ingresos, gastos Y transferencias
  const movs = [
    ...STATE.db.ingresos
      .filter(i => i.billeteraId === id && i.cat !== 'Transferencia')
      .map(i => ({...i, tipo:'ingreso'})),
    ...STATE.db.gastos
      .filter(g => g.billeteraId === id && g.cat !== 'Transferencia')
      .map(g => ({...g, tipo:'gasto'})),
    ...transfs
      .filter(t => t.origenId === id)
      .map(t => ({...t, tipo:'transferencia-salida', desc: `Transferencia → ${t.destinoNombre||''}`, fecha: t.fecha, hora: t.hora||''})),
    ...transfs
      .filter(t => t.destinoId === id)
      .map(t => ({...t, tipo:'transferencia-entrada', desc: `Transferencia ← ${t.origenNombre||''}`, fecha: t.fecha, hora: t.hora||''})),
  ].sort((a,b) => {
    const fd = (b.fecha||'').localeCompare(a.fecha||'');
    if (fd !== 0) return fd;
    const hd = convertirHora(b.hora) - convertirHora(a.hora);
    if (hd !== 0) return hd;
    return (b.ts||0) - (a.ts||0);
  });

  // Calcular saldo hacia ATRÁS desde el saldo real actual (siempre cuadra)
  // El saldo real es la fuente de verdad
  const saldoReal = saldoBilletera(id);
  let saldoAcc = saldoReal;
  const saldos = new Array(movs.length);
  for (let i = 0; i < movs.length; i++) {
    saldos[i] = saldoAcc; // saldo DESPUÉS de este movimiento
    const m = movs[i];
    // Revertir hacia atrás: deshacer el efecto de este movimiento
    if (m.tipo === 'ingreso' || m.tipo === 'transferencia-entrada') saldoAcc -= Number(m.monto);
    else saldoAcc += Number(m.monto);
  }

  const sec = document.getElementById('bill-movimientos');
  const title = document.getElementById('bill-mov-title');
  const tbody = document.getElementById('bill-mov-tbody');
  if (!sec) return;

  title.textContent = `Movimientos — ${b.nombre}`;
  sec.style.display = '';

  if (!movs.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px;font-style:italic">Sin movimientos registrados aún</td></tr>';
  } else {
    const tipoLabel = t => {
      if (t==='ingreso') return '<span class="badge badge-green">Ingreso</span>';
      if (t==='gasto') return '<span class="badge badge-red">Gasto</span>';
      if (t==='transferencia-entrada') return '<span class="badge" style="background:rgba(13,148,136,.12);color:var(--teal);">↙ Transferencia</span>';
      return '<span class="badge" style="background:rgba(100,116,139,.12);color:var(--muted);">↗ Transferencia</span>';
    };
    const esPositivo = t => t==='ingreso'||t==='transferencia-entrada';
    tbody.innerHTML = movs.map((m,i) => `
      <tr>
        <td style="white-space:nowrap">${m.fecha||'—'}</td>
        <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">${m.hora||'—'}</td>
        <td>${m.fuente||m.desc||'—'}</td>
        <td>${tipoLabel(m.tipo)}</td>
        <td style="color:${esPositivo(m.tipo)?'var(--green)':'var(--red)'};font-weight:600;white-space:nowrap">
          ${esPositivo(m.tipo)?'+':'-'}${fmt(m.monto)}
        </td>
        <td style="font-weight:600;white-space:nowrap;color:${saldos[i]>=0?'var(--text)':'var(--red)'}">${fmt(saldos[i])}</td>
      </tr>`).join('');
  }

  sec.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function renderTablaTransferencias() {
  const sec = document.getElementById('bill-transferencias-sec');
  if (!sec) return;
  const transfs = (STATE.db.transferencias || []).slice().sort((a,b)=>(b.fecha||'').localeCompare(a.fecha||''));
  if (!transfs.length) {
    sec.innerHTML = `
      <div class="section" style="margin-top:20px;">
        <div class="section-header">
          <span class="section-title">Historial de transferencias entre billeteras</span>
        </div>
        <p style="color:var(--muted);font-size:.88rem;padding:20px;text-align:center;font-style:italic">Sin transferencias registradas aún.</p>
      </div>`;
    return;
  }
  const totalTransferido = transfs.reduce((a,t)=>a+Number(t.monto),0);
  sec.innerHTML = `
    <div class="section" style="margin-top:20px;">
      <div class="section-header">
        <span class="section-title">Historial de transferencias entre billeteras</span>
        <span style="font-size:.82rem;color:var(--muted)">${transfs.length} transferencias · Total movido: <strong>${fmt(totalTransferido)}</strong></span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Hora</th>
              <th>Descripción</th>
              <th>Origen</th>
              <th>Destino</th>
              <th>Monto</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${transfs.map(t => {
              const bOri = getBilleteras().find(b=>b.id===t.origenId);
              const bDst = getBilleteras().find(b=>b.id===t.destinoId);
              const oriNombre = bOri?.nombre || t.origenNombre || '—';
              const dstNombre = bDst?.nombre || t.destinoNombre || '—';
              return `<tr>
                <td style="white-space:nowrap">${t.fecha||'—'}</td>
                <td style="color:var(--muted);font-size:.8rem;white-space:nowrap">${t.hora||'—'}</td>
                <td>${t.desc||'—'}</td>
                <td><span class="badge badge-red" style="font-size:.75rem">${oriNombre}</span></td>
                <td><span class="badge badge-green" style="font-size:.75rem">${dstNombre}</span></td>
                <td style="font-weight:700;color:var(--accent);white-space:nowrap">${fmt(t.monto)}</td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteTransferencia('${t.id}')" title="Eliminar transferencia">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                </button></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function deleteTransferencia(id) {
  if (!confirm('¿Eliminar esta transferencia? Los saldos de ambas billeteras se ajustarán automáticamente.')) return;
  STATE.db.transferencias = (STATE.db.transferencias||[]).filter(t=>t.id!==id);
  renderBilleteras();
  renderTablaTransferencias();
  await saveDb(['transferencias']);
  toast('Transferencia eliminada', 'info');
}

function renderBilleteras() {
  const grid  = document.getElementById('bill-grid');
  const empty = document.getElementById('bill-empty');
  const bar   = document.getElementById('bill-total-bar');
  const all   = getBilleteras();
  const list  = all.filter(b => !b.oculta);
  const ocultas = all.filter(b => b.oculta);

  const totalGeneral = list.reduce((a,b)=>a+saldoBilletera(b.id),0);

  if (bar) bar.innerHTML = `
    <div class="section" style="padding:14px 18px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <!-- Info total -->
        <div style="flex:1;min-width:0;">
          <div style="font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:2px;">Total en billeteras</div>
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
            <div style="font-size:1.7rem;font-weight:800;color:${totalGeneral>=0?'var(--green)':'var(--red)'};line-height:1;">${fmt(totalGeneral)}</div>
            <div style="font-size:.72rem;color:var(--muted);">${list.length} billetera${list.length!==1?'s':''}${ocultas.length?' · '+ocultas.length+' oculta'+(ocultas.length!==1?'s':''):''}</div>
          </div>
        </div>
        <!-- Botones: columna en móvil, fila en desktop -->
        <div class="bill-bar-btns">
          <button onclick="openModalTransferencia()" class="bill-bar-btn-sec">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            Transferir
          </button>
          <button onclick="openModalBilletera()" class="bill-bar-btn-pri">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Nueva billetera
          </button>
        </div>
      </div>
    </div>`;

  if (!list.length) {
    if(grid) grid.innerHTML = '';
    if(empty) empty.style.display = '';
    renderTablaTransferencias();
    return;
  }
  if(empty) empty.style.display = 'none';

  const BILL_SVG = {
    'Nequi':       `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><circle cx="12" cy="12" r="2"/></svg>`,
    'Bancolombia': `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><polyline points="8 8 12 12 16 8"/></svg>`,
    'Efectivo':    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="6" width="22" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M17 12h.01M7 12h.01"/></svg>`,
    'Daviplata':   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
    'Banco':       `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    'BBVA':        `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 6v12M9 9h6a1 1 0 0 1 0 3H9a1 1 0 0 0 0 3h6"/></svg>`,
    'Ahorro':      `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/><circle cx="16" cy="13" r="1.5"/></svg>`,
    'PayPal':      `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>`,
    'Otro':        `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`,
  };

  function billCard(b, esOculta=false) {
    const saldo = saldoBilletera(b.id);
    const svgIcon = BILL_SVG[b.tipo] || BILL_SVG['Otro'];
    const color = b.color || 'var(--accent)';
    const numIng = STATE.db.ingresos.filter(i=>i.billeteraId===b.id && i.cat!=='Transferencia').length;
    const numGas = STATE.db.gastos.filter(g=>g.billeteraId===b.id && g.cat!=='Transferencia').length;
    return `
    <div class="bill-card" style="border-top:3px solid ${color};">
      <div class="bill-card-header">
        <div class="bill-icon-wrap" style="background:${color}1a;color:${color};">${svgIcon}</div>
        <div class="bill-info">
          <div class="bill-nombre">${b.nombre}</div>
          <div class="bill-meta">${numIng} ing · ${numGas} gas</div>
        </div>
        <div class="bill-card-btns">
          <button class="bill-card-btn" onclick="ocultarBilletera('${b.id}',${!esOculta})" title="${esOculta?'Mostrar':'Ocultar'}">
            ${esOculta
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
              : '<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
            }
          </button>
          <button class="bill-card-btn" onclick="openModalBilletera('${b.id}')" title="Editar">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="bill-card-btn danger" onclick="deleteBilletera('${b.id}')" title="Eliminar">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="bill-saldo" style="color:${saldo>=0?color:'var(--red)'};">${fmt(saldo)}</div>
      <div class="bill-actions">
        <button class="btn btn-ghost btn-sm" onclick="verMovimientosBilletera('${b.id}')">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px;"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>Movimientos
        </button>
        <button class="btn btn-ghost btn-sm" onclick="openModalTransferenciaDesde('${b.id}')" title="Transferir">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.46"/></svg>
        </button>
      </div>
    </div>`;
  }

  if (!all.length) {
    if(grid) grid.innerHTML = '';
    if(empty) empty.style.display = '';
    renderTablaTransferencias();
    return;
  }
  if(empty) empty.style.display = 'none';

  // Billeteras visibles
  grid.innerHTML = list.length
    ? list.map(b => billCard(b, false)).join('')
    : '<p style="color:var(--muted);font-size:.85rem;grid-column:1/-1;padding:8px 0;">No hay billeteras visibles.</p>';

  // Sección ocultas
  let ocultasEl = document.getElementById('bill-ocultas-sec');
  if (!ocultasEl) {
    ocultasEl = document.createElement('div');
    ocultasEl.id = 'bill-ocultas-sec';
    grid.parentNode.insertBefore(ocultasEl, grid.nextSibling);
  }
  if (ocultas.length) {
    const expanded = localStorage.getItem('bill_ocultas_expanded') === 'true';
    ocultasEl.innerHTML = `
      <div style="margin-top:20px;">
        <button onclick="toggleBillOcultas()" style="display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:0;margin-bottom:${expanded?'12px':'0'};">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
          <span style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);">Billeteras ocultas (${ocultas.length})</span>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2.5" style="transition:transform .2s;transform:rotate(${expanded?'180':'0'}deg)"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div id="bill-ocultas-grid" style="display:${expanded?'grid':'none'};" class="bill-grid">
          ${ocultas.map(b => billCard(b, true)).join('')}
        </div>
      </div>`;
  } else {
    ocultasEl.innerHTML = '';
  }

  renderTablaTransferencias();
}

function toggleBillOcultas() {
  const expanded = localStorage.getItem('bill_ocultas_expanded') === 'true';
  localStorage.setItem('bill_ocultas_expanded', expanded ? 'false' : 'true');
  renderBilleteras();
}

async function ocultarBilletera(id, ocultar) {
  const idx = STATE.db.billeteras.findIndex(b=>b.id===id);
  if (idx === -1) return;
  STATE.db.billeteras[idx].oculta = ocultar;
  await saveDb(['billeteras']);
  renderBilleteras();
}

// Poblar todos los selects de billetera en los formularios
function populateBilleteraSelects() {
  const ids = ['i-billetera','g-billetera','m-cobro-billetera','m-abonar-billetera', 'pr-billetera'];
  const list = getBilleteras();
  ids.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Sin asignar</option>';
    list.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = (BILL_ICONOS[b.tipo]||'') + ' ' + b.nombre + ' — ' + fmt(saldoBilletera(b.id));
      if (b.id === cur) opt.selected = true;
      sel.appendChild(opt);
    });
  });
}

// ── Actualizar saldo billetera en el dashboard ──
function getBilleteraSaldo(id) { return saldoBilletera(id); }

// ── Inyectar resumen de billeteras en el dashboard ──
function renderBilleterasDashWidget() {
  const el = document.getElementById('dash-billeteras-widget');
  // Widget is now hidden — the hero balance shows the total
  // We keep this function but suppress the widget to avoid duplication
  if (!el) return;
  const list = getBilleteras();
  if (!list.length) { el.style.display = 'none'; return; }
  // Show a compact mini-list only if user wants it (hidden by default now)
  // Always hide the widget — the new balance hero shows total
  el.style.display = 'none';
  return;
  const total = list.reduce((a,b)=>a+saldoBilletera(b.id),0);
  el.innerHTML = `
    <div class="section-header"><span class="section-title"> Mis billeteras</span>
      <button class="btn btn-ghost btn-sm" onclick="navigate('billeteras')">Ver todas →</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;">
      ${list.map(b=>{
        const s=saldoBilletera(b.id);
        const c=b.color||'var(--accent)';
        return `<div style="background:var(--bg2);border-radius:var(--radius-sm);padding:10px 12px;border-left:3px solid ${c}">
          <div style="font-size:.8rem;font-weight:600;color:var(--text)">${BILL_ICONOS[b.tipo]||''} ${b.nombre}</div>
          <div style="font-size:1rem;font-weight:700;color:${s>=0?c:'var(--red)'};">${fmt(s)}</div>
        </div>`;
      }).join('')}
    </div>
    <div style="margin-top:10px;font-size:.82rem;color:var(--muted);text-align:right">Total: <strong style="color:var(--green)">${fmt(total)}</strong></div>`;
}

/* ============================================================
   REPORTES & MÉTRICAS
   ============================================================ */
function renderReportes() {
  const periodoSel = document.getElementById('rep-periodo');
  const mesDetSel  = document.getElementById('rep-mes-detalle');
  if (!periodoSel) return;

  const nMeses = parseInt(periodoSel.value) || 6;
  const now    = new Date();

  const meses = [];
  for (let i = nMeses - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    meses.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  }

  // Populate mes detalle select
  if (mesDetSel) {
    const curMesDet = mesDetSel.value;
    mesDetSel.innerHTML = '<option value="">— Ver detalle de un mes —</option>';
    [...meses].reverse().forEach(m => {
      const o = document.createElement('option');
      o.value = m; o.textContent = monthLabel(m);
      if (m === curMesDet) o.selected = true;
      mesDetSel.appendChild(o);
    });
  }

  // Datos por mes
  const datos = meses.map(m => {
    const ings  = STATE.db.ingresos.filter(i => ym(i.fecha) === m);
    const gass  = STATE.db.gastos.filter(g => ym(g.fecha) === m);
    const totalIng = ings.reduce((a,b) => a+Number(b.monto), 0);
    const totalGas = gass.reduce((a,b) => a+Number(b.monto), 0);
    return { m, ings, gass, totalIng, totalGas, balance: totalIng - totalGas };
  });

  const totIng = datos.reduce((a,d)=>a+d.totalIng, 0);
  const totGas = datos.reduce((a,d)=>a+d.totalGas, 0);
  const bal    = totIng - totGas;
  const mejorMes = datos.length ? datos.reduce((a,d)=>d.balance>a.balance?d:a, datos[0]) : null;

  // KPIs
  const kpisEl = document.getElementById('rep-kpis');
  if (kpisEl) {
    kpisEl.innerHTML = `
      <div class="stat-card green">
        <div class="stat-icon-box"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></div>
        <div class="stat-body"><div class="stat-label">Total ingresos</div><div class="stat-value positive">${fmt(totIng)}</div><div class="stat-sub">${nMeses} meses</div></div>
      </div>
      <div class="stat-card red">
        <div class="stat-icon-box"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg></div>
        <div class="stat-body"><div class="stat-label">Total gastos</div><div class="stat-value negative">${fmt(totGas)}</div><div class="stat-sub">${nMeses} meses</div></div>
      </div>
      <div class="stat-card ${bal>=0?'green':'red'}">
        <div class="stat-icon-box"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
        <div class="stat-body"><div class="stat-label">Balance período</div><div class="stat-value ${bal>=0?'positive':'negative'}">${fmt(bal)}</div></div>
      </div>
      <div class="stat-card blue">
        <div class="stat-icon-box"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>
        <div class="stat-body"><div class="stat-label">Mejor mes</div><div class="stat-value" style="font-size:.95rem;">${mejorMes ? monthLabel(mejorMes.m) : '—'}</div><div class="stat-sub">${mejorMes ? fmt(mejorMes.balance) : ''}</div></div>
      </div>`;
  }

  // Gráfica de barras SVG
  drawRepBarChart(datos);

  // Tabla como cards
  const tablaEl = document.getElementById('rep-tabla-cards');
  if (tablaEl) {
    tablaEl.innerHTML = [...datos].reverse().map(d => {
      const b = d.balance;
      const pctGas = d.totalIng > 0 ? Math.min(100, Math.round(d.totalGas/d.totalIng*100)) : 0;
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:11px 20px;border-bottom:1px solid var(--border);">
          <div style="width:80px;flex-shrink:0;font-size:.82rem;font-weight:600;color:var(--text);">${monthLabel(d.m)}</div>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;justify-content:space-between;font-size:.72rem;color:var(--muted);margin-bottom:3px;">
              <span>${fmt(d.totalIng)}</span><span>${fmt(d.totalGas)}</span>
            </div>
            <div style="height:5px;background:var(--border);border-radius:10px;overflow:hidden;">
              <div style="height:100%;width:${pctGas}%;background:${pctGas>90?'var(--red)':pctGas>70?'var(--yellow)':'var(--accent)'};border-radius:10px;transition:width .3s;"></div>
            </div>
          </div>
          <div style="font-weight:700;font-size:.88rem;color:${b>=0?'var(--green)':'var(--red)'};flex-shrink:0;min-width:72px;text-align:right;">${fmt(b)}</div>
        </div>`;
    }).join('');
  }

  // Detalle mes
  const mesDet = mesDetSel?.value;
  const detEl  = document.getElementById('rep-detalle-mes');
  if (mesDet && detEl) {
    detEl.style.display = '';
    const dMes = datos.find(d=>d.m===mesDet) || { ings:[], gass:[] };
    const topGas = [...dMes.gass].sort((a,b)=>Number(b.monto)-Number(a.monto)).slice(0,8);
    const topIng = [...dMes.ings].sort((a,b)=>Number(b.monto)-Number(a.monto)).slice(0,8);
    const topGasEl = document.getElementById('rep-top-gastos');
    const topIngEl = document.getElementById('rep-top-ingresos');
    const itemRow = (label, monto, color, cat) => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-light);">
        <div style="min-width:0;">
          <div style="font-size:.83rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">${label}</div>
          <div style="font-size:.7rem;color:var(--muted);">${cat||''}</div>
        </div>
        <span style="font-weight:700;font-size:.88rem;color:${color};flex-shrink:0;margin-left:8px;">${fmt(monto)}</span>
      </div>`;
    if (topGasEl) topGasEl.innerHTML = topGas.length ? topGas.map(g=>itemRow(g.desc||'—', g.monto, 'var(--red)', g.cat)).join('') : '<p style="color:var(--muted);font-size:.82rem;padding:8px 0;">Sin gastos</p>';
    if (topIngEl) topIngEl.innerHTML = topIng.length ? topIng.map(i=>itemRow(i.fuente||i.desc||'—', i.monto, 'var(--green)', i.cat)).join('') : '<p style="color:var(--muted);font-size:.82rem;padding:8px 0;">Sin ingresos</p>';
  } else if (detEl) {
    detEl.style.display = 'none';
  }
}

function drawRepBarChart(datos) {
  const container = document.getElementById('rep-bar-chart');
  if (!container || !datos.length) return;

  const maxVal = Math.max(...datos.map(d => Math.max(d.totalIng, d.totalGas)), 1);
  const barH   = 140;
  const barW   = Math.max(28, Math.min(48, Math.floor((container.clientWidth || 320) / (datos.length * 2.5))));
  const gap    = Math.round(barW * 0.4);
  const groupW = barW * 2 + gap + 8;
  const totalW = Math.max(container.clientWidth || 320, datos.length * groupW + 40);
  const labelH = 28;
  const totalH = barH + labelH + 24;

  let svg = `<svg width="${totalW}" height="${totalH}" xmlns="http://www.w3.org/2000/svg" style="display:block;">`;

  datos.forEach((d, i) => {
    const x = 20 + i * groupW;
    const hIng = d.totalIng > 0 ? Math.max(3, Math.round(d.totalIng / maxVal * barH)) : 0;
    const hGas = d.totalGas > 0 ? Math.max(3, Math.round(d.totalGas / maxVal * barH)) : 0;
    const hBal = Math.abs(d.balance) > 0 ? Math.max(2, Math.round(Math.abs(d.balance) / maxVal * barH)) : 0;
    const balColor = d.balance >= 0 ? '#059669' : '#dc2626';

    // Barra ingresos
    svg += `<rect x="${x}" y="${barH - hIng + 8}" width="${barW}" height="${hIng}" rx="3" fill="#0f2d6b" opacity=".85"/>`;
    // Barra gastos
    svg += `<rect x="${x + barW + gap}" y="${barH - hGas + 8}" width="${barW}" height="${hGas}" rx="3" fill="#dc2626" opacity=".75"/>`;
    // Línea balance
    const balY = d.balance >= 0 ? barH - hBal + 8 : barH + 8;
    svg += `<rect x="${x}" y="${balY}" width="${barW * 2 + gap}" height="2" rx="1" fill="${balColor}" opacity=".6"/>`;

    // Etiqueta mes
    const label = monthLabel(d.m).slice(0,3);
    svg += `<text x="${x + barW + gap/2}" y="${barH + 24}" text-anchor="middle" font-size="10" fill="#64748b" font-family="system-ui,sans-serif">${label}</text>`;
  });

  // Línea base
  svg += `<line x1="16" y1="${barH + 8}" x2="${totalW - 4}" y2="${barH + 8}" stroke="#e2e8f0" stroke-width="1"/>`;
  svg += '</svg>';

  container.innerHTML = svg;
}


// ── Forzar sincronización con Firebase ──
async function forceSyncFirebase() {
  if (!window.__FB || !window.__FB.ready) {
    toast('Firebase no está conectado. Revisa tu conexión o configura las credenciales.', 'error');
    return;
  }
  showLoadingOverlay('Sincronizando con Firebase...');
  try {
    await saveDb();
    hideLoadingOverlay();
    toast('Sincronización completada', 'success');
    updateFbStatus(true);
  } catch (err) {
    hideLoadingOverlay();
    toast('Error de sincronización: ' + err.message, 'error');
  }
}

function exportData() {
  const exportData = {
    ...STATE.db,
    _meta: {
      exportDate: new Date().toISOString(),
      version: 'finanzas-pro-v2',
      firebase: window.__FB?.ready ? 'connected' : 'offline'
    }
  };
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'finanzas_backup_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup exportado correctamente', 'success');
}

// ── Importar backup JSON ──
function importBackup() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      // Validar que tiene la estructura correcta
      const keys = ['ingresos','gastos','deudas'];
      if (!keys.every(k => Array.isArray(data[k]))) {
        return toast('Archivo de backup inválido', 'error');
      }
      if (!confirm('¿Importar este backup? Se reemplazarán todos los datos actuales.')) return;
      delete data._meta; // quitar metadatos del export
      STATE.db = {
        ingresos:       data.ingresos       || [],
        gastos:         data.gastos         || [],
        deudas:         data.deudas         || [],
        pass:           data.pass           || [],
        prestamos:      data.prestamos      || [],
        gastosFijos:    data.gastosFijos    || [],
        inversiones:    data.inversiones    || [],
        ventasInv:      data.ventasInv      || [],
        billeteras:     data.billeteras     || [],
        transferencias: data.transferencias || [],
      };
      showLoadingOverlay('Importando datos...');
      await saveDb();
      hideLoadingOverlay();
      renderAll();
      toast('Backup importado correctamente', 'success');
    } catch (err) {
      hideLoadingOverlay();
      toast('Error al importar: ' + err.message, 'error');
    }
  };
  input.click();
}

/* ============================================================
   UTILS
   ============================================================ */
function clearForm(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

// Close modals on overlay click
const MODALES_PROTEGIDOS = ['modal-nuevo-ingreso', 'modal-nuevo-gasto'];

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay && !MODALES_PROTEGIDOS.includes(overlay.id)) {
      overlay.classList.remove('open');
    }
  });
});

// Close inv form overlay on backdrop click
document.addEventListener('click', e => {
  const overlay = document.getElementById('modal-inv-form-overlay');
  if (overlay && e.target === overlay) closeInvModal();
});

// Keyboard: Enter on PIN
document.addEventListener('keydown', e => {
  if (!document.getElementById('lock-screen').classList.contains('hidden')) return;
  // nothing special needed outside lock
});
document.addEventListener('keydown', e => { // heredado de login.html
  if (e.key === 'Enter') pinSubmit();
  else if (e.key === 'Backspace') pinDelete();
  else if (/^[0-9]$/.test(e.key)) pinPress(e.key);
});

// Redraw charts on resize
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (STATE.currentPage === 'reportes') {
      renderReportes();
    }
  }, 200);
});
/* ============================================================
   MOVIMIENTOS – PERIOD PICKER
   ============================================================ */
(function() {
  // Internal state
  let _calBaseYear, _calBaseMonth; // left calendar month
  let _selStart = null, _selEnd = null, _hoverDate = null;
  let _picking = false; // true while selecting range (first click done)
  let _activeQuick = 'mes';

  function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function fromYMD(s) { return s ? new Date(s + 'T12:00:00') : null; }

  function initCalBase() {
    const hoy = new Date();
    _calBaseYear = hoy.getFullYear();
    _calBaseMonth = hoy.getMonth(); // 0-indexed
  }

  /* ── Toggle picker ── */
  window.toggleMovPeriodoPicker = function() {
    const picker = document.getElementById('mov-periodo-picker');
    if (!picker) return;
    const open = picker.style.display !== 'none';
    if (open) { picker.style.display = 'none'; return; }
    initCalBase();
    renderMovCal();
    picker.style.display = 'block';
  };

  // El picker detiene su propio bubbling — así los clicks internos no llegan al document
  document.addEventListener('DOMContentLoaded', function() {
    const picker = document.getElementById('mov-periodo-picker');
    if (picker) {
      picker.addEventListener('click', function(e) { e.stopPropagation(); });
    }
  });

  // Cierre al hacer click fuera (solo llega aquí si no fue dentro del picker)
  document.addEventListener('click', function(e) {
    const picker = document.getElementById('mov-periodo-picker');
    const btn = document.getElementById('mov-periodo-btn');
    if (!picker || picker.style.display === 'none') return;
    if (btn && btn.contains(e.target)) return;
    picker.style.display = 'none';
  });

  /* ── Navigate months ── */
  window.movCalNav = function(dir) {
    _calBaseMonth += dir;
    if (_calBaseMonth > 11) { _calBaseMonth = 0; _calBaseYear++; }
    if (_calBaseMonth < 0)  { _calBaseMonth = 11; _calBaseYear--; }
    renderMovCal();
  };

  /* ── Quick presets ── */
  window.applyMovQuick = function(q) {
    _activeQuick = q;
    document.querySelectorAll('.mov-quick-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.q === q);
    });
    const hoy = new Date();
    const hoyYMD = toYMD(hoy);

    if (q === 'hoy') {
      _selStart = hoyYMD; _selEnd = hoyYMD;
    } else if (q === 'ayer') {
      const ay = new Date(hoy); ay.setDate(ay.getDate()-1);
      _selStart = _selEnd = toYMD(ay);
    } else if (q === '7d') {
      const d = new Date(hoy); d.setDate(d.getDate()-6);
      _selStart = toYMD(d); _selEnd = hoyYMD;
    } else if (q === '30d') {
      const d = new Date(hoy); d.setDate(d.getDate()-29);
      _selStart = toYMD(d); _selEnd = hoyYMD;
    } else if (q === 'mes') {
      const y = hoy.getFullYear(), m = String(hoy.getMonth()+1).padStart(2,'0');
      const last = new Date(hoy.getFullYear(), hoy.getMonth()+1, 0);
      _selStart = `${y}-${m}-01`; _selEnd = toYMD(last);
    } else if (q === 'mesant') {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
      const ini = new Date(d.getFullYear(), d.getMonth(), 1);
      _selStart = toYMD(ini); _selEnd = toYMD(d);
    } else if (q === 'todo') {
      _selStart = null; _selEnd = null;
    }

    _picking = false;
    updateRangeLabel();
    renderMovCal();
    // Auto-apply for quick presets
    applyMovPicker();
  };

  /* ── Apply & close ── */
  window.applyMovPicker = function() {
    const desde = document.getElementById('mov-filter-desde');
    const hasta = document.getElementById('mov-filter-hasta');
    if (desde) desde.value = _selStart || '';
    if (hasta) hasta.value = _selEnd || '';

    // Update button label
    updatePeriodoBtnLabel();
    document.getElementById('mov-periodo-picker').style.display = 'none';
    renderMovimientos();
  };

  window.cancelMovPicker = function() {
    document.getElementById('mov-periodo-picker').style.display = 'none';
  };

  function updatePeriodoBtnLabel() {
    const lbl = document.getElementById('mov-periodo-label');
    if (!lbl) return;
    if (!_selStart && !_selEnd) { lbl.textContent = 'Ver todo'; return; }
    const labels = { hoy:'Hoy', ayer:'Ayer', '7d':'Últimos 7 días', '30d':'Últimos 30 días', mes:'Este mes', mesant:'Mes pasado' };
    if (labels[_activeQuick] && _activeQuick !== 'todo') {
      lbl.textContent = labels[_activeQuick];
    } else if (_selStart && _selEnd && _selStart !== _selEnd) {
      lbl.textContent = `${formatDateShort(_selStart)} → ${formatDateShort(_selEnd)}`;
    } else if (_selStart) {
      lbl.textContent = formatDateShort(_selStart);
    } else {
      lbl.textContent = 'Ver todo';
    }
  }

  function formatDateShort(ymd) {
    if (!ymd) return '';
    const [y,m,d] = ymd.split('-');
    const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
    return `${parseInt(d)}/${meses[parseInt(m)-1]}/${y}`;
  }

  function updateRangeLabel() {
    const el = document.getElementById('mov-cal-range-label');
    if (!el) return;
    if (!_selStart) { el.textContent = ''; return; }
    const s = formatDateShort(_selStart);
    const e = _selEnd ? formatDateShort(_selEnd) : '...';
    el.textContent = `${s} → ${e}`;
  }

  /* ── Render both calendars ── */
  function renderMovCal() {
    renderOneMovCal('left',  _calBaseYear, _calBaseMonth);
    let ry = _calBaseYear, rm = _calBaseMonth + 1;
    if (rm > 11) { rm = 0; ry++; }
    renderOneMovCal('right', ry, rm);

    const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const tl = document.getElementById('mov-cal-title-l');
    const tr = document.getElementById('mov-cal-title-r');
    if (tl) tl.textContent = `${meses[_calBaseMonth]} ${_calBaseYear}`;
    if (tr) tr.textContent = `${meses[rm]} ${ry}`;
    setupCalListeners();
    updateRangeLabel();
  }

  function renderOneMovCal(side, year, month) {
    const el = document.getElementById(`mov-cal-${side}`);
    if (!el) return;
    const dias = ['LU','MA','MI','JU','VI','SA','DO'];
    const hoyYMD = toYMD(new Date());

    let html = dias.map(d => `<div class="mov-cal-header">${d}</div>`).join('');

    const firstDay = new Date(year, month, 1);
    let startDow = firstDay.getDay();
    startDow = startDow === 0 ? 6 : startDow - 1;

    const daysInMonth = new Date(year, month+1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();

    // Prev month padding
    for (let i = startDow - 1; i >= 0; i--) {
      const d = prevDays - i;
      const m2 = month - 1 < 0 ? 11 : month - 1;
      const y2 = month - 1 < 0 ? year - 1 : year;
      const ymd = `${y2}-${String(m2+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      html += `<div class="mov-cal-day other-month" data-ymd="${ymd}" data-other="1">${d}</div>`;
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const cls = getDayClass(ymd, hoyYMD);
      html += `<div class="mov-cal-day ${cls}" data-ymd="${ymd}" data-other="0">${d}</div>`;
    }

    // Next month padding
    const totalCells = startDow + daysInMonth;
    const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let d = 1; d <= remaining; d++) {
      const m2 = month + 1 > 11 ? 0 : month + 1;
      const y2 = month + 1 > 11 ? year + 1 : year;
      const ymd = `${y2}-${String(m2+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      html += `<div class="mov-cal-day other-month" data-ymd="${ymd}" data-other="1">${d}</div>`;
    }

    el.innerHTML = html;
  }

  function setupCalListeners() {
    ['mov-cal-left','mov-cal-right'].forEach(id => {
      const el = document.getElementById(id);
      if (!el || el._calReady) return;
      el._calReady = true;
      el.addEventListener('click', function(e) {
        const day = e.target.closest('[data-ymd]');
        if (day) movCalDayClick(day.dataset.ymd);
      });
      el.addEventListener('mouseover', function(e) {
        const day = e.target.closest('[data-ymd]');
        if (day) movCalHover(day.dataset.ymd);
      });
    });
  }

  function getDayClass(ymd, hoyYMD) {
    let cls = '';
    if (ymd === hoyYMD) cls += ' today';
    const effEnd = (_picking && _hoverDate) ? (_hoverDate > _selStart ? _hoverDate : _selStart) : _selEnd;
    const effStart = (_picking && _hoverDate && _hoverDate < _selStart) ? _hoverDate : _selStart;

    if (_selStart && ymd === _selStart) cls += ' range-start';
    if (effEnd && ymd === effEnd && ymd !== _selStart) cls += ' range-end';
    if (effStart && effEnd && ymd > effStart && ymd < effEnd) cls += ' in-range';
    if (_selStart && !effEnd && ymd === _selStart) cls += ' range-end'; // single day
    return cls;
  }

  /* ── Day click ── */
  window.movCalDayClick = function(ymd) {
    if (!_picking || !_selStart) {
      // First click
      _selStart = ymd; _selEnd = null;
      _picking = true;
      _activeQuick = 'custom';
      document.querySelectorAll('.mov-quick-btn').forEach(b => b.classList.remove('active'));
    } else {
      // Second click
      if (ymd < _selStart) { _selEnd = _selStart; _selStart = ymd; }
      else { _selEnd = ymd; }
      _picking = false;
    }
    updateRangeLabel();
    renderMovCal();
  };

  window.movCalHover = function(ymd) {
    if (!_picking) return;
    _hoverDate = ymd;
    // Actualizar solo clases CSS sin destruir el DOM
    const hoyYMD = toYMD(new Date());
    document.querySelectorAll('.mov-cal-day[data-ymd]').forEach(el => {
      const d = el.dataset.ymd;
      const isOther = el.dataset.other === '1';
      el.className = 'mov-cal-day' + (isOther ? ' other-month' : '') + getDayClass(d, hoyYMD);
    });
    updateRangeLabel();
  };

  /* ── Override old functions to keep compatibility ── */
  window.setMovRangoMesActual = function() { applyMovQuick('mes'); };
  window.clearMovRango = function() { applyMovQuick('todo'); };

  /* ── Init on load: set to "Este mes" ── */
  document.addEventListener('DOMContentLoaded', function() {
    applyMovQuick('mes');
  });

})();