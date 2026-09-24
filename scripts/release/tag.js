import { ensureTag, RepositoryGitHub } from "./repository.js";

await ensureTag(new RepositoryGitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN),
  process.env.RELEASE_TAG, process.env.RELEASE_COMMIT, { create: process.env.CREATE_TAG === "true" });
console.log(`Verified release tag ${process.env.RELEASE_TAG} at ${process.env.RELEASE_COMMIT}`);
