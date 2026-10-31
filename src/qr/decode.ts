import jsQR from 'jsqr';
import type { RgbaImage } from './render';

/**
 * Decodes a QR image with jsQR. Returns the decoded text or null when no
 * symbol was found. Text-only decoding is why version 1 uses the QRF1 text
 * envelope; binary payloads travel Base64URL-encoded inside it.
 */
export function decodeQrText(image: RgbaImage): string | null {
  const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
  return result ? result.data : null;
}
