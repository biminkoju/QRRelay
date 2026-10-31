import { describe, expect, it } from 'vitest';
import { createZip, ZipError } from '../../src/transfer/zip';

/**
 * ZIP correctness is checked by an independent reader, not by asserting our
 * own byte layout. `unzip -t` verifies CRCs and the central directory; if it
 * accepts the archive, the structure is right.
 */
async function unzipTest(bytes: Uint8Array): Promise<string> {
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'zip-test-'));
  const file = join(dir, 'a.zip');
  await writeFile(file, bytes);
  return await new Promise((resolve, reject) => {
    execFile('unzip', ['-t', file], (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || stdout || error.message));
      else resolve(stdout);
    });
  });
}

async function unzipContents(bytes: Uint8Array): Promise<Record<string, string>> {
  const { writeFile, mkdtemp, readdir, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'zip-out-'));
  const file = join(dir, 'a.zip');
  await writeFile(file, bytes);
  await new Promise<void>((resolve, reject) => {
    execFile('unzip', ['-o', '-q', file, '-d', dir], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.zip')) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    out[entry.name] = await readFile(full, 'utf8');
  }
  return out;
}

describe('zip writer', () => {
  it('produces an archive that unzip accepts', async () => {
    const zip = createZip([{ name: 'hello.txt', bytes: new TextEncoder().encode('hello') }]);
    const output = await unzipTest(zip);
    expect(output).toContain('No errors detected');
  }, 30000);

  it('round-trips several files with the right contents', async () => {
    const enc = new TextEncoder();
    const zip = createZip([
      { name: 'a.txt', bytes: enc.encode('alpha') },
      { name: 'b.txt', bytes: enc.encode('bravo') },
      { name: 'dir/c.txt', bytes: enc.encode('charlie') },
    ]);
    const files = await unzipContents(zip);
    expect(files['a.txt']).toBe('alpha');
    expect(files['b.txt']).toBe('bravo');
    expect(files['c.txt']).toBe('charlie');
  }, 30000);

  it('stores binary content unchanged', async () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const zip = createZip([{ name: 'all.bin', bytes }]);
    const output = await unzipTest(zip);
    expect(output).toContain('No errors detected');
  }, 30000);

  it('handles an empty file', async () => {
    const zip = createZip([{ name: 'empty.txt', bytes: new Uint8Array(0) }]);
    const output = await unzipTest(zip);
    expect(output).toContain('No errors detected');
  }, 30000);

  it('is deterministic when no timestamp is given', () => {
    const enc = new TextEncoder();
    const one = createZip([{ name: 'x.txt', bytes: enc.encode('same') }]);
    const two = createZip([{ name: 'x.txt', bytes: enc.encode('same') }]);
    expect(Array.from(one)).toEqual(Array.from(two));
  });

  it('rejects duplicate names', () => {
    expect(() =>
      createZip([{ name: 'a.txt', bytes: new Uint8Array(1) }, { name: 'a.txt', bytes: new Uint8Array(1) }]),
    ).toThrow(ZipError);
  });

  it('rejects an empty archive', () => {
    expect(() => createZip([])).toThrow(ZipError);
  });

  it('rejects traversal attempts in names', () => {
    expect(() => createZip([{ name: '../evil', bytes: new Uint8Array(1) }])).toThrow(ZipError);
  });
});
