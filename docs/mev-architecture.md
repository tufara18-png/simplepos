# SimplePOS MEV architecture

This layer is intentionally independent from the POS UI.

Flow:

`invoice -> MevEnvelopeFactory -> MevController -> Transport -> response -> mev_attempts -> mev_transactions -> mev_receipts`

Current transport: `SimulatorTransport`.

Future transport: `RevenuQuebecTransport`, implemented only from the official partner technical specifications and certificates.

Runtime states:

- `pending`
- `sending`
- `accepted`
- `retryable`
- `rejected`
- `failed`
- `cancelled`

The simulator can exercise `accepted`, `rejected`, `retryable`, and `timeout` scenarios. All simulator identifiers and QR payloads are explicitly non-fiscal and must never be treated as Revenu Québec output.

The database separates:

- `mev_devices`: device/certificate lifecycle placeholder;
- `mev_transactions`: one fiscal transmission lifecycle per invoice;
- `mev_attempts`: immutable attempt/audit history;
- `mev_receipts`: receipt/document result.

The existing POS continues writing `mev_attempts`; a database trigger mirrors each attempt into the normalized runtime tables. This keeps the UI decoupled from the future production transport.
