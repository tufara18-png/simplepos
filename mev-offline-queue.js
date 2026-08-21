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

const DB_NAME = 'simplepos-mev-queue-v1';
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

/**
 * Sends everything queued for this device as one "transLot" batch (SW-73.D: most-recent-first
 * in the JSON, oldest-first for the header signature -- buildOfflineBatchEnvelope and
 * buildSignatureInput already handle that split correctly). Clears the queue only if Revenu
 * Québec accepts the batch; leaves it queued on any failure so nothing is lost.
 */
export async function flushQueue(deviceId, { headers, url, signHeader }) {
  const rows = await allForDevice(deviceId);
  if (!rows.length) return { sent: 0 };
  const chain = rows.map((r) => r.transActu);

  const { buildOfflineBatchEnvelope, buildSignatureInput } = await import('./mev-protocol.js');
  const envelope = buildOfflineBatchEnvelope(chain);

  const headerSignInput = buildSignatureInput({
    authorizationCode: headers.__authorizationCode,
    idApprl: headers.IDAPPRL,
    transactionSignatures: chain.map((t) => t.signa.actu),
  });
  const signature = await signHeader(headerSignInput);
  const sendHeaders = { ...headers, SIGNATRANSM: signature };
  delete sendHeaders.__authorizationCode;

  const response = await window.SimplePOSMev.sendRequest({ url, headers: sendHeaders, body: JSON.stringify(envelope) });
  const status = Number(response.status);
  if (status >= 200 && status < 300) {
    await withStore('readwrite', (store) => rows.forEach((r) => store.delete(r.id)));
    return { sent: rows.length, lastSignature: chain[chain.length - 1].signa.actu, raw: JSON.parse(response.body || '{}') };
  }
  return { sent: 0, error: response.body };
}
