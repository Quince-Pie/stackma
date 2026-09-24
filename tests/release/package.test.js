import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateMetadata, versionFromTag } from "../../scripts/release/package.js";
import { readPayload, signatureFiles, verifyPayload } from "../../scripts/release/archive.js";
import { verifyQueuePolicy } from "../../scripts/ci/check-workflows.js";
import { archive, temporary } from "./fixtures.js";

test("Firefox stable tags have bounded canonical numeric components", () => {
  for (const tag of ["v0.0.0", "v1.1.1", "v65535.65535.65535"]) assert.equal(versionFromTag(tag), tag.slice(1));
  for (const tag of ["v01.1.1", "v1.2", "v1.2.3-beta", "v65536.0.0", "v1.1.1\n", "--help", "v1.0.0;false", "v999999999999999999999.0.0"]) {
    assert.throws(() => versionFromTag(tag));
  }
});

test("every declared version and the stable add-on identity must agree", () => {
  const manifest = { version: "1.1.1", browser_specific_settings: { gecko: { id: "stackma@extensions.local", strict_min_version: "156.0" } } };
  const pkg = { version: "1.1.1" }, lock = { ...pkg, packages: { "": pkg } };
  assert.equal(validateMetadata("v1.1.1", manifest, pkg, lock).version, "1.1.1");
  assert.throws(() => validateMetadata("v1.1.2", manifest, pkg, lock));
  assert.throws(() => validateMetadata("v1.1.1", manifest, pkg, { ...lock, version: "1.1.0" }));
  assert.throws(() => validateMetadata("v1.1.1", { ...manifest, browser_specific_settings: { gecko: { id: "other", strict_min_version: "156.0" } } }, pkg, lock));
});

test("signed payload accepts only exact original bytes plus known signature files", async t => {
  const dir = await temporary(t), unsigned = `${dir}/unsigned.xpi`, signed = `${dir}/signed.xpi`;
  const original = [["manifest.json", '{"version":"1.1.1"}'], ["background.js", "original"]];
  await archive(unsigned, original);
  await archive(signed, [...original.toReversed(), ...[...signatureFiles].map(name => [name, "signature fixture"])]);
  await verifyPayload(unsigned, signed);
  for (const added of [[["extra.js", "code"]], [["META-INF/extra.js", "code"]], [["../escape", "code"]], [["background.js", "duplicate"]], [["META-INF/cose.sig", "one"], ["META-INF/cose.sig", "two"]]]) {
    await archive(signed, [...original, ...added]);
    await assert.rejects(() => verifyPayload(unsigned, signed));
  }
  await archive(signed, [["manifest.json", original[0][1]], ["background.js", "changed"]]);
  await assert.rejects(() => verifyPayload(unsigned, signed), /differs/u);
  await archive(signed, original.slice(0, 1));
  await assert.rejects(() => verifyPayload(unsigned, signed), /differs/u);
});

test("CRC errors and malformed archives fail before publication", async t => {
  const dir = await temporary(t), path = `${dir}/bad.xpi`;
  await archive(path, [["file.js", "abc"]]);
  const data = await readFile(path); data[37] ^= 1;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, data);
  await assert.rejects(() => readPayload(path));
});

test("ZIP local-name aliases and whitespace are rejected", async t => {
  const dir=await temporary(t),path=`${dir}/alias.xpi`;
  await archive(path,[["file.js","abc"]]);
  const bytes=await readFile(path);bytes[30]="x".charCodeAt(0);
  const {writeFile}=await import("node:fs/promises");
  await writeFile(path,bytes);
  await assert.rejects(()=>readPayload(path),/filenames differ/u);
  await archive(path,[["file.js\n","abc"]],{utf8:true});
  await assert.rejects(()=>readPayload(path),/Unexpected ZIP member|Whitespace/u);
});

test("archive cancellation and repeated failures release open descriptors", async t => {
  const dir=await temporary(t),path=`${dir}/archive.xpi`;
  await archive(path,[["file.js","abc"]]);
  await assert.rejects(()=>readPayload(path,{signal:AbortSignal.abort(new Error("cancelled"))}),/cancelled/u);
  const {readdir}=await import("node:fs/promises");
  // This target runs in the Linux development/CI environment.
  const before=(await readdir("/proc/self/fd")).length;
  await archive(path,[["file.js","one"],["file.js","two"]]);
  for(let i=0;i<25;i++) await assert.rejects(()=>readPayload(path),/Duplicate/u);
  assert.equal((await readdir("/proc/self/fd")).length,before);
});

test("queue bridge rejects malformed or cancellation-changing policies that actionlint cannot parse", async () => {
  const workflow = await readFile(".github/workflows/release.yml", "utf8");
  verifyQueuePolicy(workflow);
  for (const bad of [workflow.replace("queue: max", "queue: invalid"), workflow.replace("cancel-in-progress: false", "cancel-in-progress: true"), `${workflow}\nother:\n  queue: max\n`]) {
    assert.throws(() => verifyQueuePolicy(bad));
  }
});
