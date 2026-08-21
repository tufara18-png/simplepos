// Wires the verified reqTrans/signature pipeline (mev-protocol.js) into an actual outgoing
// request, from the device, for a real sale -- what app-v2.js's submitMev() calls when
// mev_mode is "live" instead of throwing. Everything this builds has been checked field-by-
// field against Revenu Québec's real DEV environment (see mev-protocol.js's header comment
// and the commit history); what has NOT been checked here is the offline-queue integration --
// this module only covers the online path. A caller with no network, or on a platform without
// MevKeystore (anything but the Android wrapper today), gets a clear "not available" result,
// never a silently-invented fiscal outcome.

import { buildReqTrans, buildTransactionSignatureInput, buildHeaders, buildSignatureInput, endpointFor, interpretCodRetour } from './mev-protocol.js';
import { enqueueSignedTransaction, effectivePreced, flushQueue, queueLength } from './mev-offline-queue.js';

const CFG = window.RESTO360_CONFIG || {};
const API = CFG.supabaseUrl ? `${CFG.supabaseUrl}/rest/v1` : '';
const DEVICE_ALIAS = 'mev-operator-key';

function session() { try { return JSON.parse(localStorage.getItem('resto360-session') || 'null'); } catch { return null; } }
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

async function loadDeviceAndConfig(restaurantId) {
  const [devices, configs] = await Promise.all([
    api(`mev_devices?restaurant_id=eq.${restaurantId}&device_key=eq.${DEVICE_ALIAS}&select=*&limit=1`),
    api(`mev_partner_config?restaurant_id=eq.${restaurantId}&select=*&limit=1`),
  ]);
  return { device: devices?.[0] || null, partnerConfig: configs?.[0] || null };
}

function notAvailable(reason) {
  return { environment: 'LIVE', certified: false, status: 'not_configured', retryable: false, error: reason };
}

/**
 * Submits one closing-receipt transaction for real. Returns a shape compatible with what
 * app-v2.js already expects from submitMev (status/transaction_id/qr_payload/environment),
 * so wiring this in does not require reshaping the caller.
 */
export async function submitMevTransaction({ restaurant, invoice, invoiceItems, paymentMethod, tableLabel, guestCount }) {
  if (!window.Resto360Mev?.isAndroidNative?.()) return notAvailable('Transmission réelle disponible seulement dans l’appli Android.');

  const { device, partnerConfig } = await loadDeviceAndConfig(restaurant.id);
  if (!device?.id_apprl || device.certificate_status !== 'active') return notAvailable('Aucun certificat MEV actif -- complétez l’enrôlement dans Réglages.');
  if (!partnerConfig?.id_sev || !partnerConfig?.id_partn || !partnerConfig?.authorization_code) return notAvailable('Inscription partenaire incomplète -- complétez Réglages avant de transmettre.');
  if (!restaurant.gst_number || !restaurant.qst_number) return notAvailable('Numéros de TPS/TVQ de l’établissement manquants -- complétez Réglages avant de transmettre.');

  // NOTPS/NOTVQ are the exploitant's own real registration numbers -- they live on the
  // restaurant record, never on mev_partner_config (which only holds the concepteur/partner
  // and per-device enrolment constants).
  const effectivePartnerConfig = { ...partnerConfig, no_tps: restaurant.gst_number, no_tvq: restaurant.qst_number, versi_parn: partnerConfig.versi_parn || '0' };

  // Check the local not-yet-sent queue before the device's last confirmed signature: a second
  // offline sale must chain to the first one's signature immediately, not wait for either to
  // reach Revenu Québec (see mev-offline-queue.js).
  const preced = await effectivePreced(device.id, device.last_transaction_signature);
  // A backlog already exists (an earlier queue-then-flush attempt failed, or the device only
  // just came back online and hasn't flushed yet). This new transaction must not be sent solo
  // ahead of that backlog -- Revenu Québec would see a signature chain referencing a prior
  // transaction it has never received. Queue it too, in order, and let flushMevQueue send
  // everything together.
  const hasBacklog = (await queueLength(device.id)) > 0;

  // nomUtil must identify the staff member who rang the sale, not the business -- but nothing
  // in the schema tracks a display name for a restaurant_members row (just user_id, a UUID).
  // The only real per-person signal available at runtime is the logged-in account's own email;
  // falling back to restaurant.name here would silently misreport the field.
  const effectiveInvoice = { ...invoice, user_name: invoice.user_name || session()?.user?.email };

  const { reqTrans } = buildReqTrans({
    restaurant,
    device,
    partnerConfig: effectivePartnerConfig,
    invoice: effectiveInvoice,
    invoiceItems,
    paymentMethod,
    documentType: 'closing_receipt',
    tableLabel,
    guestCount,
    signaturePreviousBase88: preced,
  });
  const transActu = reqTrans.transActu;

  const signInput = buildTransactionSignatureInput(transActu);
  const signed = await window.Resto360Mev.sign(DEVICE_ALIAS, signInput);
  transActu.signa.actu = signed.signatureBase64;

  const headers = buildHeaders({ environment: partnerConfig.environment || 'DEV', device, partnerConfig: effectivePartnerConfig });
  const url = endpointFor('transaction', null, headers.ENVIRN);

  // Offline, or a backlog already exists: the transaction is already fully signed and
  // self-consistent, so queue it exactly as-is rather than blocking the sale or sending it
  // out of order. flushMevQueue() sends it, and everything queued with it, as one transLot
  // batch -- the same mechanism confirmed live for a two-transaction batch. If we do have a
  // network, try flushing right away so a single blip does not leave things queued
  // indefinitely; a failed opportunistic flush is not this call's problem to report.
  if (!navigator.onLine || hasBacklog) {
    await enqueueSignedTransaction(device.id, transActu);
    if (navigator.onLine) flushMevQueue(restaurant).catch(() => {});
    return { environment: headers.ENVIRN, certified: true, status: 'retryable', produced_offline: !navigator.onLine, transaction_id: null, qr_payload: null };
  }

  const headerSignInput = buildSignatureInput({ authorizationCode: partnerConfig.authorization_code, idApprl: device.id_apprl, transactionSignatures: [transActu.signa.actu] });
  const headerSigned = await window.Resto360Mev.sign(DEVICE_ALIAS, headerSignInput);
  headers.SIGNATRANSM = headerSigned.signatureBase64;
  headers.EMPRCERTIFTRANSM = device.certificate_thumbprint_sha1;

  let response;
  try {
    response = await window.Resto360Mev.sendRequest({ url, headers, body: JSON.stringify({ reqTrans: { transActu } }), keyAlias: DEVICE_ALIAS, certificatePem: device.certificate_pem });
  } catch (networkError) {
    // navigator.onLine said "online" but the request itself failed (captive portal, DNS
    // blip, etc.) -- same treatment as the explicit offline path above, not a rejection.
    await enqueueSignedTransaction(device.id, transActu);
    return { environment: headers.ENVIRN, certified: true, status: 'retryable', produced_offline: true, transaction_id: null, qr_payload: null, error_message: String(networkError?.message || networkError) };
  }

  const status = Number(response.status);
  const data = JSON.parse(response.body || '{}');
  const errs = data?.retourTrans?.retourTransActu?.listErr || [];

  // Chain state only advances on a real accept -- a rejected attempt must not move
  // signa.preced forward, or the next real transaction's signature chain would not match what
  // Revenu Québec actually has on file for this device.
  if (status >= 200 && status < 300) {
    await api(`mev_devices?id=eq.${device.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_transaction_signature: transActu.signa.actu, updated_at: new Date().toISOString() } });
  }

  const firstErr = errs[0];
  const interpreted = firstErr ? interpretCodRetour(firstErr.codRetour) : null;
  return {
    environment: headers.ENVIRN,
    certified: true,
    status: status >= 200 && status < 300 ? 'accepted' : interpreted?.shouldRetransmit ? 'retryable' : 'rejected',
    transaction_id: data?.retourTrans?.retourTransActu?.psiNoTrans || null,
    error_code: firstErr?.id || null,
    error_message: firstErr?.mess || null,
    qr_payload: null, // still blocked on the real QR encryption key -- see docs/certification-readiness.md
    raw: data,
  };
}

/**
 * Call on reconnect (window "online" event) or from a periodic poller, with the same
 * restaurant object app-v2.js already holds (not just its id -- NOTPS/NOTVQ come from
 * restaurant.gst_number/qst_number, same as submitMevTransaction, and mev_partner_config has
 * no tax-number columns of its own to fall back on). Sends everything queued for this
 * restaurant's device as one transLot batch and advances
 * mev_devices.last_transaction_signature only if Revenu Québec accepts it.
 */
export async function flushMevQueue(restaurant) {
  if (!window.Resto360Mev?.isAndroidNative?.() || !navigator.onLine) return { sent: 0 };
  const { device, partnerConfig } = await loadDeviceAndConfig(restaurant.id);
  if (!device?.id || !partnerConfig) return { sent: 0 };
  if ((await queueLength(device.id)) === 0) return { sent: 0 };
  if (!restaurant.gst_number || !restaurant.qst_number) return { sent: 0, error: 'Numéros de TPS/TVQ manquants' };

  const effectivePartnerConfig = { ...partnerConfig, no_tps: restaurant.gst_number, no_tvq: restaurant.qst_number, versi_parn: partnerConfig.versi_parn || '0' };
  const headers = buildHeaders({ environment: partnerConfig.environment || 'DEV', device, partnerConfig: effectivePartnerConfig });
  headers.EMPRCERTIFTRANSM = device.certificate_thumbprint_sha1;
  headers.__authorizationCode = partnerConfig.authorization_code;
  const url = endpointFor('transaction', null, headers.ENVIRN);

  const result = await flushQueue(device.id, {
    headers,
    url,
    keyAlias: DEVICE_ALIAS,
    certificatePem: device.certificate_pem,
    signHeader: async (text) => (await window.Resto360Mev.sign(DEVICE_ALIAS, text)).signatureBase64,
  });
  if (result.sent > 0 && result.lastSignature) {
    await api(`mev_devices?id=eq.${device.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { last_transaction_signature: result.lastSignature, updated_at: new Date().toISOString() } });
  }
  return result;
}
