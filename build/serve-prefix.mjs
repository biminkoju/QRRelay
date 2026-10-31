#!/usr/bin/env node
/**
 * Serves a directory under a URL prefix, the way GitHub Pages serves a
 * project site at /<repo>/. The browser tests use it to prove the build does
 * not rely on being served from the origin root.
 *
 * Usage: node build/serve-prefix.mjs <dir> <prefix> <port>
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const [, , dir = 'dist', prefix = '/repo/', portText = '4175'] = process.argv;
const port = Number(portText);
const root = normalize(join(process.cwd(), dir));
const base = '/' + prefix.replace(/^\/+|\/+$/g, '') + '/';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith(base)) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('outside the prefix');
    return;
  }
  let relative = decodeURIComponent(url.pathname.slice(base.length));
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  const file = normalize(join(root, relative));
  // Refuse anything that escapes the served directory.
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-length': body.length,
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }
});

server.listen(port, () => {
  console.log('serving ' + dir + ' at http://localhost:' + port + base);
});
