# QRRelay

Offline two-way optical file transfer between two computers using their
displays and cameras. No Wi-Fi, no Ethernet, no Bluetooth, no internet: the
data travels only through screens and lenses.

The full design specification lives in [QRRelay-README.md](QRRelay-README.md).
This file describes the current state of the code.

## Status

Phases 0-4 are implemented at the code level and tested in software. Nothing
has been verified on physical hardware yet.

Implemented:

- Offline-first build: installable PWA plus a single self-contained HTML file,
  strict CSP, a scan that fails the build on any runtime network reference, and
  a build ID.
- QRF1 frame protocol: CRC-32, version negotiation, reliable stop-and-wait
  sender and receiver, and a fault-injection simulation.
- QR layer: bundled encoder and decoder, integer-pixel rendering with a quiet
  zone, and a byte-fidelity self-test. Every message type is round-tripped
  through a real QR bitmap.
- Link check: camera permission and device selection, unmirrored continuous
  scanning, integer-pixel canvas display, screen wake lock, bidirectional
  beacon exchange, calibration-id derivation and leader election.
- Calibration: directional probe ladder, rate burst, ping/pong round trip, and
  a conservative LinkProfile that only trusts what was observed in both
  directions.
- Single-machine simulation: run a full calibration with no camera and no peer from the Link Check screen via **Simulate (no camera)**. It uses a simulated optical channel and the real calibration code.
- 145 unit and simulation tests, plus 8 Playwright browser tests.

Not implemented:

- Physical measurement of any kind: no decode rate, distance, angle, glare or
  moire data exists.
- File transfer over the optical link (the protocol core exists; no UI drives
  it yet).
- Stream mode, ZIP/folder packaging, durable receiver storage, encryption.

## Quick start

    npm ci
    npm run dev

The camera needs a secure context, so use http://localhost or the HTTPS
deployment below. A file:// page cannot open a camera in most browsers.

## Verification

    npm run typecheck
    npm test
    npm run build
    npx playwright install chromium   # once
    npm run test:e2e

## Deploying to GitHub Pages

Pages serves the site over HTTPS, which is a secure context, so the camera and
the service worker both work. A project site lives at /<repo>/, and the build
already uses relative asset paths.

1. Push the repository to GitHub and set Settings -> Pages -> Source to
   GitHub Actions.
2. Push to main. .github/workflows/deploy.yml typechecks, runs the unit tests,
   builds, verifies the artifact, and publishes dist/.

The workflow fails rather than publishing a broken site: it requires
dist/index.html, dist/sw.js, dist/manifest.json and dist/.nojekyll, and it
rejects any root-absolute asset path in the HTML.

Notes:

- dist/ is gitignored on purpose; CI builds it on every deploy.
- .nojekyll ships with the site so Pages does not run Jekyll over it.
- The manifest is manifest.json, not .webmanifest, because Pages has served the
  latter as application/octet-stream, which browsers ignore. The browser suite
  asserts the served content type is JSON.
- The single-file build is not published: it cannot open a camera from
  file:// anyway.

## Documentation

- docs/IMPLEMENTATION-STATUS.md - phase checklist
- docs/ARCHITECTURE.md - module boundaries and data flow
- docs/PROTOCOL.md - frame envelope, CRC, payloads, state machines
- docs/QR.md - QR encoding, rendering, decoding and the byte-fidelity gate
- docs/DEVICE-IO.md - camera, scanner, display and wake-lock behaviour
- docs/TESTING.md - what is tested and what is not
- CHANGELOG.md - changes
