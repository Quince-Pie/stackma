import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";

export async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), "stackma-release-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

// Independent ZIP fixture writer: stored members, including deliberate duplicate
// and unsafe names that normal ZIP creation tools would sanitize or replace.
export async function archive(path, entries, { utf8 = false } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename), bytes = Buffer.from(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(utf8 ? 0x800 : 0, 6);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(utf8 ? 0x800 : 0, 8);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(directory, name);
    offset += header.length + name.length + bytes.length;
  }
  const listing = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(listing.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(path, Buffer.concat([...local, listing, end]));
}
