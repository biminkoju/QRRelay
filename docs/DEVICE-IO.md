# Device I/O layer

Phase 3 adds the camera and display plumbing. Nothing in this layer is
physically verified yet: no claim is made about real decode rates or geometry.

## Camera acquisition (`src/camera/cameraManager.ts`)

- Permission is requested only from a user action (the Start camera button).
- `cameraSupport()` reports the two facts that matter: secure context and the
  presence of `navigator.mediaDevices.getUserMedia`.
- `listCameras()` enumerates `videoinput` devices. Labels only appear after
  permission has been granted once; otherwise the UI shows "Camera N".
- Constraints request 1280x720 as an *ideal* size, never an exact requirement.
- Errors are classified: `INSECURE`, `UNSUPPORTED`, `DENIED`, `NO_DEVICE`,
  `FAILED`, each with a user-facing explanation.
- `stop()` stops every media track and clears `srcObject`.

### file://

`getUserMedia` needs a secure context. Installed PWAs and localhost origins
qualify. A `file://` page does not in most browsers. The UI says so instead of
offering a button that cannot work.

## Scanning (`src/camera/qrScanner.ts`)

- Frames are drawn to an **offscreen canvas, unmirrored**. The preview may be
  styled by CSS, but the CSS transform never reaches the scanner.
- `requestVideoFrameCallback` is used when available, so each camera frame is
  examined at most once. Otherwise a timer loop with a minimum interval runs.
- The analysis width is capped (default 480 px) because jsQR cost scales with
  pixels and a full-resolution frame adds nothing to QR decoding.
- Consecutive identical decodes are suppressed as an optimisation only. The
  protocol layer already treats duplicates as idempotent, so suppression can
  never change correctness.
- Scanning suspends while the document is hidden and resumes on visibility.
- `stop()` cancels the frame callback or timer and removes listeners.

## Display (`src/qr/canvas.ts`)

- Integer module scale in **device pixels** (`cssScale * devicePixelRatio`), so
  module edges stay crisp on HiDPI screens.
- White background, black modules, at least a 4-module quiet zone.
- The same QR text is not redrawn: the screen keeps the current frame until the
  state machine produces a new one.

## Wake lock (`src/camera/wakeLock.ts`)

Feature-detected and best-effort. A missing or rejected wake lock is reported
as unsupported, never as a hard failure. Re-acquisition after visibility
changes is the caller's job and will be revisited with the transfer UI.

## Link Check screen

`src/app/linkCheck.ts` wires device I/O to `src/protocol/alignment.ts`:

1. Generate a 128-bit nonce and display `CAL_BEACON`.
2. Scan the peer's display for beacons.
3. Show "I can see the peer" and "The peer can see me" separately.
4. Derive the calibration id only when both directions are confirmed.
5. Elect exactly one leader by nonce comparison.

The controller owns camera tracks, scanner and wake lock, and releases all of
them on stop or when the screen is closed.

## Calibration

`src/protocol/calibration.ts` is pure; `src/protocol/calibrationRunner.ts` drives
it and is also pure (caller supplies `nowMs` and decoded frames).

- The leader probes first; only one screen transmits calibration frames at a
  time, so the camera can stay pointed at the peer display.
- An answer frame stays on screen for `frameDwellMs` (default 400 ms) before
  the next phase replaces it. Without that dwell the peer never scans the
  final answer and both sides stall. This is a real constraint of optical
  links, not a test artefact.
- The follower cannot know when the last ping happened, so a quiet period
  after the first ping ends its side.
- Timeouts abandon a step rather than retrying forever; the profile then says
  so in `notes`.

## Bench procedure

The Link Check screen shows a raw measurements table under the beacon:

- one row per probe rung, with forward and reverse marked `ok`, `failed` or
  `no answer` (a timeout is not a decode failure);
- confirmed bytes in each direction;
- burst frames seen out of frames sent;
- each RTT sample, not just the median;
- a timeout count.

The QR is sized from the pane's rendered width, up to 1400 CSS px, so a large
probe is not hidden behind an undersized symbol. Calibration frames are drawn
at the EC level the runner reports, so the `ecl` field in the payload matches
what the camera actually saw.

Record, in this order: both directional indicators, the calibration id on both
sides, then the table after calibration. A `failed` rung with `ok` rungs above
it means the symbol was too dense at that size; a `no answer` means the peer
never scanned it at all.

## Simulating a link on one machine

The Link Check screen has a **Simulate (no camera)** button. It runs a full
calibration exchange between two real `CalibrationRunner` instances through a
simulated optical channel, with no camera and no peer:

- `src/sim/channel.ts` encodes, renders, downscales to a capture resolution,
  blurs, applies brightness, compresses contrast and adds seeded noise, then
  runs the same jsQR decoder the real scanner uses.
- `src/sim/loopback.ts` drives both runners in virtual time, so a run that would
  take a minute on hardware finishes in about a second.
- `sweepModuleSize()` reports how small a module can get before a given payload
  stops decoding.

Contrast is a separate term from brightness on purpose: a plain multiplier
scales black and white equally and therefore preserves their separation, so it
cannot model glare washout. `contrast` pulls both ends toward mid-grey.

This is a model, not a measurement. It tells you the shape of the cliff and
whether the wiring is sound. It cannot tell you your webcam's real limits.

Two honest caveats about the simulated numbers:

- The channel is configured clean (`modulePx: 8`, `captureWidth: 2400`, no blur,
  noise or contrast loss), so nothing fails and the ladder always reaches 1024 B.
  The resulting chunk size is what you get when a link never errors; it is not a
  prediction for hardware.
- Round-trip time is reported as `n/a (virtual time)`. The loopback advances a
  virtual clock in fixed steps, so its RTT is a property of the harness, not of
  any link.

A simulated run takes roughly 7-9 seconds because it renders and decodes twelve
large QR symbols. The button defers the work by one frame so the pending status
paints instead of the page appearing frozen.

## What is still missing

- Choosing the EC level by measurement: the ladder always runs at `M`.
- `CAL_RATE_START` is defined but unused; the burst length is implicit.
- Any measurement of decode rate versus payload size, EC level, distance,
  angle, brightness or moiré.
- Large probe frames make large QR symbols; at a fixed display size the module
  size in device pixels shrinks. This has not been measured on hardware.
- Two-physical-computer testing.
