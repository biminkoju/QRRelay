# QR layer

## Dependencies

Both are bundled locally, pinned in `package-lock.json`, and require no network at runtime.

| Package | Version | Why |
|---|---|---|
| `nayuki-qr-code-generator` | 1.8.0 | Byte-mode QR encoding with explicit version and error-correction control. No canvas or DOM dependency, so it runs in tests and workers. |
| `jsqr` | 1.4.0 | Pure-JS QR decoding from RGBA pixels. Bundled fallback next to native `BarcodeDetector`. |

These are currently imported only by the QR modules and their tests; they enter the browser bundle when the display and camera layer arrives in Phase 3.

## Encoding

`src/qr/encode.ts` wraps `QrCode.encodeText(text, ecl)` and returns the module matrix plus version and level. EC levels are exposed as `'L' | 'M' | 'Q' | 'H'` so the calibration ladder can probe them.

Text mode is deliberate. Version 1 carries every payload as Base64URL inside the `QRF1` text envelope, so a decoder that only exposes text still works. Binary byte-mode frames stay disabled until the fidelity self-test passes on the actual encoder/decoder pair.

## Rendering

`src/qr/render.ts` produces an RGBA bitmap:

- black modules on white, nothing else
- integer pixel scale only (fractional scale throws)
- quiet zone of at least 4 modules (the QR minimum); less throws
- no anti-aliasing: every pixel is exactly black or exactly white

This matters because fractional scaling and anti-aliasing blur module edges and cost real camera decode rate.

## Decoding

`src/qr/decode.ts` calls jsQR with `inversionAttempts: 'dontInvert'` — QRRelay symbols are always dark-on-light, so inverted scanning is wasted work.

## Byte-fidelity gate

`src/qr/byteFidelity.ts` runs deterministic vectors through the real encode → render → decode path:

- every byte value 0x00–0xFF
- invalid UTF-8 lead bytes
- a lone `0xFF`
- a truncated multi-byte UTF-8 sequence
- a zero run and a `0xFF` run

Each vector travels the same way a `DATA` frame does: Base64URL text inside a QR symbol. Bytes are compared exactly after decoding. If any vector fails, binary framing must stay disabled and the failure is reported rather than hidden.

Current result on the bundled pair: all vectors pass at EC Q, scale 4.

## Simulated optical transport

`src/protocol/simulation.ts` accepts an optional `FrameCodec`. Tests supply one that renders a real QR bitmap, packs it into a string key for the fake channel, unpacks it and decodes it with jsQR. Every protocol frame in those tests therefore survives a genuine QR round trip, and channel faults are injected on top of that.

Tested end to end this way: HELLO/READY/META/META_ACCEPT/DATA/ACK/END/COMPLETE/FIN plus a multi-chunk binary transfer and a transfer with 15% frame loss in both directions.

## Not done

- No camera, so decode rate and stability are unmeasured.
- No physical test of module size versus screen and camera geometry.
- No binary (`0xB1`) frame family; it waits on a physical byte-fidelity test.
