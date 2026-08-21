const CFG = window.RESTO360_CONFIG || {};
const API = `${CFG.supabaseUrl}/rest/v1`;
const AUTH_KEY = CFG.supabasePublishableKey;
const SIM_URL = CFG.mevSimulatorUrl;
const POLL_MS = 8000;
let running = false;
let timer = null;

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = (n) => Number(n || 0).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });

function session() {
  try { return JSON.parse(localStorage.getItem('resto360-session') || 'null'); }
  catch { return null; }
}

function headers(extra = {}) {
  const s = session();
  return {
    apikey: AUTH_KEY,
    Authorization: `Bearer ${s?.access_token || AUTH_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rest(path, { method = 'GET', body, prefer = 'return=representation' } = {}) {
  const s = session();
  if (!s?.access_token) throw new Error('Non connecté');
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: headers(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.hint || `Supabase ${r.status}`);
  return data;
}

async function restaurantId() {
  const rows = await rest('restaurants?select=id&order=created_at.asc&limit=1');
  return rows?.[0]?.id || null;
}

function installUi() {
  if ($('#fiscalHealth')) return;
  const banner = document.createElement('div');
  banner.id = 'fiscalHealth';
  banner.className = 'fiscal-health hidden';
  document.body.appendChild(banner);

  const grid = $('#settingsScreen .settings-grid');
  if (grid) {
    const card = document.createElement('section');
    card.className = 'settings-card';
    card.innerHTML = `
      <div class="card-head">
        <div><h2>État MEV</h2><p class="muted">File fiscale, reçus à imprimer et appareil.</p></div>
        <button id="mevRetryNow" class="btn">Réessayer</button>
      </div>
      <div id="mevRuntimeStatus" class="status-panel"><strong>Initialisation…</strong><span></span></div>
      <div id="mevDeviceStatus" class="admin-list"></div>`;
    grid.appendChild(card);
    $('#mevRetryNow').onclick = () => tick(true);
  }

  const style = document.createElement('style');
  style.textContent = `
    .fiscal-health{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;max-width:min(760px,calc(100vw - 32px));padding:12px 16px;border-radius:12px;background:#7f1d1d;color:#fff;font-weight:700;box-shadow:0 10px 30px rgba(0,0,0,.3)}
    .fiscal-health.hidden{display:none}.fiscal-health.ok{background:#14532d}.fiscal-health.warn{background:#78350f}
    #mevDeviceStatus .admin-row{margin-top:8px}
  `;
  document.head.appendChild(style);
}

function showHealth(kind, text) {
  const el = $('#fiscalHealth');
  if (!el) return;
  if (!text) {
    el.className = 'fiscal-health hidden';
    el.textContent = '';
    return;
  }
  el.className = `fiscal-health ${kind}`;
  el.textContent = text;
}

async function ensureSimulatorDevice(rid) {
  const devices = await rest(`mev_devices?restaurant_id=eq.${rid}&device_key=eq.resto360-simulator&select=*&limit=1`);
  if (devices?.length) return devices[0];
  const created = await rest('mev_devices', {
    method: 'POST',
    body: {
      restaurant_id: rid,
      device_key: 'resto360-simulator',
      environment: 'simulator',
      status: 'active',
      certificate_status: 'active',
      metadata: { simulated: true, transport: 'supabase-edge' },
    },
  });
  return created?.[0];
}

async function getSettings(rid) {
  const rows = await rest(`app_settings?restaurant_id=eq.${rid}&select=*&limit=1`);
  return rows?.[0] || { mev_mode: 'simulator' };
}

async function nextAttemptNo(invoiceId) {
  const rows = await rest(`mev_attempts?invoice_id=eq.${invoiceId}&select=attempt_no&order=attempt_no.desc&limit=1`);
  return Number(rows?.[0]?.attempt_no || 0) + 1;
}

async function invoicePayload(invoiceId) {
  const invoices = await rest(`invoices?id=eq.${invoiceId}&select=*&limit=1`);
  const inv = invoices?.[0];
  if (!inv) throw new Error('Facture introuvable');
  const lines = await rest(`invoice_items?invoice_id=eq.${invoiceId}&select=*`);
  const ids = [...new Set((lines || []).map(x => x.order_item_id).filter(Boolean))];
  let names = new Map();
  if (ids.length) {
    const encoded = ids.map(id => `"${id}"`).join(',');
    const items = await rest(`order_items?id=in.(${encoded})&select=id,name,notes`);
    names = new Map((items || []).map(i => [i.id, i]));
  }
  return {
    id: inv.id,
    order_id: inv.order_id,
    subtotal: Number(inv.subtotal),
    gst: Number(inv.gst),
    qst: Number(inv.qst),
    total: Number(inv.total),
    tip: Number(inv.tip_amount || 0),
    payment_total: Number(inv.payment_total || inv.total),
    items: (lines || []).map(l => ({
      name: names.get(l.order_item_id)?.name || 'Article',
      notes: names.get(l.order_item_id)?.notes || null,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      line_total: Number(l.line_total),
    })),
  };
}

async function transmitSimulator(rid, invoiceId, simulate = 'accepted') {
  if (!SIM_URL) throw new Error('mevSimulatorUrl manquante');
  const payload = await invoicePayload(invoiceId);
  payload.simulate = simulate;
  const sentAt = new Date().toISOString();
  let r;
  let data = {};
  try {
    r = await fetch(SIM_URL, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
    data = await r.json().catch(() => ({}));
  } catch (e) {
    const no = await nextAttemptNo(invoiceId);
    await rest('mev_attempts', {
      method: 'POST',
      body: {
        restaurant_id: rid,
        invoice_id: invoiceId,
        environment: 'simulator',
        attempt_no: no,
        operation: 'sale_close',
        request_payload: payload,
        status: 'network_error',
        error_code: 'NETWORK_ERROR',
        error_message: e.message,
        sent_at: sentAt,
        retry_after: new Date(Date.now() + 60000).toISOString(),
      },
    });
    return { status: 'network_error' };
  }

  const status = data.status === 'accepted'
    ? 'accepted'
    : data.retryable || data.status === 'timeout' || r.status >= 500
      ? 'retryable'
      : data.status === 'rejected' || r.status === 422
        ? 'rejected'
        : r.ok ? 'accepted' : 'failed';
  const no = await nextAttemptNo(invoiceId);
  await rest('mev_attempts', {
    method: 'POST',
    body: {
      restaurant_id: rid,
      invoice_id: invoiceId,
      environment: 'simulator',
      attempt_no: no,
      operation: 'sale_close',
      request_payload: payload,
      response_payload: data,
      status,
      http_status: r.status,
      error_code: data.error_code || null,
      error_message: data.error || data.error_message || null,
      transaction_id: data.transaction_id || null,
      document_id: data.document_id || data.receipt?.document_id || null,
      remote_status: data.remote_status || null,
      qr_payload: data.qr_payload || data.receipt?.qr_payload || null,
      sent_at: sentAt,
      received_at: new Date().toISOString(),
      retry_after: status === 'retryable' ? new Date(Date.now() + 60000).toISOString() : null,
    },
  });
  return { status, data };
}

async function recoverOrphanInvoices(rid) {
  const candidates = await rest(`invoices?restaurant_id=eq.${rid}&status=in.(pending_mev,failed,retryable)&select=id,status,created_at&order=created_at.asc&limit=20`);
  for (const inv of candidates || []) {
    const tx = await rest(`mev_transactions?invoice_id=eq.${inv.id}&select=id&limit=1`);
    if (tx?.length) continue;
    const no = await nextAttemptNo(inv.id);
    await rest('mev_attempts', {
      method: 'POST',
      body: {
        restaurant_id: rid,
        invoice_id: inv.id,
        environment: 'simulator',
        attempt_no: no,
        operation: 'sale_close',
        request_payload: { recovered_invoice_id: inv.id },
        status: 'retryable',
        error_code: 'RECOVERED_ORPHAN',
        error_message: 'Facture récupérée par la file MEV locale.',
        retry_after: new Date().toISOString(),
      },
    });
  }
}

async function processQueue(rid, force = false) {
  const settings = await getSettings(rid);
  if (settings.mev_mode === 'disabled') return;
  if (settings.mev_mode === 'live') {
    showHealth('warn', 'MEV production verrouillé : certificats et transport officiel requis.');
    return;
  }
  const rows = await rest(`mev_transactions?restaurant_id=eq.${rid}&status=in.(pending,retryable)&select=*&order=created_at.asc&limit=10`);
  const now = Date.now();
  for (const tx of rows || []) {
    if (!force && tx.retry_after && new Date(tx.retry_after).getTime() > now) continue;
    if (Number(tx.attempt_count || 0) >= 8) {
      await rest('rpc/mev_transaction_mark_exhausted', { method: 'POST', body: { p_invoice_id: tx.invoice_id, p_message: 'Nombre maximal de tentatives atteint' } });
      continue;
    }
    await rest('rpc/mev_transaction_mark_sending', { method: 'POST', body: { p_invoice_id: tx.invoice_id } });
    await transmitSimulator(rid, tx.invoice_id);
    await sleep(120);
  }
}

async function receiptText(receipt) {
  const invRows = await rest(`invoices?id=eq.${receipt.invoice_id}&select=*&limit=1`);
  const inv = invRows?.[0];
  if (!inv) throw new Error('Facture du reçu introuvable');
  const payload = await invoicePayload(receipt.invoice_id);
  const bizRows = await rest(`restaurants?id=eq.${receipt.restaurant_id}&select=name,legal_name,address,city,postal_code,phone,gst_number,qst_number&limit=1`);
  const biz = bizRows?.[0] || {};
  const payRows = await rest(`payments?invoice_id=eq.${receipt.invoice_id}&select=method&limit=1`);
  const leftWithoutPaying = payRows?.[0]?.method === 'left_without_paying';
  const addr = [biz.address, [biz.city, biz.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const lines = payload.items.map(i => `${i.quantity} x ${i.name}  ${money(i.line_total)}`);
  return [
    biz.legal_name || biz.name || 'Restaurant',
    biz.phone || null,
    addr || null,
    'PAIEMENT REÇU',
    leftWithoutPaying ? 'PARTI SANS PAYER' : null,
    '',
    ...lines,
    '',
    `Sous-total ${money(inv.subtotal)}`,
    biz.gst_number ? `TPS ${biz.gst_number} ${money(inv.gst)}` : `TPS ${money(inv.gst)}`,
    biz.qst_number ? `TVQ ${biz.qst_number} ${money(inv.qst)}` : `TVQ ${money(inv.qst)}`,
    `Pourboire ${money(inv.tip_amount || 0)}`,
    `TOTAL ${money(inv.payment_total || inv.total)}`,
    '',
    `MEV ${receipt.fiscal_document_id || ''}`,
    receipt.is_simulated ? 'SIMULATION - NON FISCAL' : '',
    receipt.qr_payload || '',
    '',
  ].filter(x => x !== null && x !== undefined).join('\n');
}

async function receiptPrinter(rid) {
  const rows = await rest(`printers?restaurant_id=eq.${rid}&role=eq.receipt&enabled=eq.true&select=ip_address,port&limit=1`);
  return rows?.[0] || null;
}

async function printReceiptRow(rid, receipt) {
  const printer = await receiptPrinter(rid);
  if (!printer?.ip_address) throw new Error('Imprimante reçu non configurée');
  const text = await receiptText(receipt);
  const r = await fetch('/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: printer.ip_address, port: printer.port || 9100, text, cut: true }),
  });
  if (!r.ok) throw new Error('Imprimante reçu inaccessible');
}

async function processUnprintedReceipts(rid) {
  const rows = await rest(`mev_receipts?restaurant_id=eq.${rid}&printed_at=is.null&select=*&order=created_at.asc&limit=10`);
  for (const receipt of rows || []) {
    try {
      await printReceiptRow(rid, receipt);
      await rest('rpc/mev_receipt_mark_printed', { method: 'POST', body: { p_receipt_id: receipt.id } });
    } catch (e) {
      await rest('rpc/mev_receipt_mark_print_failed', { method: 'POST', body: { p_receipt_id: receipt.id, p_message: e.message } });
      break;
    }
  }
}

async function refreshHealth(rid) {
  const [txs, receipts, devices] = await Promise.all([
    rest(`mev_transactions?restaurant_id=eq.${rid}&status=in.(pending,sending,retryable,rejected,failed)&select=id,status`),
    rest(`mev_receipts?restaurant_id=eq.${rid}&printed_at=is.null&select=id,last_print_error`),
    rest(`mev_devices?restaurant_id=eq.${rid}&select=*&order=created_at.asc`),
  ]);
  const retry = (txs || []).filter(x => ['pending','sending','retryable'].includes(x.status)).length;
  const blocked = (txs || []).filter(x => ['rejected','failed'].includes(x.status)).length;
  const unprinted = (receipts || []).length;

  const panel = $('#mevRuntimeStatus');
  if (panel) {
    panel.querySelector('strong').textContent = retry || blocked || unprinted ? 'Attention requise' : 'MEV prêt';
    panel.querySelector('span').textContent = `${retry} en attente · ${blocked} en erreur · ${unprinted} reçu${unprinted === 1 ? '' : 's'} à imprimer`;
  }
  const deviceBox = $('#mevDeviceStatus');
  if (deviceBox) {
    deviceBox.innerHTML = (devices || []).map(d => `<div class="admin-row"><div><strong>${d.device_key}</strong><span>${d.environment} · appareil ${d.status} · certificat ${d.certificate_status}</span></div></div>`).join('') || '<div class="muted">Aucun appareil MEV.</div>';
  }

  if (unprinted) showHealth('warn', `${unprinted} reçu de fermeture à imprimer — Resto360 réessaie automatiquement.`);
  else if (blocked) showHealth('warn', `${blocked} transaction MEV en erreur — vérification requise.`);
  else if (retry) showHealth('warn', `${retry} transaction MEV en attente de retransmission.`);
  else showHealth('', '');
}

async function tick(force = false) {
  if (running || !session()?.access_token || !CFG.supabaseUrl) return;
  running = true;
  try {
    installUi();
    const rid = await restaurantId();
    if (!rid) return;
    await ensureSimulatorDevice(rid);
    await recoverOrphanInvoices(rid);
    await processQueue(rid, force);
    await processUnprintedReceipts(rid);
    await refreshHealth(rid);
  } catch (e) {
    showHealth('warn', `MEV runtime : ${e.message}`);
  } finally {
    running = false;
  }
}

function start() {
  installUi();
  clearInterval(timer);
  timer = setInterval(() => tick(false), POLL_MS);
  setTimeout(() => tick(false), 1200);
  window.addEventListener('online', () => tick(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(false); });
}

start();
