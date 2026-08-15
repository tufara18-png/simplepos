const CFG = window.SIMPLEPOS_CONFIG;
const SB = CFG.supabaseUrl;
const KEY = CFG.supabasePublishableKey;
const API = `${SB}/rest/v1`;
const AUTH = `${SB}/auth/v1`;
const TAX_DEFAULT = { gst: 0.05, qst: 0.09975 };

let session = JSON.parse(localStorage.getItem('simplepos-session') || 'null');
let user = null;
let restaurant = null;
let settings = null;
let tables = [];
let products = [];
let orders = [];
let orderItems = [];
let invoices = [];
let printers = [];
let tipPresets = [];
let activeOrder = null;
let selectedItemIds = new Set();
let activeCategory = 'TOUS';
let tip = { mode: 'none', value: 0, amount: 0 };
let liveTimer = null;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => Number(n || 0).toLocaleString('fr-CA', { style: 'currency', currency: 'CAD' });
const round2 = n => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const uid = () => crypto.randomUUID();

function toast(message, type = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.type = type;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function setConnected(ok, text = ok ? 'Supabase connecté' : 'Hors ligne') {
  $('#liveDot').classList.toggle('down', !ok);
  $('#connectionLabel').textContent = text;
}

function authHeaders(extra = {}) {
  return {
    apikey: KEY,
    Authorization: `Bearer ${session?.access_token || KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function authRequest(path, body) {
  const r = await fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.msg || data.error_description || data.message || 'Erreur d’authentification');
  return data;
}

async function rest(path, { method = 'GET', body, prefer = 'return=representation' } = {}) {
  if (!session?.access_token) throw new Error('Non connecté');
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: authHeaders(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (r.status === 401 && session?.refresh_token) {
    await refreshSession();
    return rest(path, { method, body, prefer });
  }
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.message || data?.hint || data?.details || `Supabase ${r.status}`);
  return data;
}

async function refreshSession() {
  const data = await authRequest('/token?grant_type=refresh_token', { refresh_token: session.refresh_token });
  session = data;
  localStorage.setItem('simplepos-session', JSON.stringify(session));
  user = session.user;
}

function logout() {
  localStorage.removeItem('simplepos-session');
  session = null;
  user = null;
  restaurant = null;
  clearInterval(liveTimer);
  $('#app').classList.add('hidden');
  $('#authScreen').classList.remove('hidden');
}

async function login(email, password) {
  const data = await authRequest('/token?grant_type=password', { email, password });
  session = data;
  user = data.user;
  localStorage.setItem('simplepos-session', JSON.stringify(data));
  await boot();
}

async function signup(email, password) {
  const data = await authRequest('/signup', { email, password });
  if (!data.access_token) throw new Error('Compte créé. Confirme le courriel si Supabase le demande, puis connecte-toi.');
  session = data;
  user = data.user;
  localStorage.setItem('simplepos-session', JSON.stringify(data));
  await boot();
}

async function ensureRestaurant() {
  const mine = await rest('restaurants?select=*&order=created_at.asc&limit=1');
  if (mine?.length) {
    restaurant = mine[0];
    return;
  }
  const created = await rest('restaurants', { method: 'POST', body: { name: 'Mon restaurant', owner_id: user.id } });
  restaurant = created[0];
  const rid = restaurant.id;
  await rest('app_settings', { method: 'POST', body: { restaurant_id: rid } });
  await rest('restaurant_tables', {
    method: 'POST',
    body: [1,2,3,4,5,6,7,8].map((n,i) => ({ restaurant_id: rid, number: n, sort_order: i }))
  });
  await rest('tip_presets', {
    method: 'POST',
    body: [15,18,20].map((p,i) => ({ restaurant_id: rid, label: `${p} %`, percentage: p, sort_order: i }))
  });
}

async function loadAll(silent = false) {
  if (!restaurant) return;
  const rid = restaurant.id;
  try {
    const [t,p,o,oi,inv,pr,tp,as] = await Promise.all([
      rest(`restaurant_tables?restaurant_id=eq.${rid}&active=eq.true&select=*&order=sort_order.asc,number.asc`),
      rest(`products?restaurant_id=eq.${rid}&active=eq.true&select=*&order=category.asc,sort_order.asc,name.asc`),
      rest(`orders?restaurant_id=eq.${rid}&status=in.(open,partially_paid)&select=*&order=opened_at.asc`),
      rest('order_items?select=*&order=created_at.asc'),
      rest(`invoices?restaurant_id=eq.${rid}&select=*&order=created_at.desc&limit=100`),
      rest(`printers?restaurant_id=eq.${rid}&enabled=eq.true&select=*`),
      rest(`tip_presets?restaurant_id=eq.${rid}&active=eq.true&select=*&order=sort_order.asc`),
      rest(`app_settings?restaurant_id=eq.${rid}&select=*&limit=1`)
    ]);
    tables = t || [];
    products = p || [];
    orders = o || [];
    invoices = inv || [];
    printers = pr || [];
    tipPresets = tp || [];
    const orderIds = new Set(orders.map(x => x.id));
    orderItems = (oi || []).filter(x => orderIds.has(x.order_id));
    settings = as?.[0] || {
      restaurant_id: rid,
      ...TAX_DEFAULT,
      tips_enabled: true,
      tip_basis: 'after_tax',
      mev_mode: 'simulator'
    };
    setConnected(true);
    if (!silent) renderCurrent();
  } catch (e) {
    setConnected(false);
    if (!silent) toast(e.message, 'error');
  }
}

async function boot() {
  if (!session?.access_token) return;
  user = session.user;
  try {
    await ensureRestaurant();
    await loadAll(true);
    $('#restaurantName').textContent = restaurant.name;
    $('#authScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    show('tablesScreen');
    clearInterval(liveTimer);
    liveTimer = setInterval(() => loadAll(true).then(renderCurrent), 5000);
  } catch (e) {
    if (/JWT|token|401|expired/i.test(e.message)) logout();
    else $('#authError').textContent = e.message;
  }
}

function calcTax(subtotal) {
  const gstRate = Number(settings?.tax_gst ?? TAX_DEFAULT.gst);
  const qstRate = Number(settings?.tax_qst ?? TAX_DEFAULT.qst);
  const gst = round2(subtotal * gstRate);
  const qst = round2(subtotal * qstRate);
  return { gst, qst, total: round2(subtotal + gst + qst) };
}

function getOpenOrder(tableId) {
  return orders.find(o => o.table_id === tableId && ['open','partially_paid'].includes(o.status));
}

function itemsFor(orderId) {
  return orderItems.filter(i => i.order_id === orderId && i.kitchen_status !== 'cancelled' && Number(i.paid_quantity || 0) < Number(i.quantity || 1));
}

function orderSubtotal(orderId) {
  return round2(itemsFor(orderId).reduce((s,i) => s + Number(i.unit_price) * (Number(i.quantity) - Number(i.paid_quantity || 0)), 0));
}

function show(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  $$('.nav[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === id));
  renderCurrent();
}

function currentScreen() {
  return $('.screen.active')?.id;
}

function renderCurrent() {
  const s = currentScreen();
  if (s === 'tablesScreen') renderTables();
  if (s === 'orderScreen') renderOrder();
  if (s === 'payScreen') renderPay();
  if (s === 'historyScreen') renderHistory();
  if (s === 'settingsScreen') renderSettings();
}

function renderTables() {
  $('#pageContext').textContent = '';
  $('#tablesGrid').innerHTML = tables.map(t => {
    const o = getOpenOrder(t.id);
    const sub = o ? orderSubtotal(o.id) : 0;
    const tax = calcTax(sub);
    const age = o ? Math.max(1, Math.floor((Date.now() - new Date(o.opened_at).getTime()) / 60000)) : 0;
    return `<button class="table-card ${o ? 'occupied' : ''}" data-table="${t.id}">
      <div class="table-card-top"><strong>${escapeHtml(t.label || `Table ${t.number}`)}</strong><span>${o ? `${age} min` : 'Libre'}</span></div>
      ${o ? `<div class="table-total">${money(tax.total)}</div><div class="table-meta">${o.guest_count} client${o.guest_count > 1 ? 's' : ''} · ${itemsFor(o.id).length} article${itemsFor(o.id).length > 1 ? 's' : ''}</div>` : '<div class="table-empty">Ouvrir la table</div>'}
    </button>`;
  }).join('') || '<div class="empty-state">Aucune table.</div>';
  $$('[data-table]').forEach(b => b.onclick = () => openTable(b.dataset.table));
}

async function openTable(tableId) {
  let order = getOpenOrder(tableId);
  if (!order) {
    const data = await rest('orders', {
      method: 'POST',
      body: { restaurant_id: restaurant.id, table_id: tableId, guest_count: 1, created_by: user.id, status: 'open' }
    });
    order = data[0];
    orders.push(order);
  }
  activeOrder = order;
  selectedItemIds.clear();
  tip = { mode: 'none', value: 0, amount: 0 };
  show('orderScreen');
}

function renderCategories() {
  const categories = ['TOUS', ...new Set(products.map(p => p.category || 'AUTRES'))];
  if (!categories.includes(activeCategory)) activeCategory = 'TOUS';
  $('#categories').innerHTML = categories.map(c => `<button class="category-tab ${c === activeCategory ? 'active' : ''}" data-cat="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join('');
  $$('[data-cat]').forEach(b => b.onclick = () => {
    activeCategory = b.dataset.cat;
    renderOrder();
  });
}

function renderOrder() {
  if (!activeOrder) return show('tablesScreen');
  const table = tables.find(t => t.id === activeOrder.table_id);
  if (!table) return show('tablesScreen');
  $('#pageContext').textContent = ` · ${table.label || `Table ${table.number}`}`;
  $('#orderTableLabel').textContent = table.label || `Table ${table.number}`;
  $('#guestButton').textContent = `${activeOrder.guest_count} client${activeOrder.guest_count > 1 ? 's' : ''}`;
  renderCategories();
  const filtered = activeCategory === 'TOUS' ? products : products.filter(p => (p.category || 'AUTRES') === activeCategory);
  $('#products').innerHTML = filtered.map(p => `<button class="product-card" data-product="${p.id}"><span>${escapeHtml(p.name)}</span><strong>${money(p.price)}</strong></button>`).join('') || '<div class="empty-state">Aucun article dans cette catégorie. Ajoutez-les dans Réglages → Menu.</div>';
  $$('[data-product]').forEach(b => b.onclick = () => addProduct(b.dataset.product));
  const items = itemsFor(activeOrder.id);
  $('#ticketTitle').textContent = 'Commande';
  $('#ticketMeta').textContent = `${items.length} article${items.length !== 1 ? 's' : ''}`;
  $('#ticketList').innerHTML = items.map(i => `<div class="ticket-row"><div><strong>${escapeHtml(i.name)}</strong><span class="item-state ${i.kitchen_status}">${i.kitchen_status === 'sent' ? 'Envoyé' : 'Nouveau'}</span></div><span>${money(i.unit_price)}</span><button class="icon-btn" data-remove="${i.id}" aria-label="Retirer">×</button></div>`).join('') || '<div class="empty-state small-empty">Touchez un article du menu pour commencer.</div>';
  $$('[data-remove]').forEach(b => b.onclick = () => removeItem(b.dataset.remove));
  const sub = orderSubtotal(activeOrder.id);
  const tax = calcTax(sub);
  $('#ticketTotals').innerHTML = totalsHtml(sub, tax.gst, tax.qst, tax.total);
}

async function addProduct(productId) {
  const p = products.find(x => x.id === productId);
  if (!p || !activeOrder) return;
  const data = await rest('order_items', {
    method: 'POST',
    body: { order_id: activeOrder.id, product_id: p.id, name: p.name, unit_price: p.price, quantity: 1, paid_quantity: 0, kitchen_status: 'new' }
  });
  orderItems.push(data[0]);
  renderOrder();
}

async function removeItem(itemId) {
  const item = orderItems.find(i => i.id === itemId);
  if (!item) return;
  if (item.kitchen_status === 'sent' && !confirm('Cet article est déjà envoyé en cuisine. L’annuler?')) return;
  await rest(`order_items?id=eq.${itemId}`, { method: 'PATCH', body: { kitchen_status: 'cancelled' } });
  item.kitchen_status = 'cancelled';
  renderOrder();
}

async function updateGuests() {
  if (!activeOrder) return;
  const n = Number(prompt('Nombre de clients', activeOrder.guest_count));
  if (!Number.isInteger(n) || n < 1) return;
  await rest(`orders?id=eq.${activeOrder.id}`, { method: 'PATCH', body: { guest_count: n, updated_at: new Date().toISOString() } });
  activeOrder.guest_count = n;
  renderOrder();
}

function printer(role) {
  return printers.find(p => p.role === role && p.enabled);
}

async function savePrinter(role, ip) {
  const existing = printer(role);
  if (existing) {
    const d = await rest(`printers?id=eq.${existing.id}`, { method: 'PATCH', body: { ip_address: ip, port: 9100, enabled: true } });
    Object.assign(existing, d[0]);
  } else if (ip) {
    const d = await rest('printers', {
      method: 'POST',
      body: { restaurant_id: restaurant.id, name: role === 'kitchen' ? 'Cuisine' : 'Reçu', role, ip_address: ip, port: 9100, enabled: true }
    });
    printers.push(d[0]);
  }
}

async function printText(text, role) {
  const p = printer(role);
  if (!p?.ip_address) throw new Error(`IP imprimante ${role === 'kitchen' ? 'cuisine' : 'reçu'} manquante`);
  const r = await fetch('/print', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: p.ip_address, port: p.port || 9100, text, cut: true })
  });
  if (!r.ok) throw new Error('Imprimante inaccessible');
  return r.json();
}

async function sendKitchen() {
  const items = itemsFor(activeOrder.id).filter(i => i.kitchen_status === 'new');
  if (!items.length) return toast('Rien de nouveau à envoyer');
  const table = tables.find(t => t.id === activeOrder.table_id);
  const ticket = `CUISINE\n${table.label || `Table ${table.number}`}\n${items.map(i => `1 x ${i.name}${i.notes ? ` - ${i.notes}` : ''}`).join('\n')}\n`;
  try {
    await printText(ticket, 'kitchen');
  } catch (e) {
    if (!confirm(`${e.message}. Marquer quand même comme envoyé?`)) return;
  }
  await Promise.all(items.map(i => rest(`order_items?id=eq.${i.id}`, {
    method: 'PATCH',
    body: { kitchen_status: 'sent', kitchen_sent_at: new Date().toISOString() }
  })));
  items.forEach(i => {
    i.kitchen_status = 'sent';
    i.kitchen_sent_at = new Date().toISOString();
  });
  renderOrder();
  toast('Envoyé en cuisine');
}

function renderPay() {
  if (!activeOrder) return show('tablesScreen');
  const table = tables.find(t => t.id === activeOrder.table_id);
  const items = itemsFor(activeOrder.id);
  $('#payTableLabel').textContent = table.label || `Table ${table.number}`;
  selectedItemIds = new Set([...selectedItemIds].filter(id => items.some(i => i.id === id)));
  $('#payItems').innerHTML = items.map(i => `<button class="pay-row ${selectedItemIds.has(i.id) ? 'selected' : ''}" data-payitem="${i.id}"><span class="check">${selectedItemIds.has(i.id) ? '✓' : ''}</span><span>${escapeHtml(i.name)}</span><strong>${money(i.unit_price)}</strong></button>`).join('');
  $$('[data-payitem]').forEach(b => b.onclick = () => {
    selectedItemIds.has(b.dataset.payitem) ? selectedItemIds.delete(b.dataset.payitem) : selectedItemIds.add(b.dataset.payitem);
    tip = { mode: 'none', value: 0, amount: 0 };
    renderPay();
  });
  renderTipButtons();
  renderPaySummary();
}

function selectedItems() {
  const all = itemsFor(activeOrder.id);
  return selectedItemIds.size ? all.filter(i => selectedItemIds.has(i.id)) : all;
}

function selectedSubtotal() {
  return round2(selectedItems().reduce((s,i) => s + Number(i.unit_price) * (Number(i.quantity) - Number(i.paid_quantity || 0)), 0));
}

function tipBase(sub, tax) {
  return settings?.tip_basis === 'before_tax' ? sub : tax.total;
}

function computeTip(sub, tax) {
  if (!settings?.tips_enabled) return 0;
  if (tip.mode === 'percent') return round2(tipBase(sub, tax) * tip.value / 100);
  if (tip.mode === 'amount') return round2(tip.value);
  return 0;
}

function renderTipButtons() {
  const disabled = !settings?.tips_enabled;
  $('#tipButtons').innerHTML = disabled
    ? '<span class="muted">Désactivé dans Réglages</span>'
    : `<button class="seg ${tip.mode === 'none' ? 'active' : ''}" data-tip-none>Aucun</button>${tipPresets.map(p => `<button class="seg ${tip.mode === 'percent' && Number(tip.value) === Number(p.percentage) ? 'active' : ''}" data-tip="${p.percentage}">${Number(p.percentage)} %</button>`).join('')}`;
  $$('[data-tip]').forEach(b => b.onclick = () => {
    tip = { mode: 'percent', value: Number(b.dataset.tip), amount: 0 };
    renderPay();
  });
  $('[data-tip-none]')?.addEventListener('click', () => {
    tip = { mode: 'none', value: 0, amount: 0 };
    renderPay();
  });
  $('.tip-custom').style.display = disabled ? 'none' : 'flex';
}

function renderPaySummary() {
  const sub = selectedSubtotal();
  const tax = calcTax(sub);
  const tipAmount = computeTip(sub, tax);
  const paymentTotal = round2(tax.total + tipAmount);
  tip.amount = tipAmount;
  $('#selectedSummary').innerHTML = selectedItemIds.size
    ? `<div class="selection-note">${selectedItemIds.size} article${selectedItemIds.size > 1 ? 's' : ''} sélectionné${selectedItemIds.size > 1 ? 's' : ''}</div>`
    : '<div class="selection-note">Solde complet</div>';
  $('#payTotals').innerHTML = totalsHtml(sub, tax.gst, tax.qst, tax.total, tipAmount, paymentTotal);
  $('#tipSummary').textContent = tipAmount ? `Pourboire : ${money(tipAmount)}` : '';
}

function totalsHtml(sub, gst, qst, total, tipAmount = 0, paymentTotal = null) {
  return `<div class="total-line"><span>Sous-total</span><span>${money(sub)}</span></div>
    <div class="total-line minor"><span>TPS</span><span>${money(gst)}</span></div>
    <div class="total-line minor"><span>TVQ</span><span>${money(qst)}</span></div>
    ${tipAmount ? `<div class="total-line"><span>Pourboire</span><span>${money(tipAmount)}</span></div>` : ''}
    <div class="total-line grand"><span>Total</span><span>${money(paymentTotal ?? total)}</span></div>`;
}

function splitAmounts(total, n) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const rem = cents - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i >= n - rem ? 1 : 0)) / 100);
}

function renderSplit(n) {
  if (!Number.isInteger(n) || n < 2 || n > 30) {
    $('#splitBox').innerHTML = '';
    return;
  }
  const sub = selectedSubtotal();
  const tax = calcTax(sub);
  const total = round2(tax.total + computeTip(sub, tax));
  const parts = splitAmounts(total, n);
  $('#splitBox').innerHTML = `<div class="split-preview">${parts.map((p,i) => `<div><span>Part ${i + 1}</span><strong>${money(p)}</strong></div>`).join('')}<button class="btn primary full" id="payNextPart">Payer la prochaine part · ${money(parts[0])}</button></div>`;
  $('#payNextPart').onclick = () => payAmount(parts[0], 'card', n);
}

async function submitMev(invoice) {
  if (settings?.mev_mode === 'disabled') return { environment: 'DISABLED', status: 'disabled', certified: false, transaction_id: null, qr_payload: null };
  if (settings?.mev_mode === 'live') throw new Error('MEV production verrouillé : certificats officiels requis.');
  const r = await fetch(CFG.mevSimulatorUrl, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(invoice)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `MEV simulateur ${r.status}`);
  return data;
}

async function pay(method) {
  const items = selectedItems();
  if (!items.length) return;
  const sub = selectedSubtotal();
  const tax = calcTax(sub);
  const tipAmount = computeTip(sub, tax);
  const paymentTotal = round2(tax.total + tipAmount);
  await finalizeInvoice({ items, sub, tax, method, tipAmount, paymentTotal, kind: 'items' });
}

async function payAmount(amount, method, splitCount) {
  const subAll = selectedSubtotal();
  const taxAll = calcTax(subAll);
  const totalAll = round2(taxAll.total + computeTip(subAll, taxAll));
  if (amount <= 0 || amount > totalAll + 0.01) return;
  const ratio = amount / totalAll;
  const sub = round2(subAll * ratio);
  const tax = calcTax(sub);
  let tipAmount = round2(amount - tax.total);
  if (tipAmount < 0) tipAmount = 0;
  await finalizeInvoice({ items: [], sub, tax, method, tipAmount, paymentTotal: amount, kind: 'amount', allocation: { amount, splitCount } });
}

async function finalizeInvoice({ items, sub, tax, method, tipAmount, paymentTotal, kind, allocation }) {
  const draft = {
    id: uid(),
    restaurant_id: restaurant.id,
    order_id: activeOrder.id,
    subtotal: sub,
    gst: tax.gst,
    qst: tax.qst,
    total: tax.total,
    tip_amount: tipAmount,
    payment_total: paymentTotal,
    tip_mode: tip.mode,
    tip_value: tip.value,
    status: 'pending_mev',
    mev_payload: { kind, allocation: allocation || null }
  };
  const created = await rest('invoices', { method: 'POST', body: draft });
  const inv = created[0];
  if (items.length) {
    await rest('invoice_items', {
      method: 'POST',
      body: items.map(i => ({
        invoice_id: inv.id,
        order_item_id: i.id,
        quantity: Number(i.quantity) - Number(i.paid_quantity || 0),
        unit_price: i.unit_price,
        line_total: round2(Number(i.unit_price) * (Number(i.quantity) - Number(i.paid_quantity || 0)))
      }))
    });
  }
  await rest('payments', {
    method: 'POST',
    body: { restaurant_id: restaurant.id, invoice_id: inv.id, method, amount: paymentTotal, tip_amount: tipAmount }
  });

  let fiscal;
  try {
    fiscal = await submitMev({
      id: inv.id,
      table_id: activeOrder.table_id,
      subtotal: sub,
      gst: tax.gst,
      qst: tax.qst,
      total: tax.total,
      tip: tipAmount,
      payment_total: paymentTotal,
      payment_method: method,
      items: items.map(i => ({ name: i.name, price: i.unit_price }))
    });
    await rest(`invoices?id=eq.${inv.id}`, {
      method: 'PATCH',
      body: { status: fiscal.status === 'accepted' ? 'accepted' : 'failed', mev_transaction_id: fiscal.transaction_id, mev_response: fiscal }
    });
    await rest('mev_attempts', {
      method: 'POST',
      body: {
        restaurant_id: restaurant.id,
        invoice_id: inv.id,
        environment: fiscal.environment || 'SIMULATOR',
        status: fiscal.status,
        request_payload: { invoice_id: inv.id, total: tax.total },
        response_payload: fiscal,
        transaction_id: fiscal.transaction_id,
        qr_payload: fiscal.qr_payload
      }
    });
  } catch (e) {
    fiscal = { environment: 'SIMULATOR', status: 'failed', certified: false, error: e.message };
    await rest(`invoices?id=eq.${inv.id}`, { method: 'PATCH', body: { status: 'failed', mev_response: fiscal } });
    await rest('mev_attempts', {
      method: 'POST',
      body: {
        restaurant_id: restaurant.id,
        invoice_id: inv.id,
        environment: 'SIMULATOR',
        status: 'failed',
        request_payload: { invoice_id: inv.id, total: tax.total },
        response_payload: fiscal,
        error_message: e.message
      }
    });
  }

  if (items.length) {
    await Promise.all(items.map(i => rest(`order_items?id=eq.${i.id}`, { method: 'PATCH', body: { paid_quantity: i.quantity } })));
    items.forEach(i => i.paid_quantity = i.quantity);
  } else {
    applyAmountLocally(Math.max(0, round2(paymentTotal - tipAmount)));
    await Promise.all(itemsFor(activeOrder.id).map(i => rest(`order_items?id=eq.${i.id}`, { method: 'PATCH', body: { paid_quantity: i.paid_quantity } })));
  }

  inv.mev_response = fiscal;
  inv.mev_transaction_id = fiscal.transaction_id;
  inv.status = fiscal.status === 'accepted' ? 'accepted' : 'failed';
  invoices.unshift(inv);
  await updateOrderStatus();
  selectedItemIds.clear();
  tip = { mode: 'none', value: 0, amount: 0 };
  showReceipt({ ...inv, method, items, fiscal });
}

function applyAmountLocally(grossAmount) {
  let cents = Math.round(grossAmount * 100);
  for (const i of itemsFor(activeOrder.id)) {
    const gross = Math.round(calcTax(Number(i.unit_price)).total * 100);
    if (cents >= gross) {
      i.paid_quantity = i.quantity;
      cents -= gross;
    } else if (cents > 0) {
      const fraction = cents / gross;
      i.paid_quantity = round2(Number(i.paid_quantity || 0) + fraction * Number(i.quantity));
      cents = 0;
      break;
    }
  }
}

async function updateOrderStatus() {
  const left = itemsFor(activeOrder.id).filter(i => Number(i.paid_quantity) < Number(i.quantity));
  const status = left.length ? 'partially_paid' : 'closed';
  await rest(`orders?id=eq.${activeOrder.id}`, {
    method: 'PATCH',
    body: { status, closed_at: status === 'closed' ? new Date().toISOString() : null, updated_at: new Date().toISOString() }
  });
  activeOrder.status = status;
  if (status === 'closed') {
    orders = orders.filter(o => o.id !== activeOrder.id);
    activeOrder = null;
  }
}

function showReceipt(inv) {
  const fiscal = inv.fiscal || inv.mev_response || {};
  const rows = (inv.items || []).map(i => `<div class="receipt-line"><span>${escapeHtml(i.name)}</span><span>${money(i.unit_price || i.price)}</span></div>`).join('');
  openModal(`<div class="receipt-modal"><div class="modal-title-row"><div><span class="eyebrow">Facture</span><h2>${fiscal.status === 'accepted' ? 'Paiement accepté' : 'Paiement enregistré'}</h2></div><button class="icon-btn" data-close>×</button></div><div class="receipt-paper"><strong>${escapeHtml(restaurant.name)}</strong><div class="receipt-muted">${new Date().toLocaleString('fr-CA')}</div><hr>${rows || '<div class="receipt-muted">Paiement partiel</div>'}<hr>${totalsHtml(inv.subtotal, inv.gst, inv.qst, inv.total, inv.tip_amount, inv.payment_total)}<div class="receipt-fiscal"><span>MEV</span><strong>${escapeHtml(fiscal.transaction_id || fiscal.status || 'Non transmis')}</strong><small>${fiscal.certified === false ? 'SIMULATION — NON CERTIFIÉ' : ''}</small><code>${escapeHtml(fiscal.qr_payload || '')}</code></div></div><div class="button-row"><button id="modalPrint" class="btn primary">Imprimer</button><button class="btn" data-close>Fermer</button></div></div>`);
  $('#modalPrint').onclick = () => printReceipt(inv).catch(e => toast(e.message, 'error'));
}

async function printReceipt(inv) {
  const f = inv.fiscal || inv.mev_response || {};
  const text = `${restaurant.name}\nFacture ${inv.id}\n${(inv.items || []).map(i => `${i.name} ${money(i.unit_price || i.price)}`).join('\n')}\nTPS ${money(inv.gst)}\nTVQ ${money(inv.qst)}\nPourboire ${money(inv.tip_amount)}\nTOTAL ${money(inv.payment_total || inv.total)}\nMEV ${f.transaction_id || f.status || ''}\n${f.qr_payload || ''}\n`;
  await printText(text, 'receipt');
  toast('Reçu envoyé à l’imprimante');
}

function renderHistory() {
  $('#historyList').innerHTML = invoices.map(i => `<div class="history-row"><div><strong>${new Date(i.created_at).toLocaleString('fr-CA')}</strong><span>${i.id.slice(0,8).toUpperCase()} · ${i.mev_transaction_id || 'MEV en attente'}</span></div><div><strong>${money(i.payment_total || i.total)}</strong><span class="status-pill ${i.status}">${i.status}</span></div></div>`).join('') || '<div class="empty-state">Aucune facture.</div>';
}

function renderSettings() {
  $('#menuAdminList').innerHTML = products.map(p => `<div class="admin-row"><div><strong>${escapeHtml(p.name)}</strong><span>${escapeHtml(p.category || 'AUTRES')} · ${money(p.price)}</span></div><button class="btn small" data-edit-product="${p.id}">Modifier</button></div>`).join('') || '<div class="empty-state">Menu vide.</div>';
  $$('[data-edit-product]').forEach(b => b.onclick = () => productModal(products.find(p => p.id === b.dataset.editProduct)));
  $('#tipsEnabled').checked = !!settings?.tips_enabled;
  $('#tipBasis').value = settings?.tip_basis || 'after_tax';
  $('#tipPresetAdmin').innerHTML = tipPresets.map(p => `<div class="admin-row"><div><strong>${Number(p.percentage)} %</strong><span>${escapeHtml(p.label)}</span></div><button class="icon-btn" data-delete-tip="${p.id}">×</button></div>`).join('');
  $$('[data-delete-tip]').forEach(b => b.onclick = () => deleteTipPreset(b.dataset.deleteTip));
  $('#kitchenIp').value = printer('kitchen')?.ip_address || '';
  $('#receiptIp').value = printer('receipt')?.ip_address || '';
  $('#mevMode').value = settings?.mev_mode || 'simulator';
  const live = settings?.mev_mode === 'live';
  $('#mevStatusTitle').textContent = live ? 'Production verrouillée' : 'Simulateur actif';
  $('#mevStatusText').textContent = live ? 'Les certificats officiels doivent être configurés avant activation.' : 'Factures, statuts, tentatives et payload QR sont enregistrés comme dans le futur pipeline MEV.';
}

function productModal(product = null) {
  openModal(`<form id="productForm"><div class="modal-title-row"><div><span class="eyebrow">Menu</span><h2>${product ? 'Modifier' : 'Nouvel'} article</h2></div><button type="button" class="icon-btn" data-close>×</button></div><label>Nom<input id="pName" required value="${escapeAttr(product?.name || '')}"></label><div class="form-two"><label>Prix<input id="pPrice" type="number" min="0" step="0.01" required value="${product?.price ?? ''}"></label><label>Catégorie<input id="pCategory" required value="${escapeAttr(product?.category || 'PLATS')}"></label></div><label>Station cuisine<select id="pStation"><option value="kitchen">Cuisine</option><option value="bar">Bar</option><option value="none">Aucune</option></select></label><div class="button-row"><button class="btn primary" type="submit">Enregistrer</button>${product ? '<button type="button" class="btn danger" id="deleteProduct">Désactiver</button>' : ''}</div></form>`);
  $('#pStation').value = product?.kitchen_station || 'kitchen';
  $('#productForm').onsubmit = async e => {
    e.preventDefault();
    const body = {
      restaurant_id: restaurant.id,
      name: $('#pName').value.trim(),
      price: Number($('#pPrice').value),
      category: $('#pCategory').value.trim().toUpperCase(),
      kitchen_station: $('#pStation').value,
      updated_at: new Date().toISOString()
    };
    if (product) {
      const d = await rest(`products?id=eq.${product.id}`, { method: 'PATCH', body });
      Object.assign(product, d[0]);
    } else {
      const d = await rest('products', { method: 'POST', body });
      products.push(d[0]);
    }
    closeModal();
    renderSettings();
    toast('Menu enregistré');
  };
  if (product) {
    $('#deleteProduct').onclick = async () => {
      if (!confirm('Désactiver cet article?')) return;
      await rest(`products?id=eq.${product.id}`, { method: 'PATCH', body: { active: false } });
      products = products.filter(p => p.id !== product.id);
      closeModal();
      renderSettings();
    };
  }
}

async function saveAppSettings() {
  const body = {
    tips_enabled: $('#tipsEnabled').checked,
    tip_basis: $('#tipBasis').value,
    mev_mode: $('#mevMode').value,
    updated_at: new Date().toISOString()
  };
  const d = await rest(`app_settings?restaurant_id=eq.${restaurant.id}`, { method: 'PATCH', body });
  settings = { ...settings, ...d[0] };
  toast('Réglages enregistrés');
}

async function addTipPreset() {
  const p = Number(prompt('Pourcentage de pourboire'));
  if (!Number.isFinite(p) || p < 0 || p > 100) return;
  const d = await rest('tip_presets', {
    method: 'POST',
    body: { restaurant_id: restaurant.id, label: `${p} %`, percentage: p, sort_order: tipPresets.length }
  });
  tipPresets.push(d[0]);
  renderSettings();
}

async function deleteTipPreset(id) {
  await rest(`tip_presets?id=eq.${id}`, { method: 'DELETE' });
  tipPresets = tipPresets.filter(p => p.id !== id);
  renderSettings();
}

async function addTable() {
  const number = Number(prompt('Numéro de table'));
  if (!Number.isInteger(number) || number < 1) return;
  try {
    const d = await rest('restaurant_tables', {
      method: 'POST',
      body: { restaurant_id: restaurant.id, number, sort_order: tables.length }
    });
    tables.push(d[0]);
    renderTables();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function openModal(html) {
  $('#modalCard').innerHTML = html;
  $('#modal').classList.add('show');
  $$('[data-close]').forEach(b => b.onclick = closeModal);
}

function closeModal() {
  $('#modal').classList.remove('show');
  $('#modalCard').innerHTML = '';
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function escapeAttr(s = '') {
  return escapeHtml(s);
}

$('#authForm').onsubmit = async e => {
  e.preventDefault();
  $('#authError').textContent = '';
  try {
    await login($('#authEmail').value.trim(), $('#authPassword').value);
  } catch (err) {
    $('#authError').textContent = err.message;
  }
};

$('#signupBtn').onclick = async () => {
  try {
    await signup($('#authEmail').value.trim(), $('#authPassword').value);
  } catch (err) {
    $('#authError').textContent = err.message;
  }
};

$('#logoutBtn').onclick = logout;
$$('[data-nav]').forEach(b => b.onclick = () => show(b.dataset.nav));
$('#newTableBtn').onclick = addTable;
$('#guestButton').onclick = updateGuests;
$('#sendKitchen').onclick = sendKitchen;
$('#printAddition').onclick = async () => {
  if (!activeOrder) return;
  const table = tables.find(t => t.id === activeOrder.table_id);
  const sub = orderSubtotal(activeOrder.id);
  const tax = calcTax(sub);
  try {
    await printText(`ADDITION\n${table.label || `Table ${table.number}`}\n${itemsFor(activeOrder.id).map(i => `${i.name} ${money(i.unit_price)}`).join('\n')}\nTOTAL ${money(tax.total)}\n`, 'receipt');
    toast('Addition imprimée');
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#goPay').onclick = () => {
  selectedItemIds.clear();
  tip = { mode: 'none', value: 0, amount: 0 };
  show('payScreen');
};
$$('[data-method]').forEach(b => b.onclick = () => pay(b.dataset.method).catch(e => toast(e.message, 'error')));
$$('[data-split]').forEach(b => b.onclick = () => renderSplit(Number(b.dataset.split)));
$('#customSplit').oninput = e => renderSplit(Number(e.target.value));
$('#applyCustomTip').onclick = () => {
  const v = Number($('#customTip').value);
  if (Number.isFinite(v) && v >= 0) {
    tip = { mode: 'amount', value: v, amount: v };
    renderPay();
  }
};
$('#newProductBtn').onclick = () => productModal();
$('#tipsEnabled').onchange = saveAppSettings;
$('#tipBasis').onchange = saveAppSettings;
$('#mevMode').onchange = saveAppSettings;
$('#addTipPreset').onclick = addTipPreset;
$('#savePrinters').onclick = async () => {
  try {
    await savePrinter('kitchen', $('#kitchenIp').value.trim());
    await savePrinter('receipt', $('#receiptIp').value.trim());
    toast('Imprimantes enregistrées');
  } catch (e) {
    toast(e.message, 'error');
  }
};
$('#testKitchen').onclick = () => printText('TEST CUISINE\nSimplePOS\n', 'kitchen').then(() => toast('Test envoyé')).catch(e => toast(e.message, 'error'));
$('#testReceipt').onclick = () => printText('TEST RECU\nSimplePOS\n', 'receipt').then(() => toast('Test envoyé')).catch(e => toast(e.message, 'error'));
$('#refreshHistory').onclick = () => loadAll().then(() => renderHistory());
$('#modal').onclick = e => {
  if (e.target.id === 'modal') closeModal();
};
setInterval(() => $('#clock').textContent = new Date().toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' }), 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

if (session?.access_token) boot();
