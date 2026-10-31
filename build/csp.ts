import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

/** Content Security Policy for production builds. */
export const BASE_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

export function cspPlugin(): Plugin {
  return {
    name: 'qrrelay-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: BASE_POLICY },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}
