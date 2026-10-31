# Testing

## Automated

    npm run typecheck
    npm test
    npm run build
    npm run test:e2e   # requires `npx playwright install chromium` once
    npm run serve:prefix   # manual check: same dist/ under /qrrelay/ on :4175

`npm run build` runs the type check, both builds, the no-remote scan and checksum generation.

### Covered today

- CRC-32: canonical vector `123456789` -> cbf43926, empty input, bit-flip detection.
- QRF1: empty payload control frame, all 256 byte values, maximum sequence, tampered CRC, tampered payload, wrong field count, wrong magic, uppercase session ID, all-zero restriction, oversized payload, malformed Base64URL, Base64URL round trip.
- Version negotiation: highest common version, no overlap, capability intersection, app-version mismatch.
- Reliable simulation: empty file, one byte, multi-chunk byte-exact transfer with SHA-256 check, loss + duplication + corruption + reordering, fully dead channel (must not report success).
- Sender with an injected clock: no advance without ACK, ACK-timeout retransmission, failure after maxRetries, NACK retransmission, stale ACK ignored, ACK skipping ahead rejected, Unconfirmed when COMPLETE is never seen.
- Receiver: ACK + commit, duplicate chunk not stored twice, NACK on out-of-order, END hash mismatch, verified COMPLETE.
- Alignment: calibration-id derivation (order-independent), leader election, beacon state machine (peer-seen vs peer-sees-us, link-up only on acknowledgement, reset on peer restart), and a two-sided beacon exchange routed through real QR images.
- Simulated optical channel: undegraded decode, seed determinism, sub-pixel aliasing, blur cliff, contrast washout (0.08 fails, 0.6 decodes), and the channel cannot exceed 7.5 capture pixels per module at the requested 6.
- Single-machine loopback: a full two-runner calibration over a clean channel (both directions confirm 1024 B, matching chunk sizes, RTT samples), determinism, an unreadable channel that drops frames and yields `bidirectional: false` with the 64 B floor, log directions, and `sweepModuleSize` (resolution cliff, larger payload -> more modules).
- Scanner helpers: duplicate suppression, decode-rate calculation, quality labels.
- Build: no-remote scan over both build outputs.
- Browser (Playwright, 9 tests): PWA starts offline with zero external requests and zero CSP violations; service-worker precache contains the app shell; single-file build opens from `file:///` with hashed CSP intact; Link Check screen opens and reports the missing-camera limitation without pretending to work; and, for GitHub Pages, the same dist/ mounted at /qrrelay/ starts with no failed requests, serves manifest.json as JSON with 192/512 icons, precaches subpath URLs, and contains no root-absolute asset paths (.nojekyll included); and the Simulate button fills the measurements table with six populated rows, a chunk size and `RTT n/a (virtual time)` rather than blank cells.

### Not covered yet

- Receiver storage failure path.
- Receiver DATA payload size-bound assertion.
- Real camera behaviour: permission flow, device switching, decode stability, and beacon exchange between two machines.
- QR image encode/decode.
- Any physical camera test.

## Manual

No physical test has been performed. Nothing in this repository claims that two computers have exchanged data over cameras.

## Planned offline acceptance test

Playwright with all non-local requests failed, two local contexts, routed frames, assert zero network attempts, zero unexpected CSP violations and matching SHA-256.
