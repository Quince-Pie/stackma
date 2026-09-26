import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { browserUpdate, parseArguments, runAcceptance } from "../../scripts/release/update-test.js";
import { temporary } from "./fixtures.js";

const bytes = Buffer.from("signed archive callback fixture, not an actual Mozilla package");
const digest = createHash("sha256").update(bytes).digest("hex");
const args = ["--from-xpi=old.xpi", "--from-version=1.1.4", "--to-version=1.1.5", `--to-sha256=${digest}`, "--output=report.json"];

test("live acceptance arguments require exact versions, digest, paths and a newer target", () => {
  const parsed = parseArguments(args);
  assert.equal(parsed.fromXpi, resolve("old.xpi")); assert.equal(parsed.toSha256, digest);
  for (const input of [args.slice(1), [...args, "--from-version=1.1.3"], [...args, "--allow-unsigned=true"],
    args.map(arg => arg.replace("to-version=1.1.5", "to-version=1.1.4")),
    args.map(arg => arg.replace("from-version=1.1.4", "from-version=01.1.4")),
    args.map(arg => arg.startsWith("--to-sha256=") ? "--to-sha256=abc" : arg),
    args.map(arg => arg === "--output=report.json" ? "--output=old.xpi" : arg)]) assert.throws(() => parseArguments(input));
});

function world({ noUpdate = false, checkError = 0, wrongVersion = false, badSignature = false, wrongHash = false,
  downloadFailure = false, installFailure = false, hang = false, customUrl = false, overriddenEndpoint = false } = {}) {
  const calls = [], listeners = new Set();
  const current = { id: "stackma@extensions.local", version: "1.1.4", signedState: 2,
    temporarilyInstalled: false, isActive: true, updateURL: customUrl ? "https://example.invalid/updates" : null,
    cancelUpdate() { calls.push("cancel-update"); },
    findUpdates(listener, reason) {
      calls.push(["find-updates", reason]);
      if (hang) return;
      if (!noUpdate) listener.onUpdateAvailable(current, install);
      listener.onUpdateFinished(current, checkError);
    } };
  const install = { version: wrongVersion ? "1.1.6" : "1.1.5", existingAddon: current, state: 0, error: 0,
    addon: { id: current.id, version: "1.1.5", signedState: badSignature ? -1 : 2 },
    sourceURI: { spec: "https://addons.mozilla.org/firefox/downloads/file/42/stackma.xpi" }, file: { path: "/disposable/download.xpi" },
    addListener(listener) { listeners.add(listener); }, removeListener(listener) { listeners.delete(listener); },
    cancel() { calls.push("cancel-install"); },
    install() {
      if (this.state === 0) {
        calls.push("download");
        if (downloadFailure) { this.error = -1; for (const listener of listeners) listener.onDownloadFailed(this); return Promise.resolve(); }
        this.state = 3;
        for (const listener of listeners) assert.equal(listener.onDownloadEnded(this), false, "real updater must pause before installation");
      } else {
        calls.push("install");
        assert(calls.includes("hash-read"), "installation must follow independent downloaded-byte hashing");
        if (installFailure) { this.error = -2; for (const listener of listeners) listener.onInstallFailed(this); }
        else { current.version = "1.1.5"; for (const listener of listeners) listener.onInstallEnded(this, current); }
      }
      return Promise.resolve();
    } };
  const defaultEndpoint = "https://versioncheck.addons.mozilla.org/update/VersionCheck.php?id=%ITEM_ID%";
  const AddonManager = { SIGNEDSTATE_SIGNED: 2, STATE_AVAILABLE: 0, STATE_DOWNLOADED: 3, UPDATE_STATUS_NO_ERROR: 0, UPDATE_WHEN_USER_REQUESTED: 1,
    async getAddonByID() { return current; } };
  const globals = { URL, Uint8Array, setTimeout, clearTimeout, crypto: webcrypto,
    ChromeUtils: { importESModule() { return { AddonManager }; } },
    Services: { prefs: { getBoolPref() { return true; }, getStringPref() { return overriddenEndpoint ? "https://other.invalid" : defaultEndpoint; },
      getDefaultBranch() { return { getStringPref() { return defaultEndpoint; } }; } } },
    IOUtils: { async stat() { return { type: "regular", size: bytes.length }; }, async read() { calls.push("hash-read"); return bytes; } } };
  const execute = vm.runInNewContext(`(${browserUpdate.toString()})`, globals);
  return { calls, listeners, current, run: () => execute({ id: current.id, fromVersion: "1.1.4", toVersion: "1.1.5",
    toSha256: wrongHash ? "0".repeat(64) : digest, timeoutMs: hang ? 25 : 1000 }) };
}

test("callback oracle pauses, hashes and then installs; this is not live acceptance", async () => {
  const f = world(), result = await f.run();
  assert.equal(result.sha256, digest); assert.equal(result.toVersion, "1.1.5");
  assert.deepEqual(f.calls, [["find-updates", 1], "download", "hash-read", "install"]);
  assert.equal(f.listeners.size, 0);
});

test("preconditions and provider mismatches fail before installing an update", async () => {
  for (const options of [{ customUrl: true }, { overriddenEndpoint: true }, { noUpdate: true }, { checkError: -1 },
    { wrongVersion: true }, { badSignature: true }, { wrongHash: true }, { downloadFailure: true }]) {
    const f = world(options); await assert.rejects(f.run);
    assert(!f.calls.includes("install")); assert.equal(f.listeners.size, 0);
  }
});

test("installation failures and deadlines remove listeners and cancel browser work", async () => {
  for (const options of [{ installFailure: true }, { hang: true }]) {
    const f = world(options); await assert.rejects(f.run);
    assert(f.calls.includes("cancel-update")); assert.equal(f.listeners.size, 0);
    if (options.installFailure) assert(f.calls.includes("cancel-install"));
  }
});

test("missing local input records failure without starting Firefox or network", async t => {
  const directory = await temporary(t), output = `${directory}/report.json`;
  await assert.rejects(() => runAcceptance({ fromXpi: `${directory}/missing.xpi`, fromVersion: "1.1.4", toVersion: "1.1.5", toSha256: digest, output }), { code: "ENOENT" });
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(report.passed, false); assert(!report.delivery); assert.match(report.error, /ENOENT/u);
});
