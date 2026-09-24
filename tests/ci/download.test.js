import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const downloader = resolve("scripts/ci/download-verified.sh");
const firefoxInstaller = resolve("scripts/ci/install-firefox.sh");
const nixInstaller = resolve("scripts/ci/install-nix.sh");
const body = Buffer.from("Verified browser archive fixture\n");
const digest = algorithm => createHash(algorithm).update(body).digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "stackma-download-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = join(directory, "payload");
  const trace = join(directory, "curl-args");
  await writeFile(payload, body);
  const curl = join(directory, "curl");
  await writeFile(curl, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" > "$STACKMA_CURL_TRACE"
output=
while [[ $# -gt 0 ]]; do
  if [[ $1 == --output ]]; then output=$2; shift 2; else shift; fi
done
[[ -n $output ]]
if [[ $STACKMA_CURL_MODE == truncated ]]; then
  head -c 7 "$STACKMA_CURL_PAYLOAD" > "$output"
  exit 18
fi
if [[ $STACKMA_CURL_MODE == paused ]]; then
  head -c 7 "$STACKMA_CURL_PAYLOAD" > "$output"
  touch "$STACKMA_CURL_TRACE.ready"
  while [[ ! -e $STACKMA_CURL_TRACE.resume ]]; do sleep 0.01; done
fi
cp -- "$STACKMA_CURL_PAYLOAD" "$output"
`);
  await chmod(curl, 0o700);
  return {
    directory, payload, trace,
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      STACKMA_CURL_TRACE: trace,
      STACKMA_CURL_PAYLOAD: payload,
      STACKMA_CURL_MODE: "",
    },
  };
}

async function run(script, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn("bash", [script, ...args], {
      env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    let stderr = "";
    child.stdout.resume();
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code, signal, stderr }));
  });
}

async function mockRunnerPlatform(directory) {
  // These installer fault tests emulate the selected Linux x64 runner without
  // making the ordinary unit suite fail on the supported Linux ARM dev shell.
  const uname = join(directory, "uname");
  await writeFile(uname, `#!/usr/bin/env bash
case $1 in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) exit 1 ;;
esac
`);
  await chmod(uname, 0o700);
}

for (const algorithm of ["sha256", "sha512"]) {
  test(`verified ${algorithm} download replaces a destination only with matching bytes`, async t => {
    const data = await fixture(t);
    const destination = join(data.directory, "archive with spaces");
    await writeFile(destination, "previous accepted archive");
    const result = await run(downloader,
      [algorithm, "https://example.invalid/archive", digest(algorithm), destination], data.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(destination), body);
    assert(!(await readdir(data.directory)).some(name => name.startsWith(".stackma-download.")));
  });
}

test("readers retain the accepted archive throughout a successful replacement download", async t => {
  const data = await fixture(t);
  const destination = join(data.directory, "accepted");
  await writeFile(destination, "accepted bytes");
  const pending = run(downloader,
    ["sha256", "https://example.invalid/archive", digest("sha256"), destination],
    { ...data.env, STACKMA_CURL_MODE: "paused" });
  try {
    const deadline = Date.now() + 3_000;
    while (!(await readdir(data.directory)).includes("curl-args.ready")) {
      assert(Date.now() < deadline, "download must reach the partial-write fixture");
      await delay(10);
    }
    assert.equal(await readFile(destination, "utf8"), "accepted bytes");
  } finally {
    await writeFile(`${data.trace}.resume`, "");
  }
  const result = await pending;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readFile(destination), body);
});

test("a wrong digest preserves the existing destination and removes untrusted bytes", async t => {
  const data = await fixture(t);
  const destination = join(data.directory, "accepted");
  await writeFile(destination, "accepted bytes");
  const result = await run(downloader,
    ["sha256", "https://example.invalid/archive", "0".repeat(64), destination], data.env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /mismatch/);
  assert.equal(await readFile(destination, "utf8"), "accepted bytes");
  assert(!(await readdir(data.directory)).some(name => name.startsWith(".stackma-download.")));
});

test("a truncated failed transfer never replaces an accepted destination", async t => {
  const data = await fixture(t);
  const destination = join(data.directory, "accepted");
  await writeFile(destination, "accepted bytes");
  const result = await run(downloader,
    ["sha256", "https://example.invalid/archive", digest("sha256"), destination],
    { ...data.env, STACKMA_CURL_MODE: "truncated" });
  assert.equal(result.code, 18, result.stderr);
  assert.equal(await readFile(destination, "utf8"), "accepted bytes");
  assert(!(await readdir(data.directory)).some(name => name.startsWith(".stackma-download.")));
});

test("invalid algorithms, malformed digests and non-HTTPS URLs fail before transfer", async t => {
  const data = await fixture(t);
  for (const [algorithm, url, hash] of [
    ["md5", "https://example.invalid/archive", "0".repeat(32)],
    ["sha256", "https://example.invalid/archive", "0".repeat(63)],
    ["sha512", "https://example.invalid/archive", "z".repeat(128)],
    ["sha256", "http://example.invalid/archive", digest("sha256")],
    ["sha256", "file:///etc/passwd", digest("sha256")],
  ]) {
    const result = await run(downloader, [algorithm, url, hash, join(data.directory, "output")], data.env);
    assert.notEqual(result.code, 0);
    assert(!(await readdir(data.directory)).includes("curl-args"));
    assert(!(await readdir(data.directory)).includes("output"));
  }
});

test("curl ignores local configuration, restricts protocols, and bounds attempts", async t => {
  const data = await fixture(t);
  const url = "https://[2001:db8::1]/archive?part=1&format=xz";
  const result = await run(downloader,
    ["sha256", url, digest("sha256"), join(data.directory, "output")], data.env);
  assert.equal(result.code, 0, result.stderr);
  const args = (await readFile(data.trace, "utf8")).split("\0").slice(0, -1);
  assert.equal(args[0], "--disable");
  assert(args.includes("--globoff"), "one URL must not expand into several transfers");
  for (const flag of ["--proto", "--proto-redir"]) assert.equal(args[args.indexOf(flag) + 1], "=https");
  for (const flag of ["--max-redirs", "--connect-timeout", "--max-time", "--retry", "--retry-max-time"]) {
    assert(args.includes(flag), flag);
    assert(Number(args[args.indexOf(flag) + 1]) > 0, flag);
  }
  assert.deepEqual(args.slice(-2), ["--", url]);
});

test("Firefox installer never extracts an archive that fails verification", async t => {
  const data = await fixture(t);
  await mockRunnerPlatform(data.directory);
  const extractionTrace = join(data.directory, "extracted");
  const tar = join(data.directory, "tar");
  await writeFile(tar, '#!/usr/bin/env bash\nprintf attempted > "$STACKMA_EXTRACT_TRACE"\n');
  await chmod(tar, 0o700);
  const envFile = join(data.directory, "github-env");
  await writeFile(envFile, "");
  const result = await run(firefoxInstaller, [], {
    ...data.env,
    RUNNER_TEMP: data.directory,
    GITHUB_ENV: envFile,
    STACKMA_EXTRACT_TRACE: extractionTrace,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /mismatch/);
  const files = await readdir(data.directory);
  assert(!files.includes("extracted"));
  assert(!files.some(name => name.startsWith("stackma-firefox")));
  assert.equal(await readFile(envFile, "utf8"), "");
});

test("Nix installer refuses an existing installation before downloading or exporting paths", async t => {
  const data = await fixture(t);
  await mockRunnerPlatform(data.directory);
  const nix = join(data.directory, "nix");
  await writeFile(nix, '#!/usr/bin/env bash\nexit 99\n');
  await chmod(nix, 0o700);
  const envFile = join(data.directory, "github-env");
  const pathFile = join(data.directory, "github-path");
  await writeFile(envFile, "");
  await writeFile(pathFile, "");
  const result = await run(nixInstaller, [], {
    ...data.env,
    RUNNER_TEMP: data.directory,
    GITHUB_ENV: envFile,
    GITHUB_PATH: pathFile,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing Nix installation.*refusing to replace/);
  assert(!(await readdir(data.directory)).includes("curl-args"));
  assert.equal(await readFile(envFile, "utf8"), "");
  assert.equal(await readFile(pathFile, "utf8"), "");
});
