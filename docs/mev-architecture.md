# Resto360 MEV architecture

This layer is intentionally independent from the POS UI.

Flow:

`invoice -> submitMev() -> Transport -> response -> mev_attempts -> mev_transactions -> mev_receipts`

Two transports exist behind the same interface, selected per-restaurant by `app_settings.mev_mode`:

- `simulator` (default): `mev-runtime.js` + the `mev-simulator` edge function. Exercises `accepted`, `rejected`, `retryable`, and `timeout` scenarios with an explicitly non-fiscal QR (`SIMULATED-NOT-FISCAL`). Used to validate the POS workflow without touching Revenu Québec.
- `live`: `mev-live.js`. Builds the real SW-73 JSON (`mev-protocol.js`), signs it with the device's own ECDSA P-256 key via `MevKeystorePlugin` (Android Keystore, non-exportable), and sends it via `MevProtocolPlugin` (native HTTP with mTLS — not the WebView's `fetch`) straight to Revenu Québec's `certificats`/`transaction`/`utilisateur` endpoints for whichever environment (`DEV`/`ESSAI`/`PROD`) `mev_partner_config` is set to. A third value, `disabled`, sends nothing and produces no fiscal document.

`live` has been verified against Revenu Québec's real DEV environment (mTLS, real certificate from a live enrolment): certificate enrolment (`reqCertif`), a plain closing receipt, one with a tip, an in-progress cancellation, a credit note, and a two-transaction offline batch all round-tripped with HTTP 200/201 and real `psi...` identifiers back. Still unverified against DEV: `docAdr` in a non-default shape, `clint` (B2B), instalment payments (`versActu`/`versAnt`/`sold`), and the `ESTM`/`SOUM`/`ADDI` transaction types — see the header comment in `mev-protocol.js` for the exact list before relying on any of those.

Runtime states:

- `pending`
- `sending`
- `accepted`
- `retryable`
- `rejected`
- `failed`
- `cancelled`

The database separates:

- `mev_devices`: one row per restaurant device, holding its ECDSA keypair reference, certificate status, and signature chain (`last_transaction_signature`) once enrolled;
- `mev_partner_config`: partner/SEV registration constants (`IDPARTN`, `IDSEV`, `IDVERSI`, `NOTPS`/`NOTVQ`, environment) needed to build every request header;
- `mev_transactions`: one fiscal transmission lifecycle per invoice;
- `mev_attempts`: immutable attempt/audit history;
- `mev_receipts`: receipt/document result;
- `mev_partner_requests`: log of `certificats`/`utilisateur` requests sent outside the per-invoice transaction flow (enrolment, account changes).

The existing POS continues writing `mev_attempts`; a database trigger mirrors each attempt into the normalized runtime tables. This keeps the UI decoupled from which transport is active.

`mev-offline-queue.js` covers the offline path for `live` mode: transactions are signed at creation time (a signature only depends on its own content), so a second offline sale can chain its `signa.preced` to the first one's `signa.actu` before either has reached Revenu Québec. On reconnect, everything queued is flushed as one `transLot` batch. This queue-and-replay path is new glue around individually-verified mechanics (signing, `transLot`, the chain itself) — it has not yet been exercised against a real offline gap on an Android device, and a batch Revenu Québec rejects outright currently just stays queued with no surfaced alert beyond a toast on the next reconnect attempt.
