# Changelog

## Unreleased

- Simulated calibration reports RTT as `n/a (virtual time)` rather than the harness step interval, and the Simulate button defers its work so the pending state paints. Added a browser test asserting the measurements table is populated, not blank.

- Single-machine simulator: a simulated optical channel (`src/sim/channel.ts`) with area downscale, box blur, brightness, contrast and seeded noise; a virtual-time two-runner loopback (`src/sim/loopback.ts`) and `sweepModuleSize`; a contrast term so glare washout is modellable at all; and a **Simulate (no camera)** button on the Link Check screen that runs a full calibration without hardware. 14 new tests.

- Calibration diagnostics: a raw measurements table on the Link Check screen (per-rung pass/fail per direction, confirmed bytes, burst frames, RTT samples, timeout count), a `diagnostics` getter on the runner, and an EC level that matches between the probe payload and the rendered symbol. QR display now sizes itself from the pane width instead of a fixed 520 px.

- GitHub Pages support: deploy workflow with artifact verification, .nojekyll, manifest.json instead of .webmanifest (Pages MIME issue), 192/512 PNG and Apple touch icons, and four browser tests that serve dist/ from a /qrrelay/ subpath. The single-file build now keeps exactly one data-URI icon after inlining, which the new icon links had broken.

- Phase 4: calibration protocol frames (CAL_PROBE, CAL_PROBE_RESULT, CAL_RATE_FRAME, CAL_RATE_RESULT, CAL_PING, CAL_PONG), a pure probe ladder / rate burst / RTT layer, conservative LinkProfile derivation, a pure calibration runner with frame dwell and timeout handling, and calibration wired into the Link Check screen.

- Phase 3: camera acquisition with classified errors, unmirrored continuous scanner, integer-pixel canvas QR display, wake lock, CAL_BEACON exchange, calibration-id derivation and leader election, and a Link Check screen. Added Playwright offline tests for the PWA and single-file builds.

- Phase 2: bundled QR encoder and decoder, integer-pixel RGBA rendering with enforced quiet zone, byte-fidelity self-test over the real encode/render/decode path, and a `FrameCodec` hook in the simulator so whole transfers run through real QR bitmaps.

## 0.1.0

- Phase 0: Vite + strict TypeScript scaffold, PWA build with generated service worker, single-file build with hashed CSP, no-remote static scan, release checksums, app version/build ID UI with real offline-ready detection.
- Phase 1 (partial): QRF1 text frame envelope, CRC-32/ISO-HDLC, strict parser order, typed payload validation, version/capability negotiation, reliable stop-and-wait sender and receiver, END/COMPLETE/FIN closing, deterministic fault-injection simulator, unit and simulation tests.
