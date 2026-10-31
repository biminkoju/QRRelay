import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { sha256Base64 } from './csp';

interface Tag {
  start: number;
  end: number;
  attrs: string;
  /** The exact original tag text, so it can be re-emitted with one attribute changed. */
  html: string;
}

function extractTags(html: string, name: string): Tag[] {
  const tags: Tag[] = [];
  const open = '<' + name;
  let i = 0;
  for (;;) {
    i = html.indexOf(open, i);
    if (i === -1) break;
    const end = html.indexOf('>', i);
    if (end === -1) break;
    tags.push({ start: i, end: end + 1, attrs: html.slice(i + open.length, end), html: html.slice(i, end + 1) });
    i = end + 1;
  }
  return tags;
}

function attr(attrs: string, name: string): string | null {
  const needle = name + '=';
  const at = attrs.indexOf(needle);
  if (at === -1) return null;
  const quote = attrs.charAt(at + needle.length);
  if (quote !== '"' && quote !== "'") return null;
  const start = at + needle.length + 1;
  const end = attrs.indexOf(quote, start);
  if (end === -1) return null;
  return attrs.slice(start, end);
}

function stripRelative(p: string): string {
  if (p.startsWith('./')) return p.slice(2);
  if (p.startsWith('/')) return p.slice(1);
  return p;
}

/** Inlines the built JS/CSS into a single self-contained qrrelay.html. */
export function singleFilePlugin(outDir = 'dist-single'): Plugin {
  return {
    name: 'qrrelay-single-file',
    apply: 'build',
    closeBundle() {
      const root = resolve(process.cwd(), outDir);
      const indexPath = join(root, 'index.html');
      let html = readFileSync(indexPath, 'utf8');
      let scriptText = '';
      let styleText = '';
      let iconInlined = false;

      for (const tag of extractTags(html, 'script').reverse()) {
        const src = attr(tag.attrs, 'src');
        if (!src) continue;
        const code = readFileSync(join(root, stripRelative(src)), 'utf8')
          .split('</script').join('<\\/script');
        scriptText += code;
        html = html.slice(0, tag.start) + '<script type="module">' + code + '</script>' + html.slice(tag.end);
      }

      for (const tag of extractTags(html, 'link').reverse()) {
        const rel = attr(tag.attrs, 'rel');
        if (rel === 'stylesheet') {
          const href = attr(tag.attrs, 'href');
          if (!href) continue;
          const css = readFileSync(join(root, stripRelative(href)), 'utf8');
          styleText += css;
          html = html.slice(0, tag.start) + '<style>' + css + '</style>' + html.slice(tag.end);
        } else if (rel === 'modulepreload' || rel === 'manifest') {
          html = html.slice(0, tag.start) + html.slice(tag.end);
        } else if (rel === 'icon' || rel === 'apple-touch-icon') {
          const href = attr(tag.attrs, 'href');
          if (!href) continue;
          // Keep exactly one icon, inlined. Any other icon link would point at
          // a file that is deleted below, and the strict CSP only allows data:.
          if (rel === 'icon' && href.endsWith('.svg') && iconInlined === false) {
            const svg = readFileSync(join(root, stripRelative(href)), 'utf8');
            const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
            iconInlined = true;
            html = html.slice(0, tag.start) + tag.html.split('href="' + href + '"').join('href="' + uri + '"') + html.slice(tag.end);
          } else {
            html = html.slice(0, tag.start) + html.slice(tag.end);
          }
        }
      }

      const policy = [
        "default-src 'none'",
        "script-src 'sha256-" + sha256Base64(scriptText) + "'",
        "style-src 'sha256-" + sha256Base64(styleText) + "'",
        'img-src data:',
        "font-src 'none'",
        "worker-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');

      for (const tag of extractTags(html, 'meta').reverse()) {
        if (tag.attrs.indexOf('Content-Security-Policy') === -1) continue;
        html =
          html.slice(0, tag.start) +
          '<meta http-equiv="Content-Security-Policy" content="' + policy + '">' +
          html.slice(tag.end);
      }

      writeFileSync(join(root, 'qrrelay.html'), html);

      for (const entry of readdirSync(root)) {
        if (entry === 'qrrelay.html') continue;
        rmSync(join(root, entry), { recursive: true, force: true });
      }
    },
  };
}
