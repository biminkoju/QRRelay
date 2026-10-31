/** Random-access transfer source. Sender-side files expose slice() similarly. */
export interface TransferSource {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function sourceFromBytes(name: string, bytes: Uint8Array, sha256: string): TransferSource {
  return {
    name,
    size: bytes.length,
    sha256,
    async read(offset, length) {
      return bytes.slice(offset, Math.min(offset + length, bytes.length));
    },
  };
}
