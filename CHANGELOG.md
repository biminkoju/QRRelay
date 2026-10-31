# Changelog

## Unreleased

- GitHub Pages support: deploy workflow with artifact verification, .nojekyll, manifest.json instead of .webmanifest (Pages MIME issue), 192/512 PNG and Apple touch icons, and four browser tests that serve dist/ from a /qrrelay/ subpath. The single-file build now keeps exactly one data-URI icon after inlining, which the new icon links had broken.

- Phase 4: calibration protocol frames (CAL_PROBE, CAL_PROBE_RESULT, CAL_RATE_FRAME, CAL_RATE_RESULT, CAL_PING, CAL_PONG), a pure probe ladder / rate burst / RTT layer, conservative LinkProfile derivation, a pure calibration runner with frame dwell and timeout handling, and calibration wired into the Link Check screen.

- Phase 3: camera acquisition with classified errors, unmirrored continuous scanner, integer-pixel canvas QR display, wake lock, CAL_BEACON exchange, calibration-id derivation and leader election, and a Link Check screen. Added Playwright offline tests for the PWA and single-file builds.

- Phase 2: bundled QR encoder and decoder, integer-pixel RGBA rendering with enforced quiet zone, byte-fidelity self-test over the real encode/render/decode path, and a `FrameCodec` hook in the simulator so whole transfers run through real QR bitmaps.

## 0.1.0

- Phase 0: Vite + strict TypeScript scaffold, PWA build with generated service worker, single-file build with hashed CSP, no-remote static scan, release checksums, app version/build ID UI with real offline-ready detection.
- Phase 1 (partial): QRF1 text frame envelope, CRC-32/ISO-HDLC, strict parser order, typed payload validation, version/capability negotiation, reliable stop-and-wait sender and receiver, END/COMPLETE/FIN closing, deterministic fault-injection simulator, unit and simulation tests.
