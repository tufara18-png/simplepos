// SW-78 FO-103 "Identifier l'utilisateur lorsque l'appareil est en mode Veille" -- Revenu
// Québec requires the current user to re-identify after a period of inactivity, before the
// next transaction. Independent from the underlying Supabase session/token (which stays
// valid, and whose lifecycle is a separate FO-102 concern): this is a re-identification gate
// layered on top, not a logout.

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min; declare this figure in the FO-103 déclaration.
const CFG = window.RESTO360_CONFIG || {};
const AUTH = CFG.supabaseUrl ? `${CFG.supabaseUrl}/auth/v1` : '';

function session() { try { return JSON.parse(localStorage.getItem('resto360-session') || 'null'); } catch { return null; } }
function appVisible() { const app = document.getElementById('app'); return !!app && !app.classList.contains('hidden'); }
function escapeHtml(v = '') { return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let idleTimer = null;
let locked = false;

function installStyles() {
  if (document.getElementById('sessionLockStyles')) return;
  const style = document.createElement('style');
  style.id = 'sessionLockStyles';
  style.textContent = `#sessionLockOverlay{position:fixed;inset:0;background:rgba(23,24,28,.92);z-index:9999;display:grid;place-items:center;padding:20px}#sessionLockOverlay .lock-card{width:min(360px,100%);background:#fff;border-radius:18px;padding:26px;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.35)}#sessionLockOverlay h2{margin:6px 0 4px}#sessionLockOverlay p{color:var(--muted,#6b7280);font-size:13px;margin:0 0 16px}#sessionLockOverlay input{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:11px;margin-bottom:10px;text-align:center}#sessionLockOverlay .lock-error{color:var(--danger,#b42318);font-size:12px;min-height:16px;margin-bottom:8px}`;
  document.head.appendChild(style);
}

function showLock() {
  if (locked || !appVisible()) return;
  const s = session();
  if (!s?.user?.email) return;
  locked = true;
  installStyles();
  const overlay = document.createElement('div');
  overlay.id = 'sessionLockOverlay';
  overlay.innerHTML = `
    <div class="lock-card">
      <h2>Session verrouillée</h2>
      <p>Inactivité prolongée. Confirmez votre mot de passe pour continuer, ${escapeHtml(s.user.email)}.</p>
      <form id="sessionLockForm">
        <input id="sessionLockPassword" type="password" autocomplete="current-password" placeholder="Mot de passe" required autofocus>
        <div class="lock-error" id="sessionLockError"></div>
        <button class="btn primary full" type="submit">Déverrouiller</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  const form = overlay.querySelector('#sessionLockForm');
  const errorEl = overlay.querySelector('#sessionLockError');
  const input = overlay.querySelector('#sessionLockPassword');
  input.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    try {
      const r = await fetch(`${AUTH}/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: CFG.supabasePublishableKey || '', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: s.user.email, password: input.value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) throw new Error(d.msg || d.error_description || 'Mot de passe incorrect');
      overlay.remove();
      locked = false;
      armIdleTimer();
    } catch (err) {
      errorEl.textContent = err.message;
      input.value = '';
      input.focus();
    }
  };
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(showLock, IDLE_TIMEOUT_MS);
}

function onActivity() {
  if (locked) return; // the lock form's own inputs shouldn't reset a timer meant to re-arm after it closes
  armIdleTimer();
}

['pointerdown', 'keydown'].forEach((evt) => document.addEventListener(evt, onActivity, { passive: true }));
armIdleTimer();
