import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

const lines = [];
for (const root of ['dist', 'dist-single']) {
  if (!existsSync(root)) continue;
  for (const file of collectFiles(root).sort()) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    lines.push(hash + '  ' + relative(process.cwd(), file).split('\\').join('/'));
  }
}
writeFileSync('RELEASE-CHECKSUMS.txt', lines.join('\n') + '\n');
console.log('release-checksums: wrote ' + lines.length + ' entries to RELEASE-CHECKSUMS.txt');
