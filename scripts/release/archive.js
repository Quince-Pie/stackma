import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { addAbortSignal } from "node:stream";
import { crc32 } from "node:zlib";
import { openPromise } from "yauzl";

export const signatureFiles = new Set([
  "META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa",
  "META-INF/cose.manifest", "META-INF/cose.sig",
]);

// Stream one member at a time; never extract paths to disk or buffer an entire
// expanded file. CRC, size, raw/local/central names and SHA-256 are independent
// checks. The payload is intentionally flat, as is the shipped extension.
export async function readPayload(path, { signed = false, expected, signal } = {}) {
  const deadline = AbortSignal.timeout(30_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const zip = await openPromise(resolve(path), { autoClose: false, strictFileNames: true, validateEntrySizes: true });
  const closed = new Promise((resolveClose, reject) => {
    zip.once("close", resolveClose);
    zip.on("error", reject);
  });
  // A parsing error can arrive before finally awaits descriptor closure.
  closed.catch(() => {});
  const payload = new Map();
  const seen = new Set();
  try {
    if (expected) assert(zip.entryCount <= expected.size + signatureFiles.size + 1, "Unexpected ZIP members");
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      const name = entry.fileName;
      assert(!seen.has(name), "Duplicate ZIP members");
      seen.add(name);
      assert.deepEqual(entry.fileNameRaw, Buffer.from(name, "utf8"), "Ambiguous ZIP filename encoding");
      const local = await zip.readLocalFileHeaderPromise(entry);
      assert.deepEqual(local.fileName, entry.fileNameRaw, "Local and central ZIP filenames differ");
      assert.equal(local.compressionMethod, entry.compressionMethod, "ZIP compression headers differ");
      assert.equal(local.generalPurposeBitFlag, entry.generalPurposeBitFlag, "ZIP flags differ");
      if (signed && (signatureFiles.has(name) || name === "META-INF/")) continue;
      assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, `Unexpected ZIP member: ${JSON.stringify(name)}`);
      assert.equal(name.trim(), name, "Whitespace in ZIP filename");
      if (expected) assert(expected.has(name), `Unexpected ZIP member: ${JSON.stringify(name)}`);
      const limit = expected?.get(name)?.bytes ?? entry.uncompressedSize;
      assert(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 && entry.uncompressedSize <= limit, "ZIP member size exceeds the expected limit");
      const stream = addAbortSignal(signal, await zip.openReadStreamPromise(entry));
      const hash = createHash("sha256");
      let bytes = 0, crc = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        assert(bytes <= limit, "Expanded ZIP member exceeds the expected limit");
        hash.update(chunk); crc = crc32(chunk, crc);
      }
      assert.equal(bytes, entry.uncompressedSize, "ZIP size mismatch");
      assert.equal(crc, entry.crc32, "ZIP CRC mismatch");
      payload.set(name, { sha256: hash.digest("hex"), bytes });
    }
    return payload;
  } finally {
    zip.close();
    await closed;
  }
}

export async function verifyPayload(unsigned, signed, { signal } = {}) {
  const expected = await readPayload(unsigned, { signal });
  assert.deepEqual(await readPayload(signed, { signed: true, expected, signal }), expected, "Mozilla payload differs from the tested XPI");
}
