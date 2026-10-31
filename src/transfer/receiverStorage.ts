/**
 * Receiver chunk storage.
 *
 * This prototype keeps committed chunks in memory. It is clearly labelled
 * process-lifetime only; docs/RECEIVER-STORAGE.md explains the plan for
 * IndexedDB/OPFS before claiming large-file durability.
 *
 * The contract that matters for the protocol: commitChunk() must resolve only
 * after the bytes are held by the storage layer, and only then may the
 * receiver emit an ACK.
 */
export interface ReceiverStorage {
  /** Byte length written for each committed chunk, keyed by sequence. */
  readonly committedChunks: number;
  /** Total bytes committed so far. */
  readonly committedBytes: number;
  has(sequence: number): boolean;
  commitChunk(sequence: number, bytes: Uint8Array): Promise<void>;
  assemble(): Promise<Uint8Array>;
}

export interface InMemoryStorageOptions {
  /** Fail commitChunk at this sequence, to exercise storage failures. */
  failAtSequence?: number;
}

export class InMemoryReceiverStorage implements ReceiverStorage {
  private readonly chunks = new Map<number, Uint8Array>();
  private readonly failAtSequence: number | undefined;
  private bytes = 0;

  constructor(options: InMemoryStorageOptions = {}) {
    this.failAtSequence = options.failAtSequence;
  }

  get committedChunks(): number {
    return this.chunks.size;
  }

  get committedBytes(): number {
    return this.bytes;
  }

  has(sequence: number): boolean {
    return this.chunks.has(sequence);
  }

  async commitChunk(sequence: number, bytes: Uint8Array): Promise<void> {
    if (this.failAtSequence === sequence) throw new Error('simulated storage failure at chunk ' + sequence);
    if (this.chunks.has(sequence)) throw new Error('chunk ' + sequence + ' already committed');
    this.chunks.set(sequence, bytes.slice());
    this.bytes += bytes.length;
  }

  async assemble(): Promise<Uint8Array> {
    const sequences = [...this.chunks.keys()].sort((a, b) => a - b);
    const out = new Uint8Array(this.bytes);
    let offset = 0;
    for (const sequence of sequences) {
      const chunk = this.chunks.get(sequence);
      if (!chunk) throw new Error('missing chunk ' + sequence);
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
