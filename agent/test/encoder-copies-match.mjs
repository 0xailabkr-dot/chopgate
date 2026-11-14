#!/usr/bin/env node
// Confirms the two full encoder copies in this repository are the same file.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'agent/src/vendor/chopgate-encode.mjs',
  'site/assets/vendor/chopgate-encode.u3-0340.mjs',
];
const hashes = files.map((rel) => {
  const buf = readFileSync(resolve(root, rel));
  const sha = createHash('sha256').update(buf).digest('hex');
  return { rel, sha, bytes: buf.length };
});
if (hashes[0].sha !== hashes[1].sha || hashes[0].bytes !== hashes[1].bytes) {
  console.error('encoder copies differ');
  for (const h of hashes) console.error(h.rel, h.bytes, h.sha);
  process.exit(1);
}
console.log('encoder copies match', hashes[0].bytes, hashes[0].sha);
