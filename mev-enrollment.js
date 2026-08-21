// SW-73 4.2.1 "certificats" enrolment screen. Everything here is inert until Réglages holds
// real values from Revenu Québec (IDPARTN/IDSEV/IDVERSI from Mon dossier pour les partenaires,
// an authorization code received by mail) -- there is nothing to invent, so nothing here
// guesses at those. On any platform without MevKeystore (everywhere except the Android
// wrapper today), the card explains that instead of pretending to work.
import { buildReqCertif, endpointFor } from './mev-protocol.js';

const CFG = window.SIMPLEPOS_CONFIG || {};
const API = CFG.supabaseUrl ? `${CFG.supabaseUrl}/rest/v1` : '';
const $ = (s) => document.querySelector(s);
const DEVICE_ALIAS = 'mev-operator-key';

function session() { try { return JSON.parse(localStorage.getItem('simplepos-session') || 'null'); } catch { return null; } }
function escapeHtml(v = '') { return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function api(path, { method = 'GET', body, prefer = 'return=representation' } = {}) {
  const s = session();
  if (!API || !s?.access_token) throw new Error('Non connecté');
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: { apikey: CFG.supabasePublishableKey || '', Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.hint || `Supabase ${r.status}`);
  return data;
}
async function restaurant() { const rows = await api('restaurants?select=*&order=created_at.asc&limit=1'); return rows?.[0] || null; }
async function getConfig(restaurantId) { const rows = await api(`mev_partner_config?restaurant_id=eq.${restaurantId}&select=*&limit=1`); return rows?.[0] || null; }
async function upsertConfig(restaurantId, patch) {
  const existing = await getConfig(restaurantId);
  if (existing) return (await api(`mev_partner_config?restaurant_id=eq.${restaurantId}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } }))[0];
  return (await api('mev_partner_config', { method: 'POST', body: { restaurant_id: restaurantId, ...patch } }))[0];
}
async function getDevice(restaurantId) { const rows = await api(`mev_devices?restaurant_id=eq.${restaurantId}&device_key=eq.${DEVICE_ALIAS}&select=*&limit=1`); return rows?.[0] || null; }
async function upsertDevice(restaurantId, patch) {
  const existing = await getDevice(restaurantId);
  if (existing) return (await api(`mev_devices?id=eq.${existing.id}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() } }))[0];
  return (await api('mev_devices', { method: 'POST', body: { restaurant_id: restaurantId, device_key: DEVICE_ALIAS, environment: 'DEV', status: 'unregistered', certificate_status: 'missing', ...patch } }))[0];
}

function fieldRow(id, label, value = '', placeholder = '') {
  return `<label>${label}<input id="${id}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"></label>`;
}

async function render() {
  const host = $('#mevEnrollmentBody');
  if (!host) return;
  const nativeReady = window.SimplePOSMev?.isAndroidNative?.() === true;
  const r = await restaurant();
  const cfg = (await getConfig(r.id)) || {};
  const device = (await getDevice(r.id)) || {};

  host.innerHTML = `
    ${!nativeReady ? `<div class="mev-enroll-warning">Module de certificat disponible seulement dans l'appli Android. Sur ce navigateur/PWA, vous pouvez saisir et enregistrer les informations d'inscription, mais pas générer de clé ni envoyer de requête.</div>` : ''}
    <div class="form-two">${fieldRow('mevEnv', 'Environnement', cfg.environment || 'DEV')}${fieldRow('mevDossier', 'N° de dossier (facturation obligatoire)', cfg.dossier_number || '', 'AA9999')}</div>
    <div class="form-two">${fieldRow('mevAuthCode', "Code d'autorisation", cfg.authorization_code || '', 'X9X9-X9X9')}${fieldRow('mevOperatorId', "N° d'identification de l'exploitant", cfg.operator_identification_number || '')}</div>
    <div class="form-two">${fieldRow('mevIdPartn', 'IDPARTN', cfg.id_partn || '')}</div>
    <div class="form-two">${fieldRow('mevIdSev', 'IDSEV', cfg.id_sev || '')}${fieldRow('mevIdVersi', 'IDVERSI', cfg.id_versi || '')}</div>
    <div class="form-two">${fieldRow('mevCodCertif', 'CODCERTIF', cfg.cod_certif || '', 'RBC000000000 en DEV avant certification')}${fieldRow('mevVersi', 'VERSI (version SimplePOS)', cfg.versi || '1.0')}</div>
    <button id="mevSaveConfig" class="btn">Enregistrer l'inscription</button>
    <hr>
    <div class="mev-enroll-status">
      <div><strong>Clé locale</strong><span>${device.id_apprl ? `IDAPPRL ${escapeHtml(device.id_apprl)}` : 'Aucune clé générée'}</span></div>
      <div><strong>Certificat</strong><span>${device.certificate_status || 'missing'}</span></div>
    </div>
    <div class="button-row">
      <button id="mevGenerateCsr" class="btn" ${nativeReady ? '' : 'disabled'}>Générer une clé et un CSR</button>
      <button id="mevSendCertif" class="btn primary" ${device.csr_pem ? '' : 'disabled'}>Envoyer la requête certificats</button>
    </div>
    <div id="mevEnrollResult" class="muted"></div>
  `;

  $('#mevSaveConfig').onclick = async () => {
    try {
      await upsertConfig(r.id, {
        environment: $('#mevEnv').value.trim().toUpperCase(),
        dossier_number: $('#mevDossier').value.trim() || null,
        authorization_code: $('#mevAuthCode').value.trim() || null,
        operator_identification_number: $('#mevOperatorId').value.trim() || null,
        id_partn: $('#mevIdPartn').value.trim() || null,
        id_sev: $('#mevIdSev').value.trim() || null,
        id_versi: $('#mevIdVersi').value.trim() || null,
        cod_certif: $('#mevCodCertif').value.trim() || null,
        versi: $('#mevVersi').value.trim() || null,
      });
      $('#mevEnrollResult').textContent = 'Inscription enregistrée.';
    } catch (e) { $('#mevEnrollResult').textContent = `Erreur : ${e.message}`; }
  };

  $('#mevGenerateCsr').onclick = async () => {
    const btn = $('#mevGenerateCsr'); btn.disabled = true; btn.textContent = 'Génération…';
    try {
      await window.SimplePOSMev.generateKeyPair(DEVICE_ALIAS);
      const freshCfgForCsr = await getConfig(r.id);
      if (!freshCfgForCsr?.operator_identification_number) throw new Error("Enregistrez d'abord le numéro d'identification de l'exploitant");
      const csr = await window.SimplePOSMev.createOperatorCsr({
        alias: DEVICE_ALIAS,
        cn: freshCfgForCsr.operator_identification_number,
        o: `RBC-${$('#mevAuthCode').value.trim() || 'XXXX-XXXX'}`,
        ou: r.qst_number || '',
        sn: `SimplePOS-${r.id.slice(0, 8)}`,
        gn: $('#mevDossier').value.trim() || '',
        l: '-05:00',
        s: 'QC',
        c: 'CA',
      });
      await upsertDevice(r.id, { csr_pem: csr.csrPem, certificate_status: 'pending' });
      $('#mevEnrollResult').textContent = 'CSR généré et enregistré. Prêt à envoyer.';
      await render();
    } catch (e) {
      $('#mevEnrollResult').textContent = `Erreur : ${e.message}`;
    } finally { btn.disabled = false; btn.textContent = 'Générer une clé et un CSR'; }
  };

  $('#mevSendCertif').onclick = async () => {
    const btn = $('#mevSendCertif'); btn.disabled = true; btn.textContent = 'Envoi…';
    try {
      if (!window.SimplePOSMev?.isAndroidNative?.()) throw new Error('Envoi disponible seulement dans l’appli Android');
      const freshCfg = await getConfig(r.id);
      const freshDevice = await getDevice(r.id);
      const modif = freshDevice.id_apprl ? 'REM' : 'AJO';
      const headers = {
        ENVIRN: freshCfg.environment || 'DEV',
        CASESSAI: '000.000',
        APPRLINIT: 'SEV',
        // SW-77 3.2 "Identifiant de l'appareil" : la valeur initiale d'un appareil neuf est
        // littéralement "0000-0000-0000", jamais une valeur inventée par le SEV.
        IDAPPRL: freshDevice.id_apprl || '0000-0000-0000',
        NOTPS: r.gst_number,
        NOTVQ: r.qst_number,
        IDSEV: freshCfg.id_sev,
        IDVERSI: freshCfg.id_versi,
        CODCERTIF: freshCfg.cod_certif,
        IDPARTN: freshCfg.id_partn,
        VERSI: freshCfg.versi,
        // "0" pour une première certification (SW-73 4.3.1.1), jamais absent.
        VERSIPARN: freshCfg.versi_parn || '0',
      };
      const { reqCertif } = buildReqCertif({ modif, csrPem: freshDevice.csr_pem });
      const url = endpointFor('certificats', modif, headers.ENVIRN);
      // Envoyé directement depuis l'appareil (réseau natif Android), pas via une fonction
      // Supabase : confirmé en direct que le relais Deno perd l'en-tête IDVERSI en chemin.
      const sent = await window.SimplePOSMev.sendRequest({ url, headers, body: JSON.stringify({ reqCertif }) });
      const data = JSON.parse(sent.body || '{}');
      const ok = sent.status >= 200 && sent.status < 300;
      if (ok && data?.retourCertif?.idApprl) await upsertDevice(r.id, { id_apprl: data.retourCertif.idApprl, certificate_pem: data.retourCertif.certif || null, certificate_status: data.retourCertif.certif ? 'active' : 'pending', certificate_issued_at: data.retourCertif.certif ? new Date().toISOString() : null });
      await api('mev_partner_requests', { method: 'POST', prefer: 'return=minimal', body: {
        restaurant_id: r.id, device_id: freshDevice.id || null, request_type: 'certificats',
        environment: headers.ENVIRN, request_headers: headers, request_body: reqCertif,
        response_status: sent.status, response_body: data, error_code: ok ? null : String(sent.status), error_message: data?.retourCertif?.listErr?.[0]?.mess || null,
      } });
      $('#mevEnrollResult').textContent = ok
        ? 'Requête acceptée par le MEV-WEB — certificat reçu.'
        : `Refusée (${sent.status}) : ${data?.retourCertif?.listErr?.[0]?.mess || 'voir le journal'}`;
      await render();
    } catch (e) {
      $('#mevEnrollResult').textContent = `Erreur : ${e.message}`;
    } finally { btn.disabled = false; btn.textContent = 'Envoyer la requête certificats'; }
  };
}

function installStyles() {
  if ($('#mevEnrollStyles')) return;
  const style = document.createElement('style');
  style.id = 'mevEnrollStyles';
  style.textContent = `.mev-enroll-warning{padding:10px 12px;border-radius:10px;background:#fff1f0;color:#8a1f1f;font-size:13px;margin-bottom:14px}.mev-enroll-status{display:grid;gap:8px;margin:12px 0}.mev-enroll-status>div{display:flex;justify-content:space-between;font-size:14px}.mev-enroll-status strong{font-weight:600}.mev-enroll-status span{color:var(--muted,#6b7280)}`;
  document.head.appendChild(style);
}

function installCard() {
  const grid = $('#settingsScreen .settings-grid');
  if (!grid || $('#mevEnrollment')) return false;
  installStyles();
  const card = document.createElement('section');
  card.id = 'mevEnrollment';
  card.className = 'settings-card';
  card.innerHTML = `<div class="card-head"><div><h2>Enrôlement MEV-WEB (SW-73)</h2><p class="muted">Inscription partenaire et demande de certificat. Rien n'est envoyé à Revenu Québec avant d'avoir cliqué sur les boutons ci-dessous.</p></div></div><div id="mevEnrollmentBody"><div class="muted">Chargement…</div></div>`;
  grid.appendChild(card);
  render().catch((e) => { const body = $('#mevEnrollmentBody'); if (body) body.textContent = e.message; });
  return true;
}

function boot() { if (!installCard()) setTimeout(boot, 500); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
