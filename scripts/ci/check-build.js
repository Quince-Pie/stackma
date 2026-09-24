import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const path = resolve('dist', `stackma-${manifest.version}.xpi`);
const build = () => execFileSync(process.execPath, ['scripts/build.js'], {
  stdio: 'inherit', timeout: 60_000,
});
build();
const first = await readFile(path);
build();
const second = await readFile(path);
assert.deepEqual(second, first, 'Identical inputs must produce identical XPI bytes');
const sha256 = createHash('sha256').update(second).digest('hex');
await mkdir('artifacts/ci', { recursive: true });
await writeFile('artifacts/ci/build.json', JSON.stringify({
  passed: true, path, bytes: second.length, sha256, identicalBuilds: 2,
}, null, 2) + '\n');
console.log(`Reproducible XPI: ${sha256}`);
