import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromeManifest, chromePackage, chromeVersion, firefoxOnly } from '../scripts/chrome-package.js';
import { serializeManifest } from '../scripts/release/package.js';

const firefox = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const template = JSON.parse(await readFile('chrome/manifest.json', 'utf8'));

test('Chrome versions follow the documented integer rules', () => {
  for (const version of ['1', '1.2', '1.1.12', '65535.65535.65535.65535', '0.0.1']) assert.equal(chromeVersion(version), version);
  for (const version of ['', '0', '0.0.0.0', '1.02', '65536.0.0', '1.2.3.4.5', 'v1.2.3', '1..2', '1.2.3-beta', 1]) {
    assert.throws(() => chromeVersion(version), undefined, String(version));
  }
});

test('the Chrome manifest is derived, not duplicated, and never drifts from Firefox', () => {
  const manifest = chromeManifest(firefox, template);
  assert.deepEqual(Object.keys(manifest).slice(0, 3), ['manifest_version', 'name', 'version']);
  assert.equal(manifest.version, firefox.version);
  assert.deepEqual(manifest.permissions, firefox.permissions);
  assert.equal(manifest.name, 'Tab Gantry - Automatic Tab Groups');
  assert.equal(manifest.minimum_chrome_version, '148');
  assert.equal(manifest.incognito, 'spanning');
  assert(!Object.hasOwn(manifest, 'browser_specific_settings'));
  assert(manifest.description.length <= 132);
  assert.throws(() => chromeManifest(firefox, { ...template, version: '1.0.0' }), /takes its version/);
  assert.throws(() => chromeManifest(firefox, { ...template, permissions: [...template.permissions, 'tabs'] }), /differ in permissions/);
  assert.throws(() => chromeManifest(firefox, { ...template, name: 'Other' }), /differ in name/);
  assert.throws(() => chromeManifest(firefox, { ...template, name: `${firefox.name}Other` }), /differ in name/);
  assert.throws(() => chromeManifest(firefox, { ...template, name: `${firefox.name} - ${'x'.repeat(73 - firefox.name.length)}` }), /75 characters/);
  assert.equal(chromeManifest(firefox, { ...template, name: firefox.name }).name, firefox.name);
  assert.throws(() => chromeManifest(firefox, { ...template, action: { ...template.action, default_popup: 'other.html' } }), /action\.default_popup/);
  assert.throws(() => chromeManifest(firefox, { ...template, description: 'x'.repeat(133) }), /132/);
  assert.throws(() => chromeManifest(firefox, { ...template, background: { service_worker: 'service-worker.js' } }));
  assert.throws(() => chromeManifest({ ...firefox, version: '70000.0.0' }, template), /65535/);
});

test('the package is the shared extension without Firefox entry files, plus Chrome files', async () => {
  const { manifest, entries } = await chromePackage();
  const names = entries.map(entry => entry.name);
  assert.deepEqual(names, [...names].sort());
  const shared = (await readdir('extension')).filter(name => !firefoxOnly.has(name));
  assert.deepEqual(new Set(names), new Set([...shared, ...await readdir('chrome/extension'), 'manifest.json']));
  assert(!names.includes('background.js'));
  assert.equal(entries.find(entry => entry.name === 'manifest.json').content, serializeManifest(manifest));
});

test('stale or unrecorded Chrome icons stop the build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tab-gantry-chrome-package-'));
  try {
    for (const path of ['extension', 'chrome']) await cp(path, join(root, path), { recursive: true });
    await chromePackage(root);
    await writeFile(join(root, 'extension/icon.svg'), (await readFile('extension/icon.svg', 'utf8')).replace('#455bd4', '#455bd5'));
    await assert.rejects(chromePackage(root), /rendered from a different extension\/icon\.svg/);
    await cp('extension/icon.svg', join(root, 'extension/icon.svg'));
    await cp('chrome/extension/icon-32.png', join(root, 'chrome/extension/icon-16.png'));
    await assert.rejects(chromePackage(root), /icon-16\.png must be 16x16/);
    await cp('chrome/extension/icon-16.png', join(root, 'chrome/extension/icon-16.png'));
    await writeFile(join(root, 'chrome/extension/core.js'), '// collides with the shared core\n');
    await assert.rejects(chromePackage(root), /exists in both extension\/ and chrome\/extension\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
