import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const TEXT_EXTENSIONS = ['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt'];

// Strings that look like URLs but are never fetched. Each entry is explained.
const ALLOWED = [
  // W3C XML/SVG namespace identifiers, not network locations.
  /^http:\/\/www\.w3\.org\/[A-Za-z0-9._\/#-]*$/,
];

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else out.push(full);
  }
  return out;
}

function findUrls(text) {
  const found = [];
  const stops = '"\'`<>)\\ \n\t\r,;';
  for (const scheme of ['http://', 'https://']) {
    let i = 0;
    for (;;) {
      i = text.indexOf(scheme, i);
      if (i === -1) break;
      let j = i + scheme.length;
      while (j < text.length && stops.indexOf(text.charAt(j)) === -1) j++;
      found.push(text.slice(i, j));
      i = j;
    }
  }
  return found;
}

const roots = ['dist', 'dist-single'].filter((d) => existsSync(d));
if (roots.length === 0) {
  console.error('check-no-remote: no build output found (build first)');
  process.exit(1);
}

let failures = 0;
let checked = 0;
for (const root of roots) {
  for (const file of collectFiles(root)) {
    if (!TEXT_EXTENSIONS.includes(file.slice(file.lastIndexOf('.')))) continue;
    checked++;
    for (const url of findUrls(readFileSync(file, 'utf8'))) {
      if (ALLOWED.some((re) => re.test(url))) continue;
      failures++;
      console.error('remote reference: ' + relative(process.cwd(), file) + ' -> ' + url);
    }
  }
}

if (failures > 0) {
  console.error('check-no-remote: FAILED (' + failures + ' suspicious reference(s) in ' + checked + ' files)');
  process.exit(1);
}
console.log('check-no-remote: OK (' + checked + ' files scanned, no runtime network references)');
