# Architecture

## Module boundaries

| Layer | Path | Responsibility |
|---|---|---|
| Version | src/version.ts | App version, build ID, build kind, supported protocol versions |
| Frame protocol | src/protocol/frame.ts, bytes.ts, checksum.ts, session.ts, messageTypes.ts | QRF1 encode/decode, CRC-32, Base64URL, runtime payload validation |
| Session protocol | src/protocol/sender.ts, receiver.ts, versioning.ts, constants.ts | State machines, negotiation, timeouts, retries, terminal handshake |
| Simulation | src/protocol/simulation.ts | Deterministic in-process transport with fault injection |
| Transfer | src/transfer/source.ts, receiverStorage.ts, hash.ts | Random-access source, chunk storage, hashing |
| UI | src/main.ts, src/styles.css | Phase 0 shell showing build identity and offline status |
| Build | build/*.ts, build/*.mjs | CSP injection, single-file inlining, PWA service worker, no-remote scan, checksums |

## Data flow (protocol)

    camera/display (future)
        -> QRF1 text
        -> decodeFrame(): envelope, magic, type, session, sequence, base64url, CRC, typed JSON
        -> Sender.onFrame / Receiver.onFrame
        -> { outbound frames, events }
        -> encodeFrame()
        -> display (future)

The protocol engine never imports React, DOM, camera or QR libraries.

## Build outputs

Both outputs come from one source tree through `vite build` and `vite build --mode single`.

- PWA: `dist/index.html` plus hashed assets and `sw.js` generated from the real emitted file list.
- Single file: `dist-single/qrrelay.html`, with JS and CSS inlined and a CSP containing SHA-256 hashes of the inlined blocks.
