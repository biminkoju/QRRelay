# Implementation status

Legend: Not started | In progress | Implemented | Tested | Physically verified

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 0 | Repo scaffold, strict TS, Vite, PWA + single-file build, CSP, no-remote scan, version/build ID, offline-ready status, test scaffold | Tested | Both builds produced; no-remote scan passes; offline-ready is derived from real SW/precache state |
| 1 | Typed protocol core, QRF1 envelope, CRC-32, version negotiation, reliable state machines, simulated transfer | Tested | 36 protocol tests: frame, CRC, negotiation, sender retry/timeout/NACK, receiver duplicate/out-of-order/hash, fault-injection simulation |
| 2 | QR encode/decode without cameras, byte-fidelity gate, optical round-trip simulation | Tested | 23 QR tests. Bundled encoder/decoder, integer-pixel rendering with quiet zone, every message type round-tripped through a real QR bitmap, all-256-bytes fidelity vector passes, multi-chunk transfer routed through QR images |
| 3 | Camera + display control frames | In progress | Camera acquisition, unmirrored scanner with rVFC fallback, integer-pixel canvas QR display, wake lock, beacon exchange UI and calibration-id derivation are implemented and unit-tested through real QR images. Not physically verified; no camera test has been run |
| 4 | Bidirectional calibration and LinkProfile | In progress | Probe ladder, rate burst, ping/pong and conservative LinkProfile derivation are implemented with a pure runner and 45 tests, including frames routed through real QR images. Calibration is wired into the Link Check screen. Not physically verified: no frame of this ever crossed a real optical link |
| 5 | Real single-file reliable transfer with durable storage | Not started | Receiver storage is in-memory only |
| 6 | Stream mode (fountain code + frozen sub-spec) | Not started | |
| 7 | ZIP / folder packaging / compression | Not started | |
| 8 | Large-file robustness (IndexedDB/OPFS, resume) | Not started | |
| 9 | Authenticated encryption, release hardening | Not started | |

## Known gaps

- `sha256Hex` uses a one-shot digest; incremental hashing in a worker is required before large files.
- Receiver ACKs after committing to memory only. Documented and intentional until Phase 5/8.
- Receiver DATA payload size-bound validation is not asserted by a test.
- `maxFrameTextLength` binary-searches capacity by trial encoding; it is only used in tests and is slow, so keep it out of the runtime bundle.
- The QR libraries are not yet in the browser bundle because no UI imports them.
- `CAL_RATE_START` is defined and validated but no runner sends it; burst length is implicit in `CAL_RATE_FRAME` indices.
- Calibration always probes at EC level `M`; the ladder never re-runs at `Q`.
- The follower's end of calibration relies on an idle timeout, not an explicit final frame.
- Playwright offline tests exist and pass; there is no browser test that drives calibration (it needs two cameras).
- GitHub Pages deployment is CI-only and unexercised: the workflow has never run on GitHub, and the subpath tests use a local server that mimics Pages rather than Pages itself.

## Next concrete task

Physical verification of Phase 3 and 4 on two real machines: link-up, the full probe ladder, a rate burst, ping/pong, and the resulting chunk size. Record measured decode rates, the largest payload that actually decoded, and any glare/angle effects. Until that exists, no performance claim is valid.
