/**
 * Durable receiver storage backed by IndexedDB.
 *
 * The in-memory prototype proves the protocol but cannot survive a reload and
 * cannot hold a large file. IndexedDB gives both: chunks are persisted as they
 * arrive, so a reload can resume, and the browser pages them to disk instead of
 * holding everything in RAM.
 *
 * Two rules from the protocol contract still apply:
 *  - commitChunk() resolves only once the bytes are durable, because the
 *    receiver emits an ACK immediately afterwards.
 *  - Chunks are keyed by sequence and read back in order, so duplicate or
 *    out-of-order arrivals cannot corrupt the result.
 */
import type { ReceiverStorage } from './receiverStorage';

const DB_NAME = 'qrrelay-receiver';
const DB_VERSION = 1;
const STORE = 'chunks';

interface StoredChunk {
  key: string;
  sequence: number;
  bytes: ArrayBuffer;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
  });
}

export class IndexedDbReceiverStorage implements ReceiverStorage {
  private committedCount = 0;
  private committedByteCount = 0;
  private db: IDBDatabase | null = null;
  private readonly sequences = new Set<number>();

  constructor(private readonly sessionId: string) {}

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private async database(): Promise<IDBDatabase> {
    if (this.db === null) this.db = await openDb();
    return this.db;
  }

  private keyFor(sequence: number): string {
    return this.sessionId + ':' + String(sequence).padStart(10, '0');
  }

  get committedChunks(): number {
    return this.committedCount;
  }

  get committedBytes(): number {
    return this.committedByteCount;
  }

  has(sequence: number): boolean {
    return this.sequences.has(sequence);
  }

  async commitChunk(sequence: number, bytes: Uint8Array): Promise<void> {
    if (this.sequences.has(sequence)) throw new Error('chunk ' + sequence + ' already committed');
    const db = await this.database();
    const record: StoredChunk = {
      key: this.keyFor(sequence),
      sequence,
      bytes: bytes.slice().buffer as ArrayBuffer,
    };
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    // Resolve on transaction commit, not on request success: an ACK must never
    // precede durability.
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'));
    });
    this.sequences.add(sequence);
    this.committedCount++;
    this.committedByteCount += bytes.length;
  }

  private async mine(): Promise<StoredChunk[]> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readonly');
    const all = await requestToPromise(tx.objectStore(STORE).getAll() as IDBRequest<StoredChunk[]>);
    const prefix = this.sessionId + ':';
    return all.filter((r) => r.key.startsWith(prefix)).sort((a, b) => a.sequence - b.sequence);
  }

  /** Loads what is already stored, so a reload can resume. */
  async load(): Promise<void> {
    for (const record of await this.mine()) {
      if (this.sequences.has(record.sequence)) continue;
      this.sequences.add(record.sequence);
      this.committedCount++;
      this.committedByteCount += record.bytes.byteLength;
    }
  }

  async assemble(): Promise<Uint8Array> {
    const chunks = await this.mine();
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.bytes.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(new Uint8Array(chunk.bytes), offset);
      offset += chunk.bytes.byteLength;
    }
    return out;
  }

  /** Removes this session's chunks. Call after a successful save. */
  async clear(): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const prefix = this.sessionId + ':';
    const keys = await requestToPromise(store.getAllKeys() as IDBRequest<IDBValidKey[]>);
    for (const key of keys) {
      if (typeof key === 'string' && key.startsWith(prefix)) store.delete(key);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
    });
    this.sequences.clear();
    this.committedCount = 0;
    this.committedByteCount = 0;
  }
}
