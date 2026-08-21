// Guided first-run setup: one step at a time, with a visible checklist and a single "Suivant"
// button, instead of the flat Gestion grid where a new owner has to guess what to fill in and
// in what order. Every field here writes to the exact same tables the Gestion screen already
// uses (restaurants, printers, app_settings, mev_partner_config/mev_devices via
// mev-enrollment.js) -- this module owns no state of its own, so the checklist always reflects
// what is really saved, and nothing gets out of sync if the owner edits things later in Gestion
// instead of coming back here.
import { renderMevEnrollmentInto } from './mev-enrollment.js';

const CFG = window.RESTO360_CONFIG || {};
const API = CFG.supabaseUrl ? `${CFG.supabaseUrl}/rest/v1` : '';
const $ = (s) => document.querySelector(s);

function session() { try { return JSON.parse(localStorage.getItem('resto360-session') || 'null'); } catch { return null; } }
function esc(v = '') { return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

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

async function loadState() {
  const restaurants = await api('restaurants?select=*&order=created_at.asc&limit=1');
  const r = restaurants?.[0];
  if (!r) return null;
  const [settingsRows, printerRows, partnerRows, deviceRows] = await Promise.all([
    api(`app_settings?restaurant_id=eq.${r.id}&select=*&limit=1`),
    api(`printers?restaurant_id=eq.${r.id}&select=*`),
    api(`mev_partner_config?restaurant_id=eq.${r.id}&select=*&limit=1`),
    api(`mev_devices?restaurant_id=eq.${r.id}&device_key=eq.mev-operator-key&select=*&limit=1`),
  ]);
  return {
    restaurant: r,
    settings: settingsRows?.[0] || null,
    kitchenPrinter: printerRows?.find((p) => p.role === 'kitchen') || null,
    receiptPrinter: printerRows?.find((p) => p.role === 'receipt') || null,
    partnerConfig: partnerRows?.[0] || null,
    device: deviceRows?.[0] || null,
  };
}

const manuallyAdvanced = new Set();

const STEPS = [
  {
    key: 'welcome',
    label: 'Bienvenue',
    title: 'Bienvenue dans Resto360',
    blurb: "On configure ton restaurant en quatre courtes étapes : tes informations pour Revenu Québec, tes imprimantes, ton certificat de facturation obligatoire (MEV-WEB), puis le mode de transmission. Tu peux revenir ici n'importe quand depuis « Démarrage ».",
    isComplete: () => true,
    render(body) {
      body.innerHTML = `<p class="muted">Compte les points avec toi le temps que ça prenne — rien n'est envoyé à Revenu Québec avant que tu cliques toi-même sur les boutons d'envoi.</p>`;
    },
  },
  {
    key: 'company',
    label: 'Ton restaurant',
    title: 'Les informations de ton restaurant',
    blurb: "Ces informations paraissent sur tes factures et reçus, et Revenu Québec les exige. Le nom légal et les deux numéros d'inscription (TPS/TVQ) sont obligatoires pour continuer.",
    isComplete: (state) => !!(state?.restaurant?.legal_name && state?.restaurant?.gst_number && state?.restaurant?.qst_number),
    render(body, state, refresh) {
      const r = state.restaurant;
      body.innerHTML = `
        <label>Nom légal de l'entreprise *<input id="wizLegalName" value="${esc(r.legal_name || '')}" placeholder="Nom sous lequel tu fais des affaires"></label>
        <label>Adresse<input id="wizAddress" value="${esc(r.address || '')}" placeholder="3800, rue de Marly"></label>
        <div class="form-two">
          <label>Ville<input id="wizCity" value="${esc(r.city || '')}" placeholder="Québec"></label>
          <label>Code postal<input id="wizPostalCode" value="${esc(r.postal_code || '')}" placeholder="G1X 4A5"></label>
        </div>
        <label>Téléphone<input id="wizPhone" value="${esc(r.phone || '')}" placeholder="418 555-5555"></label>
        <div class="form-two">
          <label>Numéro d'inscription TPS *<input id="wizGst" value="${esc(r.gst_number || '')}" placeholder="123456789 RT 0001"></label>
          <label>Numéro d'inscription TVQ *<input id="wizQst" value="${esc(r.qst_number || '')}" placeholder="1234567890 TQ 0001"></label>
        </div>
        <button id="wizSaveCompany" class="btn primary">Enregistrer</button>
        <div id="wizCompanyResult" class="muted"></div>
      `;
      body.querySelector('#wizSaveCompany').onclick = async () => {
        try {
          const patch = {
            legal_name: body.querySelector('#wizLegalName').value.trim() || null,
            address: body.querySelector('#wizAddress').value.trim() || null,
            city: body.querySelector('#wizCity').value.trim() || null,
            postal_code: body.querySelector('#wizPostalCode').value.trim() || null,
            phone: body.querySelector('#wizPhone').value.trim() || null,
            gst_number: body.querySelector('#wizGst').value.trim() || null,
            qst_number: body.querySelector('#wizQst').value.trim() || null,
          };
          const d = (await api(`restaurants?id=eq.${r.id}`, { method: 'PATCH', body: patch }))[0];
          Object.assign(r, d);
          body.querySelector('#wizCompanyResult').textContent = 'Enregistré.';
          await refresh();
        } catch (e) { body.querySelector('#wizCompanyResult').textContent = `Erreur : ${e.message}`; }
      };
    },
  },
  {
    key: 'printers',
    label: 'Imprimantes',
    title: 'Tes imprimantes réseau',
    blurb: "Optionnel — tu peux le faire plus tard dans Gestion. Si tu n'as pas encore l'adresse IP de tes imprimantes sous la main, clique sur Suivant.",
    optional: true,
    isComplete: () => true,
    render(body, state, refresh) {
      body.innerHTML = `
        <label>Imprimante cuisine<input id="wizKitchenIp" value="${esc(state.kitchenPrinter?.ip_address || '')}" placeholder="192.168.1.50"></label>
        <label>Imprimante reçu<input id="wizReceiptIp" value="${esc(state.receiptPrinter?.ip_address || '')}" placeholder="192.168.1.51"></label>
        <button id="wizSavePrinters" class="btn primary">Enregistrer</button>
        <div id="wizPrintersResult" class="muted"></div>
      `;
      async function savePrinter(role, existing, ip) {
        if (existing) return (await api(`printers?id=eq.${existing.id}`, { method: 'PATCH', body: { ip_address: ip, port: 9100, enabled: !!ip } }))[0];
        if (ip) return (await api('printers', { method: 'POST', body: { restaurant_id: state.restaurant.id, name: role === 'kitchen' ? 'Cuisine' : 'Reçu', role, ip_address: ip, port: 9100, enabled: true } }))[0];
        return null;
      }
      body.querySelector('#wizSavePrinters').onclick = async () => {
        try {
          await savePrinter('kitchen', state.kitchenPrinter, body.querySelector('#wizKitchenIp').value.trim());
          await savePrinter('receipt', state.receiptPrinter, body.querySelector('#wizReceiptIp').value.trim());
          body.querySelector('#wizPrintersResult').textContent = 'Enregistré.';
          await refresh();
        } catch (e) { body.querySelector('#wizPrintersResult').textContent = `Erreur : ${e.message}`; }
      };
    },
  },
  {
    key: 'mev',
    label: 'Certificat MEV-WEB',
    title: 'Facturation obligatoire — obtenir ton certificat MEV-WEB',
    blurb: null,
    // Not `optional` -- a real certificate is legally required, never something to skip -- but
    // it must not lock "Suivant" either: getting one depends on a code Revenu Québec mails
    // after partner enrolment, which can take days/weeks and has nothing to do with whether the
    // rest of the wizard can proceed (Simulation mode, next step, needs no certificate at all).
    neverBlocks: true,
    isComplete: (state) => !!(state?.partnerConfig?.authorization_code && state?.partnerConfig?.dossier_number && state?.partnerConfig?.id_partn && state?.partnerConfig?.id_sev),
    render(body, state, refresh) {
      body.innerHTML = `
        <ol class="wizard-explainer">
          <li>Inscris-toi comme partenaire dans ton compte <strong>Mon dossier pour les partenaires</strong>, sur le site de Revenu Québec, si ce n'est pas déjà fait.</li>
          <li>Revenu Québec t'envoie par la poste un numéro de dossier et un code d'autorisation, et t'attribue un IDPARTN / IDSEV / IDVERSI.</li>
          <li>Entre ces informations ci-dessous, puis clique sur « Générer une clé et un CSR », puis « Envoyer la requête certificats ».</li>
        </ol>
        <p class="muted">Tu peux continuer sans certificat pour l'instant : le mode Simulation (prochaine étape) laisse tester tout le système sans rien envoyer de réel à Revenu Québec.</p>
        <div id="wizMevHost"></div>
      `;
      renderMevEnrollmentInto(body.querySelector('#wizMevHost'), { onChange: refresh }).catch((e) => {
        body.querySelector('#wizMevHost').textContent = e.message;
      });
    },
  },
  {
    key: 'mode',
    label: 'Mode de transmission',
    title: 'Choisis ton mode de transmission',
    blurb: null,
    isComplete: () => true,
    render(body, state, refresh) {
      const current = state.settings?.mev_mode || 'simulator';
      body.innerHTML = `
        <div class="wizard-mode-choices">
          <button class="wizard-mode-choice ${current === 'simulator' ? 'active' : ''}" data-mode="simulator">
            <strong>Simulation</strong><span>Recommandé pour commencer. Le circuit facture → transmission → journal fonctionne au complet, mais rien n'est envoyé à Revenu Québec.</span>
          </button>
          <button class="wizard-mode-choice ${current === 'live' ? 'active' : ''}" data-mode="live">
            <strong>Réel</strong><span>Transmet vraiment tes ventes à Revenu Québec. Nécessite un certificat actif (étape précédente).</span>
          </button>
        </div>
        <div id="wizModeResult" class="muted"></div>
      `;
      body.querySelectorAll('[data-mode]').forEach((btn) => {
        btn.onclick = async () => {
          try {
            const mode = btn.dataset.mode;
            const d = (await api(`app_settings?restaurant_id=eq.${state.restaurant.id}`, { method: 'PATCH', body: { mev_mode: mode, updated_at: new Date().toISOString() } }))[0];
            state.settings = { ...state.settings, ...d };
            body.querySelector('#wizModeResult').textContent = mode === 'live' ? 'Mode réel activé.' : 'Mode simulation activé.';
            manuallyAdvanced.add('mode');
            await refresh();
          } catch (e) { body.querySelector('#wizModeResult').textContent = `Erreur : ${e.message}`; }
        };
      });
    },
  },
  {
    key: 'done',
    label: "C'est prêt",
    title: "C'est prêt !",
    blurb: null,
    isComplete: () => true,
    render(body, state) {
      const companyDone = STEPS.find((s) => s.key === 'company').isComplete(state);
      const mevDone = STEPS.find((s) => s.key === 'mev').isComplete(state);
      body.innerHTML = `
        <ul class="wizard-summary">
          <li>${companyDone ? '✓' : '○'} Informations du restaurant</li>
          <li>${mevDone ? '✓' : '○'} Inscription partenaire MEV-WEB${mevDone ? '' : ' (à compléter quand tu auras reçu ton code d\'autorisation)'}</li>
          <li>${state.device?.certificate_status === 'active' ? '✓' : '○'} Certificat MEV-WEB actif</li>
        </ul>
        <button id="wizGoToPos" class="btn primary full">Aller au POS</button>
      `;
      body.querySelector('#wizGoToPos').onclick = () => document.querySelector('[data-nav="tablesScreen"]')?.click();
    },
  },
];

let currentIndex = 0;
let cachedState = null;

async function refreshState() {
  cachedState = await loadState();
  return cachedState;
}

function updateNavBadge(state) {
  const badge = $('#onboardingNavBadge');
  if (!badge) return;
  const companyDone = STEPS.find((s) => s.key === 'company').isComplete(state);
  badge.hidden = companyDone;
}

function renderSidebar(host) {
  host.innerHTML = STEPS.map((step, i) => {
    const done = step.isComplete(cachedState) || manuallyAdvanced.has(step.key);
    const cls = ['wizard-step-item'];
    if (i === currentIndex) cls.push('active');
    if (done) cls.push('done');
    return `<button class="${cls.join(' ')}" data-step-index="${i}"><span class="wizard-step-num">${done ? '✓' : i + 1}</span><span>${esc(step.label)}${step.optional ? ' <span class="muted-inline">(optionnel)</span>' : ''}</span></button>`;
  }).join('');
  host.querySelectorAll('[data-step-index]').forEach((btn) => {
    btn.onclick = () => { currentIndex = Number(btn.dataset.stepIndex); renderAll(); };
  });
}

function renderStep(root) {
  const step = STEPS[currentIndex];
  const panel = root.querySelector('#wizardPanel');
  const canAdvance = step.isComplete(cachedState) || step.optional || step.neverBlocks || manuallyAdvanced.has(step.key);
  panel.innerHTML = `
    <div class="wizard-step-head">
      <span class="eyebrow">Étape ${currentIndex + 1} de ${STEPS.length}</span>
      <h2>${esc(step.title)}</h2>
      ${step.blurb ? `<p class="muted">${step.blurb}</p>` : ''}
    </div>
    <div id="wizardStepBody"></div>
    <div class="wizard-nav-buttons">
      <button id="wizardBack" class="btn ghost" ${currentIndex === 0 ? 'disabled' : ''}>← Précédent</button>
      <button id="wizardNext" class="btn primary" ${canAdvance ? '' : 'disabled'} ${currentIndex === STEPS.length - 1 ? 'hidden' : ''}>Suivant →</button>
    </div>
  `;
  step.render(panel.querySelector('#wizardStepBody'), cachedState, async () => {
    await refreshState();
    renderAll();
  });
  panel.querySelector('#wizardBack').onclick = () => { currentIndex = Math.max(0, currentIndex - 1); renderAll(); };
  const next = panel.querySelector('#wizardNext');
  if (next) next.onclick = () => { currentIndex = Math.min(STEPS.length - 1, currentIndex + 1); renderAll(); };
}

function renderAll() {
  const root = $('#onboardingRoot');
  if (!root) return;
  renderSidebar(root.querySelector('#wizardSidebar'));
  renderStep(root);
  updateNavBadge(cachedState);
}

let loaded = false;

// Called every time #onboardingScreen actually becomes the visible screen, not just once at
// page load -- the very first attempt can run before login (no session yet), and a one-time
// boot would leave that failure cached on screen forever, even once the user reaches this
// screen for real through the post-login auto-redirect.
async function boot() {
  const root = $('#onboardingRoot');
  if (!root) return;
  if (!root.querySelector('.wizard-shell')) {
    root.innerHTML = `<div class="wizard-shell"><aside id="wizardSidebar" class="wizard-steps"></aside><div id="wizardPanel" class="wizard-panel"></div></div>`;
  }
  try {
    await refreshState();
    if (!cachedState) { root.textContent = 'Aucun restaurant trouvé.'; return; }
    if (!loaded) {
      currentIndex = Math.max(0, STEPS.findIndex((s) => !s.isComplete(cachedState) && !s.optional));
      loaded = true;
    }
    renderAll();
  } catch (e) {
    root.textContent = `Erreur : ${e.message}`;
    loaded = false;
  }
}

function watchScreenActivation() {
  const screen = $('#onboardingScreen');
  if (!screen) return;
  new MutationObserver(() => { if (screen.classList.contains('active')) boot(); })
    .observe(screen, { attributes: true, attributeFilter: ['class'] });
}

function installStyles() {
  if ($('#onboardingWizardStyles')) return;
  const style = document.createElement('style');
  style.id = 'onboardingWizardStyles';
  style.textContent = `
    .wizard-shell{display:grid;grid-template-columns:230px minmax(0,1fr);gap:20px;align-items:start}
    .wizard-steps{display:grid;gap:6px;position:sticky;top:0}
    .wizard-step-item{display:flex;align-items:center;gap:10px;text-align:left;border:1px solid var(--line);background:#fff;border-radius:12px;padding:10px 12px;font-weight:600;color:#565a63}
    .wizard-step-item.active{border-color:var(--accent);background:#fff6ee;color:var(--ink)}
    .wizard-step-item.done .wizard-step-num{background:var(--good);color:#fff}
    .wizard-step-num{width:22px;height:22px;border-radius:50%;background:#e4e4e7;color:#565a63;display:grid;place-items:center;font-size:12px;font-weight:800;flex:0 0 auto}
    .wizard-panel{background:#fff;border:1px solid var(--line);border-radius:16px;padding:22px;min-height:320px}
    .wizard-step-head h2{margin:4px 0 6px}
    .wizard-step-head .eyebrow{color:var(--accent)}
    .wizard-nav-buttons{display:flex;justify-content:space-between;gap:10px;margin-top:20px}
    .wizard-explainer{margin:0 0 14px;padding-left:20px;display:grid;gap:6px;font-size:14px}
    .wizard-mode-choices{display:grid;gap:12px}
    .wizard-mode-choice{text-align:left;border:2px solid var(--line);background:#fff;border-radius:14px;padding:14px 16px;display:grid;gap:4px}
    .wizard-mode-choice.active{border-color:var(--accent);background:#fff6ee}
    .wizard-mode-choice span{font-size:13px;color:var(--muted)}
    .wizard-summary{list-style:none;margin:0 0 16px;padding:0;display:grid;gap:8px;font-size:15px}
    #onboardingStepBody label,#wizardStepBody label{display:grid;gap:6px;font-size:12px;font-weight:750;color:#3f4249;margin-bottom:10px}
    #wizardStepBody input{border:1px solid #d1d5db;border-radius:10px;padding:11px;background:#fff;outline:none}
    .nav-badge{width:8px;height:8px;border-radius:50%;background:var(--accent);position:absolute;top:8px;right:16px}
    @media(max-width:820px){.wizard-shell{grid-template-columns:1fr}.wizard-steps{position:static;display:flex;overflow:auto;gap:8px}.wizard-step-item{flex:0 0 auto}}
  `;
  document.head.appendChild(style);
}

function watchFirstBoot() {
  const app = $('#app');
  if (!app) return;
  const observer = new MutationObserver(async () => {
    if (app.classList.contains('hidden')) return;
    try {
      const state = await refreshState();
      if (!state) return;
      updateNavBadge(state);
      const neverTouched = !state.restaurant.legal_name && !state.restaurant.gst_number && !state.restaurant.qst_number && !state.partnerConfig;
      if (neverTouched) document.querySelector('[data-nav="onboardingScreen"]')?.click();
    } catch { /* not logged in yet, or offline -- silently skip the first-boot nudge */ }
  });
  observer.observe(app, { attributes: true, attributeFilter: ['class'] });
}

function init() {
  installStyles();
  watchScreenActivation();
  watchFirstBoot();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
