import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { GitHub, publishRelease } from "./github.js";

const directory = "artifacts/release-signed";
const record = JSON.parse(await readFile(`${directory}/release.json`, "utf8"));
assert.equal(record.tag, process.env.RELEASE_TAG);
assert.equal(record.commit, process.env.RELEASE_COMMIT);
const result = await publishRelease({
  github: new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
  record, directory, notesPath: "artifacts/release-notes.md",
});
await writeFile("artifacts/release-publication.json", JSON.stringify(result, null, 2) + "\n");
console.log(`Verified immutable release: ${result.url}`);
