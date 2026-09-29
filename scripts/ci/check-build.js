import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openPromise } from 'yauzl';
import { artifactNames, brandMetadata } from '../release/package.js';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const names = artifactNames({ version: manifest.version, ...brandMetadata(manifest) });
const paths = [resolve('dist', names.xpi), resolve('dist', names.chrome)];
const build = () => execFileSync(process.execPath, ['scripts/build.js'], {
  stdio: 'inherit', timeout: 60_000,
});
build();
const first = await Promise.all(paths.map(path => readFile(path)));
build();
const second = await Promise.all(paths.map(path => readFile(path)));
const packages = paths.map((path, index) => {
  assert.deepEqual(second[index], first[index], `Identical inputs must produce identical bytes: ${path}`);
  return { path, bytes: second[index].length, sha256: createHash('sha256').update(second[index]).digest('hex') };
});
// Byte identity on one machine does not prove independence from the builder's
// umask; every member must carry the fixed regular-file mode.
for (const path of paths) {
  const zip = await openPromise(path, { autoClose: false });
  try {
    for await (const entry of zip.eachEntry()) {
      assert.equal(entry.externalFileAttributes >>> 16, 0o100644, `${entry.fileName} in ${path} must be a 0644 regular file`);
    }
  } finally { zip.close(); }
}
await mkdir('artifacts/ci', { recursive: true });
// The first entry keeps the original single-package fields for existing readers.
await writeFile('artifacts/ci/build.json', JSON.stringify({
  passed: true, ...packages[0], identicalBuilds: 2, packages,
}, null, 2) + '\n');
for (const { path, sha256 } of packages) console.log(`Reproducible ${path}: ${sha256}`);
