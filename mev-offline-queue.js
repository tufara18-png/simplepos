// Local persistence for MEV transactions that were built and signed but could not be sent
// (no network, or a retryable response) -- so a device can keep producing correctly-chained,
// already-signed transactions while offline and catch up later as a "transLot" batch, exactly
// the shape confirmed live against Revenu Québec's real DEV environment (see mev-protocol.js).
//
// Signing happens at creation time regardless of connectivity: a transaction's own signature
// only depends on its own content, and the *next* transaction's signa.preced must reference
// this one's signa.actu immediately, or a second offline sale could not be built correctly
// before the first one ever reaches Revenu Québec. This is why the queue exists client-side
// (IndexedDB) rather than deferring signing until the device is back online.
//
// NEVER VERIFIED END TO END: the reqTrans/signature/transLot mechanics this replays are
// verified (see mev-protocol.js), but this specific queue-and-replay glue has not been
// exercised on a real device or against a real extended offline gap. Treat as a first
// implementation to validate on-device, not as proven.

const DB_NAME = 'resto360-mev-queue-v1';
const STORE = 'queue';

function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function allForDevice(deviceId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).filter((r) => r.deviceId === deviceId).sort((a, b) => a.id - b.id));
    req.onerror = () => reject(req.error);
  });
}

/** Persists a fully-built, fully-signed transActu. Call only after signa.actu is already set. */
export async function enqueueSignedTransaction(deviceId, transActu) {
  await withStore('readwrite', (store) => store.add({ deviceId, transActu, queuedAt: new Date().toISOString() }));
}

/**
 * The signature this device's next transaction must use as signa.preced: the last queued
 * (not yet sent) transaction's signature if the queue is non-empty, otherwise whatever the
 * caller already knows from mev_devices.last_transaction_signature. Checking the local queue
 * first is what keeps a second offline sale correctly chained to the first before either has
 * reached Revenu Québec.
 */
export async function effectivePreced(deviceId, dbLastSignature) {
  const rows = await allForDevice(deviceId);
  if (rows.length) return rows[rows.length - 1].transActu.signa.actu;
  return dbLastSignature || '='.repeat(88);
}

export async function queueLength(deviceId) {
  return (await allForDevice(deviceId)).length;
}

// SW-78 FO-132: 256 ko is Revenu Québec's stated cap on one transLot's JSON body. "ko" isn't
// spelled out as KB (1000) or KiB (1024) anywhere in the guide -- using the smaller of the two
// (decimal) so a batch is split before either interpretation could reject it. FO-132 itself
// says this value may be lowered temporarily to make the case easy to demonstrate with only a
// few queued transactions, hence the parameter rather than a hardcoded use below.
export const DEFAULT_MAX_BATCH_BYTES = 256_000;

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

/**
 * Splits a chronologically-ordered (oldest-first) list of transactions into consecutive groups
 * that each fit under maxBytes once wrapped in a transLot envelope, oldest group first (SW-78
 * FO-132 étapes 2-3: on reconnect, transmit the oldest part first, then the rest oldest to
 * newest). A single transaction that alone exceeds maxBytes still gets its own group -- there
 * is nothing smaller to split it into.
 */
export function splitIntoBatches(rows, maxBytes) {
  const groups = [];
  let current = [];
  for (const row of rows) {
    const candidate = [...current, row];
    const size = byteLength(JSON.stringify({ reqTrans: { transLot: candidate.map((r) => r.transActu) } }));
    if (size > maxBytes && current.length) {
      groups.push(current);
      current = [row];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Sends everything queued for this device as one or more "transLot" batches (SW-73.D:
 * most-recent-first in the JSON, oldest-first for the header signature within each batch --
 * buildOfflineBatchEnvelope and buildSignatureInput already handle that split correctly).
 * Batches are sent oldest-group-first, stopping at the first one Revenu Québec doesn't accept
 * so nothing already-sent gets re-sent and nothing still-queued gets skipped.
 */
export async function flushQueue(deviceId, { headers, url, signHeader, keyAlias, certificatePem, maxBatchBytes = DEFAULT_MAX_BATCH_BYTES }) {
  const rows = await allForDevice(deviceId);
  if (!rows.length) return { sent: 0 };

  const { buildOfflineBatchEnvelope, buildSignatureInput } = await import('./mev-protocol.js');
  const batches = splitIntoBatches(rows, maxBatchBytes);

  let sent = 0;
  let lastSignature = null;
  let raw = null;
  for (const group of batches) {
    const chain = group.map((r) => r.transActu);
    const envelope = buildOfflineBatchEnvelope(chain);
    const headerSignInput = buildSignatureInput({
      authorizationCode: headers.__authorizationCode,
      idApprl: headers.IDAPPRL,
      transactionSignatures: chain.map((t) => t.signa.actu),
    });
    const signature = await signHeader(headerSignInput);
    const sendHeaders = { ...headers, SIGNATRANSM: signature };
    delete sendHeaders.__authorizationCode;

    const response = await window.Resto360Mev.sendRequest({ url, headers: sendHeaders, body: JSON.stringify(envelope), keyAlias, certificatePem });
    const status = Number(response.status);
    if (status < 200 || status >= 300) return { sent, error: response.body, batchCount: batches.length };

    await withStore('readwrite', (store) => group.forEach((r) => store.delete(r.id)));
    sent += group.length;
    lastSignature = chain[chain.length - 1].signa.actu;
    raw = JSON.parse(response.body || '{}');
  }
  return { sent, lastSignature, raw, batchCount: batches.length };
}
