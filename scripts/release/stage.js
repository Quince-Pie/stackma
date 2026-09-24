import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digestFile, run, sha256, validateMetadata } from "./package.js";

const tag = process.env.RELEASE_TAG;
const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const metadata = validateMetadata(tag, manifest, pkg, lock);
const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
assert.equal(commit, process.env.RELEASE_COMMIT, "Checkout must be the resolved release commit");
await run("git", ["diff", "--exit-code", "HEAD"]);
const allTracked = (await run("git", ["ls-files", "-z"])).stdout.split("\0").filter(Boolean);
assert(!allTracked.some(path => /(^|\/)\.env(?:\.|$)/u.test(path)), "Environment files must not be committed or included in release source");
// Reject untracked payload files even in a local reproduction of the release.
const tracked = (await run("git", ["ls-files", "extension/"])).stdout.trim().split("\n").map(path => path.slice(10)).sort();
const { readdir } = await import("node:fs/promises");
assert.deepEqual((await readdir("extension")).sort(), tracked, "Every packaged file must be committed");
if (process.argv.includes("--check")) {
  console.log(`Release identity and committed inputs verified: ${tag} at ${commit}`);
} else {
  const directory = resolve("artifacts/release-input");
  await mkdir(directory, { recursive: true });
  const xpi = `dist/stackma-${metadata.version}.xpi`;
  const tested = JSON.parse(await readFile("artifacts/ci/package.json", "utf8"));
  const unsigned = await digestFile(xpi);
  assert.equal(tested.passed, true);
  assert.equal(tested.sha256, unsigned.sha256, "Release must use the installed, tested XPI");
  await copyFile(xpi, `${directory}/unsigned.xpi`);
  await run("git", ["archive", "--format=zip", `--output=${directory}/source.zip`, commit], {
    timeout: 30_000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
  });
  const source = await digestFile(`${directory}/source.zip`);
  assert(source.bytes <= 200_000_000, "Mozilla source upload limit is 200 MB");
  // AMO's translated CharField strips outer whitespace. Match that canonical
  // representation while retaining both notices and all internal formatting.
  const licenseText = `${await readFile("LICENSE", "utf8")}\nCMU pronunciation data and derived metadata retain the following terms:\n\n${await readFile("naming-data/CMU-LICENSE.txt", "utf8")}`.trim();
  await writeFile(`${directory}/license.txt`, licenseText);
  const license = { name: "WTFPL 2.0; CMU data terms retained", sha256: sha256(licenseText) };
  const tools = { node: process.version, git: (await run("git", ["--version"])).stdout.trim(), webExt: pkg.devDependencies["web-ext"] };
  const context = { tag, commit, ...metadata, channel: "listed", unsigned, source, license, tools };
  await writeFile(`${directory}/context.json`, JSON.stringify(context, null, 2) + "\n");
  console.log(`Prepared ${tag} from ${commit}; unsigned SHA-256 ${unsigned.sha256}`);
}
