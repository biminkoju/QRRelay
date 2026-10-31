# Protocol (v1, draft)

Status: implemented in `src/protocol` and covered by unit tests. Wire details below are frozen for `QRF1`; the binary family is not implemented yet.

## Frame envelope

    QRF1|TYPE|SESSION_ID|SEQUENCE|PAYLOAD_BASE64URL|CRC32

- `QRF1` fixed magic.
- `TYPE` one of CAL_BEACON, CAL_PROBE, CAL_PROBE_RESULT, CAL_RATE_START, CAL_RATE_FRAME, CAL_RATE_RESULT, CAL_PING, CAL_PONG, HELLO, READY, META, META_ACCEPT, DATA, ACK, NACK, END, COMPLETE, FIN, ABORT, ERROR.
- `SESSION_ID` 32 lowercase hex chars (128 bits). The all-zero ID is accepted only for `CAL_*` frames, all of which use it.
- `SEQUENCE` unsigned decimal, 0..4294967295.
- `PAYLOAD_BASE64URL` Base64URL without padding; empty for META_ACCEPT and FIN.
- `CRC32` eight lowercase hex chars.

Maximum payload is 4096 bytes. JSON payloads are capped at 4096 bytes before parsing.

## CRC

CRC-32/ISO-HDLC: reflected polynomial 0xEDB88320, initial value 0xFFFFFFFF, final XOR 0xFFFFFFFF, computed over this exact byte sequence:

1. UTF-8 bytes of `QRF1`
2. one 0x00 byte
3. UTF-8 bytes of TYPE
4. one 0x00 byte
5. the 16 session-ID bytes decoded from hex
6. one 0x00 byte
7. sequence as unsigned 32-bit big-endian
8. one 0x00 byte
9. the decoded payload bytes

Check vector: CRC-32 of ASCII `123456789` is `cbf43926`.

## Parser validation order

1. Field count must be 6.
2. Magic.
3. TYPE recognised.
4. Session ID syntax (and the all-zero restriction).
5. Sequence format and range.
6. Base64URL validity and payload size.
7. CRC format and value.
8. Typed payload decode and validation.

Only a frame passing all eight steps reaches a state machine.

## Payloads

| Type | Payload |
|---|---|
| CAL_BEACON | JSON: appVersion, buildId, protocolVersions[], capabilities[], nonce (32 hex), seen (32 hex or null) |
| CAL_PROBE | JSON: step, total, probeId, bytes (1..1024), ecl (L/M/Q/H), filler (base64url of exactly `bytes` bytes) |
| CAL_PROBE_RESULT | JSON: step, ok, observedBytes |
| CAL_RATE_START | JSON: burstId, frames (1..64), bytes (1..1024). Reserved; the current runner sends CAL_RATE_FRAME without it |
| CAL_RATE_FRAME | JSON: burstId, index (0..63), filler (base64url) |
| CAL_RATE_RESULT | JSON: burstId, received, frames, elapsedMs |
| CAL_PING | JSON: pingId, t0 (sender's monotonic ms) |
| CAL_PONG | JSON: pingId, t0 echoed, t1 (responder's monotonic ms) |
| HELLO | JSON: appVersion, buildId, protocolVersions[], capabilities[], transferModes[] |
| READY | JSON: accepted, protocolVersion, capabilities[], transferMode, optional reason |
| META | JSON: name, kind=file, size, sha256, encoding=identity, transferSize, transferMode=reliable, chunkSize, totalChunks |
| META_ACCEPT | empty |
| DATA | raw bytes, at most chunkSize |
| ACK | JSON: nextExpected |
| NACK | JSON: nextExpected, reason (missing or out-of-order) |
| END | JSON: totalChunks, size, sha256 |
| COMPLETE | JSON: size, sha256 |
| FIN | empty |
| ABORT | JSON: reason |
| ERROR | JSON: code, message |

META validation cross-checks `totalChunks == ceil(size/chunkSize)` and `transferSize == size` for identity encoding.

## Calibration

Runs only after both sides reach link-up (each beacon acknowledges the other's nonce) and both derive the same `calId = first 16 bytes of SHA-256(smaller || larger nonce)`.

One screen transmits while the other is scanned; the roles never transmit simultaneously.

1. Forward probe ladder (leader transmits): payload sizes 32, 64, 128, 256, 512, 1024 bytes at a fixed EC level (`M`). Filler is deterministic from `calId` and `probeId`.
2. Reverse probe ladder (follower transmits): the same ladder in the other direction.
3. Rate burst (leader transmits): `CAL_RATE_FRAME` sequence; the follower reports how many distinct indices it saw.
4. Ping/pong (leader transmits): 3 pings; RTT is measured on the leader's monotonic clock only.

A probe counts as confirmed only when `ok` is true **and** `observedBytes` equals the requested size exactly. A missing answer is a failure, never a retry-forever.

`chunkSize = max(64, min(4096, floor(min(forward, reverse) / 2)))`. Both sides derive their own profile from what they personally observed, so a one-way link yields `bidirectional: false` rather than a confident number.

## Reliable mode

Stop-and-wait. At most one unacknowledged DATA frame exists.

Sender:

1. Send HELLO, wait for READY.
2. Send META, wait for META_ACCEPT.
3. Send DATA n; do not advance until a valid ACK with nextExpected = n+1.
4. NACK for the in-flight chunk retransmits it.
5. ACK timeout retransmits the same chunk. After `maxRetries` consecutive timeouts the sender reports failure; it never converts timeouts into success.
6. After the last ACK, send END and wait for COMPLETE.
7. On a valid COMPLETE matching size and hash, send FIN and report Confirmed.

Receiver:

- seq == nextExpected: commit to storage, increment, ACK.
- seq < nextExpected: duplicate, do not store, re-send current ACK.
- seq > nextExpected: do not store, send NACK.
- Invalid CRC or wrong session: ignored before state mutation.
- END: verify META consistency, chunk count, size and SHA-256, then send COMPLETE.
- A duplicate END or DATA after completion re-sends COMPLETE (idempotent).

## Terminal states

- Sender: Confirmed, Unconfirmed, Failed.
- Receiver: Verified, Verified (sender confirmation not seen), Failed, Cancelled.

The receiver's verification is authoritative for file correctness. The sender only reports what it observed.
