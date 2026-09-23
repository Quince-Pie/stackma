import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
await run(process.execPath, ["naming-data/build-pack.mjs", "--check"], { timeout: 30_000 });
await run(process.execPath, ["scripts/compile-names.js", "--check"], { timeout: 30_000 });
const source = resolve("extension");
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const files = (await readdir(source, { withFileTypes: true }))
  .map(entry => {
    if (!entry.isFile()) throw new Error(`Unexpected extension entry: ${entry.name}`);
    return entry.name;
  }).sort();
const output = resolve("dist", `stackma-${manifest.version}.xpi`);
const stage = await mkdtemp(join(tmpdir(), "stackma-build-"));
const epoch = new Date("2020-01-01T00:00:00Z");
try {
  await mkdir(resolve("dist"), { recursive: true });
  for (const file of files) {
    const target = join(stage, file);
    await copyFile(join(source, file), target);
    await utimes(target, epoch, epoch);
  }
  await rm(output, { force: true });
  await run("zip", ["-X", "-q", output, ...files], {
    cwd: stage, timeout: 30_000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  });
  const digest = createHash("sha256").update(await readFile(output)).digest("hex");
  await writeFile(`${output}.sha256`, `${digest}  stackma-${manifest.version}.xpi\n`);
  console.log(`${output}\nSHA-256 ${digest}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
