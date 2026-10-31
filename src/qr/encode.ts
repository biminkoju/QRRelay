import qrcodegen from 'nayuki-qr-code-generator';

export type EccLevel = 'L' | 'M' | 'Q' | 'H';

const ECC: Record<EccLevel, qrcodegen.QrCode.Ecc> = {
  L: qrcodegen.QrCode.Ecc.LOW,
  M: qrcodegen.QrCode.Ecc.MEDIUM,
  Q: qrcodegen.QrCode.Ecc.QUARTILE,
  H: qrcodegen.QrCode.Ecc.HIGH,
};

export class QrEncodeError extends Error {
  override name = 'QrEncodeError';
  readonly code: 'TOO_LONG' | 'EMPTY';
  constructor(code: 'TOO_LONG' | 'EMPTY', message: string) {
    super(message);
    this.code = code;
  }
}

export interface EncodedQr {
  /** Side length in modules, excluding the quiet zone. */
  size: number;
  /** QR version 1..40. */
  version: number;
  ecl: EccLevel;
  /** True where a module is dark. */
  isDark(x: number, y: number): boolean;
  /** Full module matrix as rows of booleans (true = dark). */
  modules: boolean[][];
}

/** Encodes a QRF1 frame string into a QR symbol with an explicit EC level. */
export function encodeQr(text: string, ecl: EccLevel): EncodedQr {
  if (text.length === 0) throw new QrEncodeError('EMPTY', 'cannot encode an empty QR payload');
  let code: qrcodegen.QrCode;
  try {
    code = qrcodegen.QrCode.encodeText(text, ECC[ecl]);
  } catch (error) {
    throw new QrEncodeError('TOO_LONG', 'payload does not fit the QR capacity: ' + (error as Error).message);
  }
  const modules: boolean[][] = [];
  for (let y = 0; y < code.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < code.size; x++) row.push(code.getModule(x, y));
    modules.push(row);
  }
  return {
    size: code.size,
    version: code.version,
    ecl,
    isDark: (x, y) => code.getModule(x, y),
    modules,
  };
}

/** Largest QRF1 frame text that fits in a QR code at the given level. */
export function maxFrameTextLength(ecl: EccLevel): number {
  let lo = 1;
  let hi = 3000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    try {
      qrcodegen.QrCode.encodeText('A'.repeat(mid), ECC[ecl]);
      lo = mid;
    } catch {
      hi = mid - 1;
    }
  }
  return lo;
}
