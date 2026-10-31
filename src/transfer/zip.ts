/**
 * Minimal ZIP writer: store method only, no compression.
 *
 * Why not deflate: compression would change the bytes the link carries, and
 * the optical channel is already the bottleneck. A stored archive is also
 * trivial to verify byte-for-byte, which matters more here than size.
 *
 * Only what the format needs is implemented: local headers, central
 * directory, end-of-central-directory. No ZIP64, no encryption, no zip
 * comments. Names are stored as UTF-8 with the language-encoding flag set.
 */
import { crc32 } from '../protocol/checksum';

export interface ZipEntry {
  /** Path inside the archive. Forward slashes; no leading slash. */
  name: string;
  bytes: Uint8Array;
  /** Modification time; defaults to a fixed timestamp so output is stable. */
  modified?: Date;
}

export class ZipError extends Error {
  override name = 'ZipError';
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;

/** Default timestamp: 1980-01-01 00:00, the earliest the format allows. */
const DEFAULT_TIME = 0;
const DEFAULT_DATE = 0x0021;

function dosDateTime(date: Date | undefined): { time: number; date: number } {
  if (!date) return { time: DEFAULT_TIME, date: DEFAULT_DATE };
  const year = date.getFullYear();
  if (year < 1980) return { time: DEFAULT_TIME, date: DEFAULT_DATE };
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function normaliseName(name: string): string {
  const trimmed = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (trimmed.length === 0) throw new ZipError('entry name must not be empty');
  if (trimmed.includes('..')) throw new ZipError('entry name must not contain ..');
  return trimmed;
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
      ]),
    );
  }

  get offset(): number {
    return this.length;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length === 0) throw new ZipError('an archive needs at least one entry');

  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    const name = normaliseName(entry.name);
    if (seen.has(name)) throw new ZipError('duplicate entry name: ' + name);
    seen.add(name);
    return {
      name,
      nameBytes: new TextEncoder().encode(name),
      bytes: entry.bytes,
      crc: crc32(entry.bytes),
      when: dosDateTime(entry.modified),
    };
  });

  const out = new Writer();
  const offsets: number[] = [];

  for (const item of prepared) {
    if (item.bytes.length > 0xffffffff) throw new ZipError('entry too large for this writer');
    if (item.nameBytes.length > 0xffff) throw new ZipError('entry name too long');
    offsets.push(out.offset);
    out.u32(LOCAL_SIG);
    out.u16(20); // version needed: 2.0
    out.u16(FLAG_UTF8);
    out.u16(0); // stored
    out.u16(item.when.time);
    out.u16(item.when.date);
    out.u32(item.crc);
    out.u32(item.bytes.length);
    out.u32(item.bytes.length);
    out.u16(item.nameBytes.length);
    out.u16(0); // no extra field
    out.push(item.nameBytes);
    out.push(item.bytes);
  }

  const centralStart = out.offset;
  prepared.forEach((item, index) => {
    out.u32(CENTRAL_SIG);
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(FLAG_UTF8);
    out.u16(0);
    out.u16(item.when.time);
    out.u16(item.when.date);
    out.u32(item.crc);
    out.u32(item.bytes.length);
    out.u32(item.bytes.length);
    out.u16(item.nameBytes.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk number
    out.u16(0); // internal attributes
    out.u32(0); // external attributes
    out.u32(offsets[index]!);
    out.push(item.nameBytes);
  });
  const centralSize = out.offset - centralStart;

  out.u32(END_SIG);
  out.u16(0); // this disk
  out.u16(0); // disk with central directory
  out.u16(prepared.length);
  out.u16(prepared.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0); // comment length

  return out.finish();
}
