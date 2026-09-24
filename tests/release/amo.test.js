import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { ApiError, ReleaseClient, signRelease } from "../../scripts/release/amo.js";
import { sha256 } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";
import { archive } from "./fixtures.js";

async function fixture(t, overrides = {}) {
  const directory = await temporary(t), unsigned = Buffer.from("tested XPI"), source = Buffer.from("reviewable source"), signed = Buffer.from("Mozilla signed XPI");
  await writeFile(`${directory}/unsigned.xpi`, unsigned); await writeFile(`${directory}/source.zip`, source);
  const licenseText=overrides.licenseText ?? "WTFPL original work; CMU retains its terms";
  await writeFile(`${directory}/license.txt`,licenseText);
  const context = { id: "stackma@extensions.local", version: "1.1.1", channel: "listed", unsigned: { sha256: sha256(unsigned) }, source: { sha256: sha256(source) }, license:{name:"WTFPL; CMU",sha256:sha256(licenseText)} };
  const events = [];
  const state = { existing: true, public: true, source: true, addonPublic: true, ...overrides };
  const detail = () => ({ id: 42, version: context.version, channel: state.channel ?? "listed", is_disabled: state.disabled ?? false,
    license: {text:{"en-US":state.wrongLicense?"other":state.apiLicense ?? licenseText}},
    source: state.source ? "https://addons.mozilla.org/source/42" : null,
    file: { status: state.public ? "public" : "unreviewed", hash: `sha256:${sha256(signed)}`, size: signed.length, url: "https://addons.mozilla.org/file/42" } });
  const client = {
    signal: AbortSignal.timeout(2000), pollMs: 1,
    async fetchJson(url) {
      if (url.pathname.endsWith("site/")) return { read_only: state.readOnly ?? false };
      return { guid: context.id, slug: "stackma", status: state.addonPublic ? "public" : "nominated", is_disabled: state.addonDisabled ?? false };
    },
    async version() { events.push("get-version"); return state.existing ? detail() : null; },
    async doUploadSubmit(path, channel) { events.push("upload"); assert.equal(channel, "listed"); assert.deepEqual(await readFile(path), unsigned); return "upload-uuid"; },
    async doNewAddonOrVersionSubmit(_id,_uuid,metadata) { events.push("create"); assert.equal(metadata.version.custom_license.text["en-US"],licenseText); state.existing = true; },
    async download(url) { events.push("download"); return url.includes("source") ? (state.wrongSource ? Buffer.from("conflict") : source) : signed; },
    fileFromSync(path) { return { path }; },
    async doFormDataPatch() { events.push("patch-source"); state.source = true; },
  };
  const options = { client, context, directory, output: `${directory}/signed.xpi`, verify: async () => { events.push("verify-payload"); if(state.wrongPayload) throw new Error("payload conflict"); }, report: () => {} };
  return { options, client, context, events, state, detail };
}

test("existing approved listed version resumes without upload or write", async t => {
  const f = await fixture(t); const result = await signRelease(f.options);
  assert.equal(result.versionId, 42);
  assert(!f.events.includes("upload") && !f.events.includes("create") && !f.events.includes("patch-source"));
});

test("an existing version with AMO-rendered license resumes and attaches only its missing source", async t => {
  const raw = "Copyright <pie@quince.org>\nThe original terms remain unchanged.";
  const apiLicense = 'Copyright &lt;<a href="/" rel="nofollow">pie@quince.org</a>&gt;\nThe original terms remain unchanged.';
  const f = await fixture(t, { licenseText: raw, apiLicense, source: false });
  const result = await signRelease(f.options);
  assert.equal(result.versionId, 42);
  assert.equal(result.license.sha256, sha256(raw));
  assert.equal(result.license.apiSha256, sha256(apiLicense));
  assert(!f.events.includes("upload") && !f.events.includes("create"));
  assert.equal(f.events.filter(event => event === "patch-source").length, 1);
  assert(f.events.indexOf("verify-payload") < f.events.indexOf("patch-source"));
  f.state.apiLicense = apiLicense.replace("original terms", "different terms");
  await assert.rejects(() => signRelease(f.options), /license differs/u);
  assert.equal(f.events.filter(event => event === "patch-source").length, 1);
});

test("new version submits exactly the tested XPI and verifies before attaching source", async t => {
  const f = await fixture(t, { existing: false, source: false });
  await signRelease(f.options);
  assert.equal(f.events.filter(e => e === "create").length, 1);
  assert(f.events.indexOf("verify-payload") < f.events.indexOf("patch-source"));
  assert(f.events.filter(e => e === "get-version").length >= 4);
});

test("lost create response preserves remote version; retry resumes rather than duplicates", async t => {
  const f = await fixture(t, { existing: false });
  f.client.doNewAddonOrVersionSubmit = async () => { f.events.push("create"); f.state.existing = true; throw new Error("lost response"); };
  await assert.rejects(() => signRelease(f.options), /lost response/u);
  await signRelease(f.options);
  assert.equal(f.events.filter(e => e === "create").length, 1);
});

for (const [name, state] of Object.entries({ "read-only service": {readOnly:true}, "wrong channel": {channel:"unlisted"}, "disabled version": {disabled:true}, "different payload": {wrongPayload:true,source:false}, "conflicting source": {wrongSource:true}, "disabled listing": {addonDisabled:true,source:false}, "conflicting license": {wrongLicense:true} })) {
  test(`${name} cannot succeed or replace source`, async t => {
    const f = await fixture(t,state);
    await assert.rejects(() => signRelease(f.options));
    assert(!f.events.includes("create") && !f.events.includes("patch-source"));
  });
}

test("approval waits for both the version and listing, then resumes within the deadline", async t => {
  const f = await fixture(t, { public:false,addonPublic:false });
  let polls=0;
  f.client.version=async()=>{ if(++polls === 2) f.state.public=true; if(polls===3) f.state.addonPublic=true; return f.detail(); };
  await signRelease(f.options);
  assert.equal(polls,3);
  assert.equal(f.events.filter(e=>e==="verify-payload").length,1,"unchanged payload is checked once");
  assert.equal(f.events.filter(e=>e==="download").length,3,"one payload, one initial source and one final source read");
});

test("a moved tag blocks every kind of Mozilla mutation",async t=>{
  for(const state of [{existing:false},{source:false}]) {
    const f=await fixture(t,state);
    await assert.rejects(()=>signRelease({...f.options,beforeWrite:async()=>{throw new Error("tag moved");}}),/tag moved/u);
    assert(!f.events.some(e=>["upload","create","patch-source"].includes(e)));
  }
});

test("source PATCH errors are status-only and do not echo private response bodies",async()=>{
  const client=new ReleaseClient({apiKey:"test",apiSecret:"test",fetchImpl:async()=>new Response('private',{status:403})});
  await assert.rejects(()=>client.doFormDataPatch({source:new File(["test"],"source.zip")},"stackma@extensions.local",42),e=>e instanceof ApiError && !e.message.includes("private"));
});

test("review timeout stops without publishing or resubmitting", async t => {
  const f = await fixture(t, {public:false}); f.client.signal=AbortSignal.timeout(20);
  await assert.rejects(() => signRelease(f.options));
  assert(!f.events.includes("upload") && !f.events.includes("create"));
});

test("only an authenticated version 404 permits creation", async () => {
  for(const status of [401,403,404,409,429,500]) {
    const client=new ReleaseClient({apiKey:"test",apiSecret:"test",fetchImpl:async()=>new Response("private error",{status})});
    if(status===404) assert.equal(await client.version("stackma@extensions.local","1.1.1"),null);
    else await assert.rejects(()=>client.version("stackma@extensions.local","1.1.1"),error=>error instanceof ApiError && error.status===status && !error.message.includes("private error"));
  }
});

test("JWT is confined to AMO; API redirects, HTTP and unknown download hosts are rejected", async () => {
  const calls=[];
  const client=new ReleaseClient({apiKey:"issuer",apiSecret:"secret",fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    if(url.hostname==="addons.mozilla.org") return new Response(null,{status:302,headers:{location:"https://addons.mozilla.net/signed.xpi"}});
    return new Response("bytes");
  }});
  assert.equal((await client.download("https://addons.mozilla.org/file/1")).toString(),"bytes");
  assert.match(calls[0].options.headers.Authorization,/^JWT /u);
  assert.deepEqual(calls[1].options.headers,{});
  for(const url of ["http://addons.mozilla.org/file", "https://evil.invalid/file", "https://user@addons.mozilla.org/file"]) await assert.rejects(()=>client.download(url));
  assert.throws(()=>client.nodeFetch(new URL("https://evil.invalid/api/v5/"),{}));
  calls.length=0;
  await assert.rejects(()=>client.fetchJson(new URL("https://addons.mozilla.org/api/v5/site/")),ApiError);
  assert.equal(calls[0].options.redirect,"error");
});

test("transport enforces response size and polling cancellation", async () => {
  const client=new ReleaseClient({apiKey:"test",apiSecret:"test",timeoutMs:20,pollMs:1,fetchImpl:async()=>Response.json({processed:false})});
  await assert.rejects(()=>client.readBytes(new Response("too large"),3),/size limit/u);
  await assert.rejects(()=>client.waitRetry(()=>false,new URL("https://addons.mozilla.org/api/v5/addons/upload/test/"),1,1000));
});

test("a signing hash transition refreshes metadata and retries reads only",async t=>{
  const f=await fixture(t);let reads=0;const download=f.client.download;
  f.client.download=async url=>{if(url.includes("file")&&++reads===1)return Buffer.from("archive replaced during signing");return download(url);};
  await signRelease(f.options);
  assert.equal(reads,2);assert(!f.events.some(e=>["upload","create","patch-source"].includes(e)));
});

test("another source attachment observed before PATCH is checked rather than replaced",async t=>{
  const f=await fixture(t,{source:false});let reads=0;
  f.client.version=async()=>{if(++reads===2) f.state.source=true;return f.detail();};
  await signRelease(f.options);
  assert(!f.events.includes("patch-source"));
});

test("a Mozilla-disabled file observed just before attachment cannot be mutated",async t=>{
  const f=await fixture(t,{source:false});let reads=0;
  f.client.version=async()=>{const v=f.detail();if(++reads===2)v.file.status="disabled";return v;};
  await assert.rejects(()=>signRelease(f.options),/disabled/u);
  assert(!f.events.includes("patch-source"));
});

test("maintained client constructs the current upload, custom-license PUT and source PATCH protocol",async t=>{
  const directory=await temporary(t),license="Project terms; CMU terms",source=Buffer.from("source archive fixture");
  const entries=[["manifest.json",'{"version":"1.1.1"}'],["background.js","code"]];
  await archive(`${directory}/unsigned.xpi`,entries);
  await archive(`${directory}/server-signed.xpi`,[...entries,["META-INF/cose.sig","signature fixture"]]);
  const unsigned=await readFile(`${directory}/unsigned.xpi`),signed=await readFile(`${directory}/server-signed.xpi`);
  await writeFile(`${directory}/source.zip`,source);await writeFile(`${directory}/license.txt`,license);
  const context={id:"stackma@extensions.local",version:"1.1.1",channel:"listed",unsigned:{sha256:sha256(unsigned)},source:{sha256:sha256(source)},license:{name:"Project terms",sha256:sha256(license)}};
  let created=false,attached=false;const writes=[];
  const addon={guid:context.id,slug:"stackma",status:"public",is_disabled:false};
  const detail=()=>({id:42,version:context.version,channel:"listed",is_disabled:false,license:{text:{"en-US":license}},source:attached?"https://addons.mozilla.org/download/source/42":null,
    file:{status:attached?"public":"unreviewed",size:(attached?signed:unsigned).length,hash:`sha256:${sha256(attached?signed:unsigned)}`,url:"https://addons.mozilla.org/download/file/42"}});
  const client=new ReleaseClient({apiKey:"fixture-issuer",apiSecret:"fixture-secret",timeoutMs:3000,pollMs:1,fetchImpl:async(url,options)=>{
    const path=decodeURIComponent(new URL(url).pathname),method=options.method??"GET";
    assert.match(options.headers.Authorization,/^JWT /u);
    if(path==="/api/v5/site/")return Response.json({read_only:false});
    if(path.endsWith("/addon/stackma@extensions.local/")&&method==="GET")return Response.json(addon);
    if(path.endsWith("/versions/v1.1.1/"))return created?Response.json(detail()):Response.json({detail:"absent"},{status:404});
    if(path.endsWith("/upload/")&&method==="POST"){
      writes.push("upload");assert.equal(options.body.get("channel"),"listed");
      assert.deepEqual(Buffer.from(await options.body.get("upload").arrayBuffer()),unsigned);return Response.json({uuid:"fixture-upload"});
    }
    if(path.endsWith("/upload/fixture-upload/"))return Response.json({processed:true,valid:true,uuid:"fixture-upload"});
    if(method==="PUT"){
      writes.push("create");const metadata=JSON.parse(options.body);assert.equal(metadata.version.upload,"fixture-upload");
      assert.equal(metadata.version.custom_license.text["en-US"],license);created=true;return Response.json({version:{id:42}});
    }
    if(method==="PATCH"){
      writes.push("source");assert(path.endsWith("/versions/42/"));assert.deepEqual(Buffer.from(await options.body.get("source").arrayBuffer()),source);attached=true;return Response.json(detail());
    }
    if(path.includes("/download/source/"))return new Response(source);
    if(path.includes("/download/file/"))return new Response(attached?signed:unsigned);
    assert.fail(`Unexpected protocol request ${method} ${path}`);
  }});
  const result=await signRelease({client,context,directory,output:`${directory}/result.xpi`});
  assert.deepEqual(writes,["upload","create","source"]);assert.equal(result.signed.sha256,sha256(signed));
});
