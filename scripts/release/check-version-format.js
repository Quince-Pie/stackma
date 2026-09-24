import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FirefoxDriver } from "../webdriver.js";
import { run, versionFromTag } from "./package.js";

// Exercise the ecosystem oracle as well as our parser. These are temporary
// installs in an isolated browser profile, never AMO submissions or releases.
const directory = await mkdtemp(join(tmpdir(), "stackma-version-format-"));
const output = resolve("artifacts/release-version-format.json");
const versions = ["65536.0.0", "999999999.999999999.999999999"];
let driver;
const checks = [];
try {
  await mkdir("artifacts", { recursive: true });
  const files = (await run("git", ["ls-files", "-z", "extension/"], { timeout: 30_000 })).stdout.split("\0").filter(Boolean);
  driver = await FirefoxDriver.start();
  for (const version of versions) {
    assert.equal(versionFromTag(`v${version}`), version);
    const source = join(directory, version);
    await mkdir(source);
    for (const file of files) {
      const relative = file.slice("extension/".length);
      assert(!relative.includes("/"), "Version probe expects the flat extension package");
      await copyFile(file, join(source, relative));
    }
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
    manifest.version = version;
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await run(process.execPath, [resolve("node_modules/web-ext/bin/web-ext.js"), "lint", "--source-dir", source, "--warnings-as-errors"], { timeout: 60_000 });
    const xpi = join(directory, `${version}.xpi`);
    await run("zip", ["-q", "-X", "-r", xpi, "."], { cwd: source, timeout: 30_000 });
    const id = await driver.installAddon(xpi);
    const actual = await driver.addon(id, browser => browser.runtime.getManifest().version);
    assert.equal(actual, version, "Firefox must preserve the complete accepted version");
    checks.push({ version, lint: true, temporaryFirefoxInstall: true, actual });
  }
  await writeFile(output, JSON.stringify({ passed: true, firefox: driver.capabilities.browserVersion,
    buildId: driver.capabilities["moz:buildID"], checks }, null, 2) + "\n");
  console.log(`Firefox and Mozilla lint accepted both AMO version boundaries (${driver.capabilities.browserVersion}).`);
} catch (error) {
  try {
    await writeFile(output, JSON.stringify({ passed: false, checks, error: String(error) }, null, 2) + "\n");
  } catch { console.error("Could not write version-format diagnostics"); }
  throw error;
} finally {
  try {
    if (driver) {
      await driver.close();
      await writeFile(`${output}.log`, driver.logs);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}
