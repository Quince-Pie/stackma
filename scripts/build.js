import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromePackage } from "./chrome-package.js";
import { artifactNames, brandMetadata } from "./release/package.js";

const run = promisify(execFile);
await run(process.execPath, ["naming-data/build-pack.mjs", "--check"], { timeout: 30_000 });
await run(process.execPath, ["scripts/compile-names.js", "--check"], { timeout: 30_000 });
const epoch = new Date("2020-01-01T00:00:00Z");

/**
 * Copy sorted entries (a source path or literal content) with a fixed mtime and
 * mode. zip records permission bits, so the checkout's umask must not leak in.
 */
async function stage(directory, entries) {
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.path) await copyFile(entry.path, target);
    else await writeFile(target, entry.content);
    await chmod(target, 0o644);
    await utimes(target, epoch, epoch);
  }
}

async function archive(filename, entries) {
  const output = resolve("dist", filename);
  const directory = await mkdtemp(join(tmpdir(), "tab-gantry-build-"));
  try {
    await stage(directory, entries);
    await rm(output, { force: true });
    await run("zip", ["-X", "-q", output, ...entries.map(entry => entry.name)], {
      cwd: directory, timeout: 30_000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    const digest = createHash("sha256").update(await readFile(output)).digest("hex");
    await writeFile(`${output}.sha256`, `${digest}  ${filename}\n`);
    console.log(`${output}\nSHA-256 ${digest}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const source = resolve("extension");
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const files = (await readdir(source, { withFileTypes: true }))
  .map(entry => {
    if (!entry.isFile()) throw new Error(`Unexpected extension entry: ${entry.name}`);
    return entry.name;
  }).sort();
const names = artifactNames({ version: manifest.version, ...brandMetadata(manifest) });
await mkdir(resolve("dist"), { recursive: true });
await archive(names.xpi, files.map(name => ({ name, path: join(source, name) })));

// The unpacked copy is for chrome://extensions "Load unpacked" only.
const chrome = await chromePackage();
await archive(names.chrome, chrome.entries);
const unpacked = resolve("dist", "chrome");
await rm(unpacked, { recursive: true, force: true });
await mkdir(unpacked);
await stage(unpacked, chrome.entries);
