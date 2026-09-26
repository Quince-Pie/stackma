import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { ApiError, JwtApiAuth, PendingReviewError, ReleaseClient, signRelease } from "../../scripts/release/amo.js";
import { sha256 } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";
import { archive } from "./fixtures.js";
import { requireResolvedPriorReleases, UnresolvedReleaseError } from "../../scripts/release/repository.js";

async function fixture(t, overrides = {}) {
  const directory = await temporary(t), unsigned = Buffer.from("tested XPI"), source = Buffer.from("reviewable source"), signed = Buffer.from("Mozilla signed XPI");
  await writeFile(`${directory}/unsigned.xpi`, unsigned); await writeFile(`${directory}/source.zip`, source);
  const licenseText=overrides.licenseText ?? "WTFPL original work; CMU retains its terms";
  await writeFile(`${directory}/license.txt`,licenseText);
  const context = { id: "stackma@extensions.local", version: "1.1.1", channel: overrides.contextChannel ?? "listed", unsigned: { sha256: sha256(unsigned) }, source: { sha256: sha256(source) }, license:{name:"WTFPL; CMU",sha256:sha256(licenseText)} };
  const events = [];
  const state = { existing: true, public: true, source: true, addonPublic: true, ...overrides };
  const detail = () => ({ id: 42, version: context.version, channel: state.channel ?? context.channel, is_disabled: state.disabled ?? false,
    license: state.nullLicense ? null : {text:{"en-US":state.wrongLicense?"other":state.apiLicense ?? licenseText}},
    source: state.source ? "https://addons.mozilla.org/source/42" : null,
    file: { status: state.public ? "public" : "unreviewed", hash: `sha256:${sha256(signed)}`, size: signed.length, url: "https://addons.mozilla.org/file/42" } });
  const client = {
    signal: AbortSignal.timeout(2000), pollMs: 1,
    async fetchJson(url) {
      if (url.pathname.endsWith("site/")) return { read_only: state.readOnly ?? false };
      return { guid: context.id, slug: "stackma", status: state.addonStatus ?? (state.addonPublic ? "public" : "nominated"), is_disabled: state.addonDisabled ?? false };
    },
    async version(_id, version = context.version) {
      events.push("get-version");
      if (version !== context.version) return { id: 41, version, channel: "listed", license: { text: { "en-US": state.predecessorLicense ?? licenseText } } };
      return state.existing ? detail() : null;
    },
    async listedVersions() { events.push("list-versions"); return typeof state.listed === "function" ? state.listed() : (state.listed ?? [listed("1.1.0", "public")]); },
    async doUploadSubmit(path, channel) { events.push("upload"); assert.equal(channel, context.channel); assert.deepEqual(await readFile(path), unsigned); return "upload-uuid"; },
    async doVersionSubmit(_id, _uuid, path) { events.push("create"); assert.deepEqual(await readFile(path), source); state.existing = true; state.source = true; },
    async download(url) { events.push("download"); return url.includes("source") ? (state.wrongSource ? Buffer.from("conflict") : source) : signed; },
    fileFromSync(path) { return { path }; },
    async doFormDataPatch() { events.push("patch-source"); state.source = true; },
    async attachLicense(_id, _version, name, text) { events.push("patch-license"); assert.equal(name, context.license.name); assert.equal(text, licenseText); state.nullLicense = false; },
  };
  const options = { client, context, directory, output: `${directory}/signed.xpi`, verify: async () => { events.push("verify-payload"); if(state.wrongPayload) throw new Error("payload conflict"); }, report: () => {} };
  return { options, client, context, events, state, detail };
}

test("existing approved listed version resumes without upload or write", async t => {
  const f = await fixture(t); const result = await signRelease(f.options);
  assert.equal(result.versionId, 42);
  assert.equal(result.state, "approved-and-signed");
  assert(!f.events.includes("upload") && !f.events.includes("create") && !f.events.includes("patch-source"));
});

test("unlisted creation preserves pending listed versions and attaches source before missing terms", async t => {
  const f = await fixture(t, { contextChannel: "unlisted", existing: false, nullLicense: true,
    addonStatus: "incomplete", listed: [listed("1.1.0")] });
  f.options.checkPriorReleases = () => { throw new Error("Listed admission does not govern the independent unlisted channel"); };
  assert.equal((await signRelease(f.options)).state, "approved-and-signed");
  assert(!f.events.includes("list-versions"));
  assert(f.events.indexOf("create") < f.events.indexOf("verify-payload"));
  assert(f.events.indexOf("verify-payload") < f.events.indexOf("patch-license"));
  assert.equal(f.events.filter(e => e === "patch-license").length, 1);
  assert(!f.events.includes("patch-source"));
});

test("unlisted license attachment resumes an ambiguous PATCH without replacing its terms", async t => {
  const f = await fixture(t, { contextChannel: "unlisted", nullLicense: true, addonPublic: false });
  const attach = f.client.attachLicense;
  f.client.attachLicense = async (...args) => { await attach(...args); throw new Error("lost license reply"); };
  await assert.rejects(() => signRelease(f.options), /lost license reply/u);
  assert.equal((await signRelease(f.options)).state, "approved-and-signed");
  assert.equal(f.events.filter(e => e === "patch-license").length, 1);
});

test("unlisted conflicts and explicit supersede never mutate metadata", async t => {
  for (const overrides of [{ wrongSource: true, nullLicense: true }, { wrongPayload: true, nullLicense: true },
    { wrongLicense: true }, { addonStatus: "rejected" }, { addonDisabled: true }, { disabled: true }]) {
    const f = await fixture(t, { contextChannel: "unlisted", ...overrides });
    await assert.rejects(() => signRelease(f.options));
    assert(!f.events.some(e => ["upload", "create", "patch-license", "patch-source"].includes(e)));
  }
  const f = await fixture(t, { contextChannel: "unlisted", existing: false });
  await assert.rejects(() => signRelease({ ...f.options, supersede: "1.1.0" }), /never authorizes superseding/u);
  assert(!f.events.includes("upload"));
});

test("unlisted pending state requires complete verified terms and source", async t => {
  const f = await fixture(t, { contextChannel: "unlisted", nullLicense: true, public: false, addonStatus: "incomplete" });
  assert.equal((await signRelease({ ...f.options, approvalWaitMs: 0 })).state, "awaiting-review");
  assert(f.events.includes("patch-license"));
  assert(!f.state.nullLicense);
});

test("missing unlisted license uses the documented translated custom-license PATCH", async () => {
  const requests = [];
  const client = new ReleaseClient({ apiKey: "fixture", apiSecret: "fixture", fetchImpl: async (url, options) => {
    requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) });
    return new Response("{}", { status: 200 });
  } });
  await client.attachLicense("stackma@extensions.local", 6, "WTFPL; CMU", "exact terms");
  assert.deepEqual(requests, [{ url: "https://addons.mozilla.org/api/v5/addons/addon/stackma%40extensions.local/versions/6/",
    method: "PATCH", body: { custom_license: { name: { "en-US": "WTFPL; CMU" }, text: { "en-US": "exact terms" } } } }]);
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

test("new version submits exactly the tested XPI with source in the version creation", async t => {
  const f = await fixture(t, { existing: false, source: false });
  await signRelease(f.options);
  assert.equal(f.events.filter(e => e === "create").length, 1);
  assert(f.events.includes("verify-payload"));
  assert(!f.events.includes("patch-source"));
  assert(f.events.filter(e => e === "get-version").length >= 4);
});

test("an enabled incomplete listing can submit with exact inherited terms, but still needs public listing approval", async t => {
  const f = await fixture(t, { existing: false, addonStatus: "incomplete", public: false, listed: [listed("1.1.0", "disabled")] });
  const result = await signRelease({ ...f.options, approvalWaitMs: 0 });
  assert.equal(result.state, "awaiting-review"); assert.equal(f.events.filter(e => e === "create").length, 1);
  f.state.public = true;
  assert.equal((await signRelease({ ...f.options, approvalWaitMs: 0 })).state, "awaiting-review", "An approved file alone does not authorize listed publication");
  f.state.addonStatus = "public";
  assert.equal((await signRelease(f.options)).state, "approved-and-signed");
});

test("new listed submissions still reject disabled, rejected and unknown listing states", async t => {
  for (const overrides of [{ addonDisabled: true }, ...["disabled", "rejected", "deleted", "unknown"].map(addonStatus => ({ addonStatus }))]) {
    const f = await fixture(t, { existing: false, ...overrides });
    await assert.rejects(() => signRelease(f.options));
    assert(!f.events.some(e => ["upload", "create", "patch-source", "patch-license"].includes(e)));
  }
});

test("lost create response preserves remote version; retry resumes rather than duplicates", async t => {
  const f = await fixture(t, { existing: false });
  f.client.doVersionSubmit = async () => { f.events.push("create"); f.state.existing = true; throw new Error("lost response"); };
  await assert.rejects(() => signRelease(f.options), /lost response/u);
  await signRelease(f.options);
  assert.equal(f.events.filter(e => e === "create").length, 1);
});

test("a lost upload outcome leaves no release and a retry uses a fresh upload", async t => {
  const f = await fixture(t, { existing: false });
  const upload = f.client.doUploadSubmit;
  let attempts = 0;
  f.client.doUploadSubmit = async (...args) => {
    await upload(...args);
    if (++attempts === 1) throw new Error("lost upload response");
    return "fresh-upload-identity";
  };
  await assert.rejects(() => signRelease(f.options), /lost upload/u);
  assert.equal(f.state.existing, false);
  assert(!f.events.includes("create"));
  const create = f.client.doVersionSubmit;
  f.client.doVersionSubmit = async (id, uuid, source) => {
    assert.equal(uuid, "fresh-upload-identity");
    return create(id, uuid, source);
  };
  await signRelease(f.options);
  assert.equal(attempts, 2);
  assert.equal(f.events.filter(event => event === "create").length, 1);
});

test("an earlier POST still executing after timeout blocks the next version until its outcome and review resolve", async t => {
  const f = await fixture(t, { existing: false, listed: [listed("1.0.9", "public")] });
  const github = { async get() { return ["v1.1.0", "v1.1.1"].map(tag => ({ ref: `refs/tags/${tag}` })); }, async releases() { return []; } };
  let barriers = 0;
  const options = { ...f.options, checkPriorReleases: async versions => {
    barriers++; await requireResolvedPriorReleases(github, "v1.1.1", versions, ["v1.1.0"]);
  } };
  // The earlier transaction exists only on the server, invisible to GET.
  await assert.rejects(() => signRelease(options), UnresolvedReleaseError);
  assert(!f.events.includes("upload") && !f.events.includes("create"));
  // Its eventual commit must then pass the ordinary pending-review guard.
  f.state.listed = [listed("1.1.0"), listed("1.0.9", "public")];
  await assert.rejects(() => signRelease(options), PendingReviewError);
  assert(!f.events.includes("upload"));
  f.state.listed = [listed("1.1.0", "public"), listed("1.0.9", "public")];
  await signRelease(options);
  assert.equal(barriers, 3, "intent is checked both before upload and before create");
  assert.equal(f.events.filter(event => event === "create").length, 1);
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

const listed = (version, status = "unreviewed") => ({ id: 41, version, channel: "listed", file: { status } });

test("a listed version awaiting review blocks a new submission before any upload", async t => {
  const f = await fixture(t, { existing: false, listed: [listed("1.1.0"), listed("1.0.9", "disabled"), listed("1.0.8", "public")] });
  await assert.rejects(() => signRelease(f.options), error => {
    assert(error instanceof PendingReviewError);
    assert.deepEqual(error.pending, ["1.1.0"]);
    assert.match(error.message, /would disable it/u);
    assert.match(error.message, /tag v1\.1\.1 and supersede 1\.1\.0/u);
    return true;
  });
  assert(!f.events.some(e => ["upload", "create", "patch-source"].includes(e)));
});

test("only an exact supersede choice replaces the single pending version", async t => {
  for (const [supersede, versions] of [["1.1.2", [listed("1.1.0")]], ["1.1.0", [listed("1.1.0"), listed("1.0.9")]]]) {
    const f = await fixture(t, { existing: false, listed: versions });
    await assert.rejects(() => signRelease({ ...f.options, supersede }), PendingReviewError);
    assert(!f.events.includes("upload"));
  }
  const f = await fixture(t, { existing: false, source: false, listed: [listed("1.1.0")] });
  const reports = [];
  await signRelease({ ...f.options, supersede: "1.1.0", report: entry => reports.push(entry) });
  assert.equal(f.events.filter(e => e === "create").length, 1);
  assert.equal(f.events.filter(e => e === "list-versions").length, 2);
  assert(reports.some(entry => /Replacing AMO version 1\.1\.0/u.test(entry.notice ?? "")));
});

test("a version that starts awaiting review during validation blocks creation", async t => {
  let lists = 0;
  const f = await fixture(t, { existing: false, listed: () => ++lists === 1 ? [listed("1.1.0", "public")] : [listed("1.1.0")] });
  await assert.rejects(() => signRelease(f.options), PendingReviewError);
  assert.equal(lists, 2);
  assert(f.events.includes("upload") && !f.events.includes("create"));
});

test("a moved tag is reported before another pending version, and each write follows a tag check", async t => {
  const f = await fixture(t, { existing: false, listed: [listed("1.1.0")] });
  await assert.rejects(() => signRelease({ ...f.options, beforeWrite: async () => { throw new Error("tag moved"); } }), /tag moved/u);
  assert(!f.events.includes("list-versions") && !f.events.includes("upload"));
  const g = await fixture(t, { existing: false, source: false });
  const order = [];
  const client = g.client;
  for (const name of ["listedVersions", "doUploadSubmit", "doVersionSubmit", "doFormDataPatch"]) {
    const original = client[name].bind(client);
    client[name] = async (...args) => { order.push(name); return original(...args); };
  }
  await signRelease({ ...g.options, beforeWrite: async () => { order.push("tag-check"); } });
  assert.deepEqual(order, ["tag-check", "listedVersions", "tag-check", "doUploadSubmit", "tag-check", "listedVersions", "tag-check",
    "doVersionSubmit"]);
});

test("resuming an existing version never lists or blocks on other versions", async t => {
  const f = await fixture(t, { source: false, listed: () => assert.fail("resume must not list versions") });
  await signRelease(f.options);
  assert(!f.events.includes("list-versions"));
});

test("unreadable review state fails closed before upload", async t => {
  for (const versions of [[{ version: "1.1.0", channel: "listed" }], [listed("1.1.0", "public"), { ...listed("1.0.9"), channel: "unlisted" }], [null]]) {
    const f = await fixture(t, { existing: false, listed: versions });
    await assert.rejects(() => signRelease(f.options), /Cannot establish which AMO versions await review/u);
    assert(!f.events.includes("upload"));
  }
});

test("the approval wait ends in a resumable pending state only after payload, license and source checks", async t => {
  const f = await fixture(t, { existing: false, public: false, source: false });
  const pending = await signRelease({ ...f.options, approvalWaitMs: 0 });
  assert.deepEqual(pending, { state: "awaiting-review", versionId: 42, fileStatus: "unreviewed" });
  assert(f.events.includes("verify-payload") && f.events.includes("download"));
  assert(!f.events.includes("patch-source"));
  f.state.public = true;
  const resumed = await signRelease({ ...f.options, approvalWaitMs: 0 });
  assert.equal(resumed.state, "approved-and-signed");
  assert.equal(f.events.filter(e => e === "upload").length, 1);
  assert.equal(f.events.filter(e => e === "create").length, 1);
  assert.equal(f.events.filter(e => e === "patch-source").length, 0);
});

test("waiting polls until the approval budget, then reports pending instead of failing", async t => {
  const f = await fixture(t, { public: false });
  let polls = 0; const read = f.client.version;
  f.client.version = async () => { polls++; return read(); };
  const started = Date.now();
  const result = await signRelease({ ...f.options, approvalWaitMs: 30 });
  assert.equal(result.state, "awaiting-review");
  assert(polls > 1);
  assert(Date.now() - started >= 30);
  assert(!f.events.some(e => ["upload", "create", "patch-source"].includes(e)));
});

test("the owner version listing follows AMO pagination only within the API, within a bound", async () => {
  const requests = [];
  const pageUrl = page => `https://addons.mozilla.org/api/v5/addons/addon/stackma%40extensions.local/versions/?filter=all_without_unlisted&page=${page}&page_size=50`;
  const client = new ReleaseClient({ apiKey: "test", apiSecret: "test", fetchImpl: async url => {
    requests.push(new URL(url));
    const page = Number(new URL(url).searchParams.get("page") ?? 1);
    return Response.json({ count: 3, next: page < 3 ? pageUrl(page + 1) : null, previous: null, results: [listed(`1.0.${page}`, "public")] });
  } });
  assert.deepEqual((await client.listedVersions("stackma@extensions.local")).map(entry => entry.version), ["1.0.1", "1.0.2", "1.0.3"]);
  assert.equal(requests[0].searchParams.get("filter"), "all_without_unlisted");
  assert.equal(requests[0].searchParams.get("page_size"), "50");
  await assert.rejects(() => client.listedVersions("stackma@extensions.local", 2), /exceeds 2 pages/u);
  const foreign = new ReleaseClient({ apiKey: "test", apiSecret: "test", fetchImpl: async () => Response.json({ results: [], next: "https://evil.invalid/api/v5/versions/" }) });
  await assert.rejects(() => foreign.listedVersions("stackma@extensions.local"), /Unexpected authenticated API destination/u);
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

test("malformed successful API responses do not leak provider response text", async () => {
  const client = new ReleaseClient({ apiKey: "test", apiSecret: "test", fetchImpl: async () => new Response("synthetic-private-response") });
  await assert.rejects(() => client.fetchJson(new URL("https://addons.mozilla.org/api/v5/site/")),
    error => /malformed JSON/u.test(error.message) && !String(error.stack).includes("synthetic-private"));
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

test("v5 client creates a version with source and verified inherited terms in one multipart request",async t=>{
  const directory=await temporary(t),license="Project terms; CMU terms",source=Buffer.from("source archive fixture");
  const entries=[["manifest.json",'{"version":"1.1.1"}'],["background.js","code"]];
  await archive(`${directory}/unsigned.xpi`,entries);
  await archive(`${directory}/server-signed.xpi`,[...entries,["META-INF/cose.sig","signature fixture"]]);
  const unsigned=await readFile(`${directory}/unsigned.xpi`),signed=await readFile(`${directory}/server-signed.xpi`);
  await writeFile(`${directory}/source.zip`,source);await writeFile(`${directory}/license.txt`,license);
  const context={id:"stackma@extensions.local",version:"1.1.1",channel:"listed",unsigned:{sha256:sha256(unsigned)},source:{sha256:sha256(source)},license:{name:"Project terms",sha256:sha256(license)}};
  let created=false,attached=false,lists=0;const writes=[];
  const uuid="00000000000040008000000000000042"; // deployed UUIDField(format="hex")
  const addon={guid:context.id,slug:"stackma",status:"public",is_disabled:false};
  const detail=()=>({id:42,version:context.version,channel:"listed",is_disabled:false,license:{text:{"en-US":license}},source:attached?"https://addons.mozilla.org/download/source/42":null,
    file:{status:attached?"public":"unreviewed",size:(attached?signed:unsigned).length,hash:`sha256:${sha256(attached?signed:unsigned)}`,url:"https://addons.mozilla.org/download/file/42"}});
  const client=new ReleaseClient({apiKey:"fixture-issuer",apiSecret:"fixture-secret",timeoutMs:3000,pollMs:1,fetchImpl:async(url,options)=>{
    const path=decodeURIComponent(new URL(url).pathname),method=options.method??"GET";
    assert.match(options.headers.Authorization,/^JWT /u);
    if(path==="/api/v5/site/")return Response.json({read_only:false});
    if(path.endsWith("/addon/stackma@extensions.local/")&&method==="GET")return Response.json(addon);
    if(path.endsWith("/versions/v1.1.1/"))return created?Response.json(detail()):Response.json({detail:"absent"},{status:404});
    if(path.endsWith("/versions/v1.1.0/"))return Response.json({id:41,channel:"listed",license:{text:{"en-US":license}}});
    if(path.endsWith("/addon/stackma@extensions.local/versions/")&&method==="GET"){
      lists++;assert.equal(new URL(url).searchParams.get("filter"),"all_without_unlisted");
      return Response.json({count:1,next:null,previous:null,results:[{id:41,version:"1.1.0",channel:"listed",file:{status:"public"}}]});
    }
    if(path.endsWith("/upload/")&&method==="POST"){
      writes.push("upload");assert.equal(options.body.get("channel"),"listed");
      assert.deepEqual(Buffer.from(await options.body.get("upload").arrayBuffer()),unsigned);return Response.json({uuid});
    }
    if(path.endsWith(`/upload/${uuid}/`))return Response.json({processed:true,valid:true,uuid});
    if(method==="POST"&&path.endsWith("/versions/")){
      writes.push("create");assert.equal(options.body.get("upload"),uuid);
      assert.deepEqual([...options.body.keys()].sort(),["source","upload"]);
      assert.deepEqual(Buffer.from(await options.body.get("source").arrayBuffer()),source);
      created=true;attached=true;return Response.json(detail());
    }
    if(path.includes("/download/source/"))return new Response(source);
    if(path.includes("/download/file/"))return new Response(attached?signed:unsigned);
    assert.fail(`Unexpected protocol request ${method} ${path}`);
  }});
  const result=await signRelease({client,context,directory,output:`${directory}/result.xpi`});
  assert.deepEqual(writes,["upload","create"]);assert.equal(result.signed.sha256,sha256(signed));
  assert.equal(lists,2,"pending review is checked before upload and again before creation");
});

test("license inheritance is checked before upload and again after validation", async t => {
  for (const changeDuringValidation of [false, true]) {
    const f = await fixture(t, { existing: false, predecessorLicense: changeDuringValidation ? undefined : "wrong terms" });
    const upload = f.client.doUploadSubmit;
    f.client.doUploadSubmit = async (...args) => { const uuid = await upload(...args); f.state.predecessorLicense = "wrong terms"; return uuid; };
    await assert.rejects(() => signRelease(f.options), /different license terms/u);
    assert.equal(f.events.includes("upload"), changeDuringValidation);
    assert(!f.events.includes("create") && !f.events.includes("patch-source"));
  }
});

test("unknown license predecessor and predecessor identity changes stop submission", async t => {
  const empty = await fixture(t, { existing: false, listed: [] });
  await assert.rejects(() => signRelease(empty.options), /license predecessor/u);
  assert(!empty.events.includes("upload"));
  const changed = await fixture(t, { existing: false, listed: [{ ...listed("1.1.0", "public"), id: 99 }] });
  await assert.rejects(() => signRelease(changed.options), /predecessor changed/u);
  assert(!changed.events.includes("upload"));
});

test("provider changes after creation cannot silently rewrite terms or attach a missing source", async t => {
  for (const failure of ["license", "source"]) {
    const f = await fixture(t, { existing: false, source: false });
    f.client.doVersionSubmit = async () => {
      f.events.push("create"); f.state.existing = true;
      f.state.source = failure !== "source"; f.state.wrongLicense = failure === "license";
    };
    await assert.rejects(() => signRelease(f.options), /license differs|no source attachment/u);
    assert(!f.events.includes("patch-source"));
  }
});

test("a version identity change while awaiting approval stops reconciliation", async t => {
  const f = await fixture(t, { public: false });
  let reads = 0;
  f.client.version = async () => ({ ...f.detail(), id: ++reads === 1 ? 42 : 99 });
  await assert.rejects(() => signRelease(f.options), /identity changed/u);
  assert(!f.events.some(event => ["create", "patch-source"].includes(event)));
});

test("AMO JWT has a independently verifiable short-lived HS256 signature", async () => {
  const { subtle } = await import("node:crypto");
  const auth = new JwtApiAuth({ apiKey: "test-issuer", apiSecret: "test-secret" });
  const [header, payload, signature] = (await auth.getAuthHeader()).slice(4).split(".");
  const key = await subtle.importKey("raw", Buffer.from("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  assert(await subtle.verify("HMAC", key, Buffer.from(signature, "base64url"), Buffer.from(`${header}.${payload}`)));
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "HS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "test-issuer");
  assert.equal(claims.exp - claims.iat, 300);
  assert(Math.abs(claims.iat - Date.now() / 1000) < 2);
  assert.match(claims.jti, /^[a-f0-9-]{36}$/u);
  assert.notEqual((await auth.getAuthHeader()).slice(4).split(".")[1], payload);
});

test("invalid upload validation stops before creating any version and redacts service details", async t => {
  const dir = await temporary(t); await writeFile(`${dir}/unsigned.xpi`, "payload");
  const uuid = "00000000000040008000000000000042", writes = [];
  const client = new ReleaseClient({ apiKey: "test", apiSecret: "test", pollMs: 1, fetchImpl: async (_url, options) => {
    if (options.method === "POST") { writes.push("upload"); return Response.json({ uuid }); }
    return Response.json({ uuid, processed: true, valid: false, validation: "private request details" });
  } });
  await assert.rejects(() => client.doUploadSubmit(`${dir}/unsigned.xpi`, "listed"), error => /validation rejected/u.test(error.message) && !error.message.includes("private"));
  assert.deepEqual(writes, ["upload"]);
});
