import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ReleaseClient, signRelease } from "./amo.js";
import { versionFromTag } from "./package.js";
import { GitHub } from "./github.js";

const directory = "artifacts/release-input";
const context = JSON.parse(await readFile(`${directory}/context.json`, "utf8"));
assert.equal(context.tag, process.env.RELEASE_TAG);
assert.equal(context.commit, process.env.RELEASE_COMMIT);
assert.equal(context.version, versionFromTag(context.tag));
assert.equal(context.id, "stackma@extensions.local");
assert.equal(context.channel, "listed");
const apiKey = process.env.AMO_JWT_ISSUER;
const apiSecret = process.env.AMO_JWT_SECRET;
assert(apiKey && apiSecret, "Configure AMO_JWT_ISSUER and AMO_JWT_SECRET in the release-signing environment");
await mkdir("artifacts/release-signed", { recursive: true });
const output = `artifacts/release-signed/stackma-${context.version}.xpi`;
const github = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
const result = await signRelease({
  client: new ReleaseClient({ apiKey, apiSecret }), context, directory, output,
  report: state => console.log(JSON.stringify(state)),
  beforeWrite: async () => assert.equal(await github.commit(context.tag), context.commit, "Remote tag moved before Mozilla submission"),
});
await writeFile("artifacts/release-signed/signing.json", JSON.stringify({ ...context, ...result }, null, 2) + "\n");
