import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { digestFile, run, sha256 } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";

async function fixture(t) {
  const directory=await temporary(t);
  for(const path of ["extension","scripts/release","naming-data","dist","artifacts/ci"]) await mkdir(`${directory}/${path}`,{recursive:true});
  for(const file of ["package.js","stage.js"]) await copyFile(resolve(`scripts/release/${file}`),`${directory}/scripts/release/${file}`);
  const version="1.1.1",pkg={type:"module",version,devDependencies:{"web-ext":"10.7.0"}};
  await writeFile(`${directory}/package.json`,JSON.stringify(pkg));
  await writeFile(`${directory}/package-lock.json`,JSON.stringify({version,packages:{"":{version}}}));
  await writeFile(`${directory}/extension/manifest.json`,JSON.stringify({version,browser_specific_settings:{gecko:{id:"stackma@extensions.local",strict_min_version:"156.0"}}}));
  await writeFile(`${directory}/LICENSE`,"Project license\n");await writeFile(`${directory}/naming-data/CMU-LICENSE.txt`,"CMU notice\n");
  await writeFile(`${directory}/.gitignore`,"artifacts/\ndist/\n.env\n");
  await writeFile(`${directory}/dist/stackma-${version}.xpi`,"verified test package");
  await writeFile(`${directory}/artifacts/ci/package.json`,JSON.stringify({passed:true,sha256:sha256("verified test package")}));
  const git=async(...args)=>(await run("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","-c","user.name=Stackma tests","-c","user.email=tests@example.invalid",...args],{cwd:directory,timeout:30000})).stdout.trim();
  await git("init","--quiet");await git("add","--all");await git("commit","--quiet","-m","test: Record release staging fixture");
  const execute=async(args=[],environment={})=>run(process.execPath,["scripts/release/stage.js",...args],{cwd:directory,timeout:30000,env:{...process.env,RELEASE_TAG:"v1.1.1",RELEASE_COMMIT:await git("rev-parse","HEAD"),...environment}});
  return{directory,git,execute};
}

test("staging binds the tested XPI and reproducible committed source without local credentials",async t=>{
  const f=await fixture(t);
  await writeFile(`${f.directory}/.env`,"JWT_SECRET=local-test-fixture\n");
  await f.execute(["--check"]);
  await f.execute([],{TZ:"America/Chicago"});
  const context=JSON.parse(await readFile(`${f.directory}/artifacts/release-input/context.json`,"utf8"));
  assert.equal(context.unsigned.sha256,sha256("verified test package"));
  const text=await readFile(`${f.directory}/artifacts/release-input/license.txt`,"utf8");
  assert.equal(text,text.trim());assert.match(text,/CMU notice/u);assert.equal(context.license.sha256,sha256(text));
  await f.execute([],{TZ:"Pacific/Auckland"});
  assert.deepEqual(await digestFile(`${f.directory}/artifacts/release-input/source.zip`),context.source);
  const {openPromise}=await import("yauzl");const zip=await openPromise(`${f.directory}/artifacts/release-input/source.zip`);
  const names=[];for await(const entry of zip.eachEntry()) names.push(entry.fileName);
  assert(!names.some(name=>name.includes(".env")||name.startsWith("artifacts/")||name.startsWith("dist/")));
});

test("untracked payload, mismatched versions and changed package bytes fail staging",async t=>{
  const f=await fixture(t);
  await assert.rejects(()=>f.execute(["--check"],{RELEASE_TAG:"v1.1.2"}),error=>error.stderr.includes("must agree"));
  await writeFile(`${f.directory}/dist/stackma-1.1.1.xpi`,"changed");
  await assert.rejects(()=>f.execute(),error=>error.stderr.includes("installed, tested XPI"));
  await writeFile(`${f.directory}/extension/untracked.js`,"extra");
  await assert.rejects(()=>f.execute(["--check"]),error=>error.stderr.includes("Every packaged file must be committed"));
});

test("a force-tracked environment file is rejected before changing accepted staging output",async t=>{
  const f=await fixture(t);await f.execute();
  const before=await digestFile(`${f.directory}/artifacts/release-input/source.zip`);
  await writeFile(`${f.directory}/.env`,"JWT_SECRET=fixture-only\n");await f.git("add","--force",".env");
  await f.git("commit","--quiet","-m","test: Add forbidden source archive input");
  await assert.rejects(()=>f.execute(),error=>error.stderr.includes("Environment files must not be committed"));
  assert.deepEqual(await digestFile(`${f.directory}/artifacts/release-input/source.zip`),before);
});
