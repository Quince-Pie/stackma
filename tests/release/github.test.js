import assert from "node:assert/strict";
import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { checkAmoPublication, GitHub, matchingRelease, publishRelease } from "../../scripts/release/github.js";
import { digestFile, sha256 } from "../../scripts/release/package.js";
import { temporary } from "./fixtures.js";

async function fixture(t) {
  const directory=await temporary(t), tag="v1.1.1", version="1.1.1", commit="a".repeat(40);
  const xpi=`stackma-${version}.xpi`, source=`stackma-${version}-source.zip`;
  await writeFile(`${directory}/${xpi}`,"signed XPI"); await writeFile(`${directory}/${source}`,"source");
  const record={tag,version,commit,channel:"listed",unsigned:{sha256:sha256("unsigned")},signed:await digestFile(`${directory}/${xpi}`),source:await digestFile(`${directory}/${source}`)};
  await writeFile(`${directory}/release.json`,JSON.stringify(record));
  const names=[xpi,source,"release.json"];
  const sums=await Promise.all(names.map(async name=>`${(await digestFile(`${directory}/${name}`)).sha256}  ${name}\n`));
  await writeFile(`${directory}/SHA256SUMS`,sums.join(""));
  const history=[], calls=[];
  const state={commit,immutable:true,failUpload:false,failCreate:false,attestationFailures:0};
  const github={
    async commit(){return state.commit;},
    async releases(){return structuredClone(history);},
    async cli(args){
      calls.push(args); const command=args[1];
      if(command==="create") {
        history.push({id:100,tag_name:tag,body:await readFile(args[args.indexOf("--notes-file")+1],"utf8"),assets:[],draft:true,prerelease:false,html_url:"https://github.com/Quince-Pie/stackma/releases/tag/v1.1.1"});
        if(state.failCreate) {state.failCreate=false;throw new Error("lost create response");}
      } else if(command==="verify-asset") {
        if(state.attestationFailures-- > 0) throw new Error("attestation pending");
      } else assert.fail(`Unexpected command: ${args}`);
    },
    async mutate(id, options) {
      const release=history.find(r=>r.id===id);assert(release);
      if(options.file) {
        calls.push(["api","upload",id,options.name]);
        const file=await digestFile(options.file);
        assert.equal(options.name,basename(options.file));
        assert(!release.assets.some(a=>a.name===options.name));
        release.assets.push({name:options.name,size:file.bytes,digest:`sha256:${file.sha256}`,state:"uploaded"});
        if(state.failUpload){state.failUpload=false;throw new Error("lost upload response");}
      } else {
        calls.push(["api","edit",id,`--latest=${options.body.make_latest}`]);
        assert.equal(options.body.tag_name,tag);assert.equal(options.body.draft,false);
        release.draft=false;release.immutable=state.immutable;
      }
    },
  };
  const options={github,record,directory,notesPath:`${directory}/notes.md`,pause:async()=>{},amoCheck:async()=>{}};
  return {options,github,record,history,calls,state};
}

test("publish stages a draft, verifies all digests, publishes once and verifies every asset",async t=>{
  const f=await fixture(t); const result=await publishRelease(f.options);
  assert.equal(result.immutable,true);assert.equal(f.history[0].assets.length,4);
  assert.equal(f.calls.filter(a=>a[1]==="edit").length,1);
  assert.equal(f.calls.filter(a=>a[1]==="verify-asset").length,4);
  assert(f.calls[0].includes("--draft") && f.calls[0].includes("--verify-tag"));
  const previous=f.calls.length;await publishRelease(f.options);
  assert(f.calls.slice(previous).every(a=>a[1]==="verify-asset"));
});

for(const failure of ["failCreate","failUpload"]) test(`${failure}: reconcile completed remote work without overwrite`,async t=>{
  const f=await fixture(t);f.state[failure]=true;
  await assert.rejects(()=>publishRelease(f.options));
  assert.equal(f.history.length,1);assert.equal(f.history[0].draft,true);
  await publishRelease(f.options);
  assert.equal(f.calls.filter(a=>a[1]==="create").length,1);
  assert.equal(f.calls.filter(a=>a[1]==="upload").length,4);
  assert(!f.calls.flat().includes("--clobber"));
});

test("conflicting or extra assets stop a draft before publication",async t=>{
  const f=await fixture(t);f.state.failUpload=true;
  await assert.rejects(()=>publishRelease(f.options));
  f.history[0].assets[0].digest=`sha256:${"b".repeat(64)}`;
  await assert.rejects(()=>publishRelease(f.options),/digest conflict/u);
  assert(f.history[0].draft);assert(!f.calls.some(a=>a[1]==="edit"));
});

test("duplicate drafts and unrelated releases are not silently adopted",()=>{
  const release={tag_name:"v1.1.1",body:"marker",prerelease:false};
  assert.throws(()=>matchingRelease([release,release],"v1.1.1","marker"),/Multiple/u);
  assert.throws(()=>matchingRelease([release],"v1.1.1","other"),/different build/u);
});

test("moved tags stop publication without creating a new tag",async t=>{
  const f=await fixture(t);f.state.commit="b".repeat(40);
  await assert.rejects(()=>publishRelease(f.options),/tag moved/u);assert.equal(f.calls.length,0);
});

test("disabled immutability is reported after publication without deleting the release",async t=>{
  const f=await fixture(t);f.state.immutable=false;
  await assert.rejects(()=>publishRelease(f.options),/not immutable/u);
  assert.equal(f.history[0].draft,false);assert(!f.calls.some(a=>a[1]==="delete"));
});

test("delayed attestations retry reads, never publication",async t=>{
  const f=await fixture(t);f.state.attestationFailures=1;
  await publishRelease(f.options);
  assert.equal(f.calls.filter(a=>a[1]==="edit").length,1);
  assert.equal(f.calls.filter(a=>a[1]==="verify-asset").length,5);
});

test("attestation exhaustion leaves a recoverable published release",async t=>{
  const f=await fixture(t);f.state.attestationFailures=100;
  await assert.rejects(()=>publishRelease({...f.options,verificationAttempts:2}),/attestation pending/u);
  assert.equal(f.history[0].draft,false);
  assert.equal(f.calls.filter(a=>a[1]==="verify-asset").length,2);
});

test("corrupt transfer checksums fail before remote mutation",async t=>{
  const f=await fixture(t);await writeFile(`${f.options.directory}/SHA256SUMS`,"wrong");
  await assert.rejects(()=>publishRelease(f.options));assert.equal(f.calls.length,0);
});

test("an older recovered version does not replace a newer latest release",async t=>{
  const f=await fixture(t);await publishRelease(f.options);
  f.history[0].draft=true;
  f.history.push({tag_name:"v1.2.0",draft:false,prerelease:false});
  await publishRelease(f.options);
  assert(f.calls.filter(a=>a[1]==="edit").at(-1).includes("--latest=false"));
});

test("a newer release observed during asset staging remains Latest",async t=>{
  const f=await fixture(t),mutate=f.github.mutate;let uploads=0;
  f.github.mutate=async(id,options)=>{
    await mutate(id,options);
    if(options.file && ++uploads===4) f.history.push({id:200,tag_name:"v1.2.0",draft:false,prerelease:false});
  };
  await publishRelease(f.options);
  assert(f.calls.filter(a=>a[1]==="edit").at(-1).includes("--latest=false"));
});

test("release listing checks pages beyond the first two and bounds inconclusive history",async()=>{
  const github=new GitHub("Quince-Pie/stackma","test");let page=0;
  github.get=async()=>++page<4?Array.from({length:100},()=>({tag_name:"older"})):[];
  assert.equal((await github.releases()).length,300);assert.equal(page,4);
  page=0;github.get=async()=>{page++;return Array(100).fill({});};
  await assert.rejects(()=>github.releases(),/recovery bound/u);assert.equal(page,100);
});

test("annotated tag resolution preserves the commit and rejects malformed objects",async()=>{
  const github=new GitHub("Quince-Pie/stackma","test");let calls=0;
  github.get=async()=>({object:++calls===1?{type:"tag",sha:"a".repeat(40)}:{type:"commit",sha:"b".repeat(40)}});
  assert.equal(await github.commit("v1.1.1"),"b".repeat(40));
  github.get=async()=>({object:{type:"tree",sha:"a".repeat(40)}});
  await assert.rejects(()=>github.commit("v1.1.1"),/commit/u);
});

test("competing same-tag draft cannot redirect an upload to a different release ID",async t=>{
  const f=await fixture(t), mutate=f.github.mutate;
  let injected=false;
  f.github.mutate=async(id,options)=>{
    if(!injected){injected=true;f.history.unshift({...structuredClone(f.history[0]),id:999,assets:[]});}
    assert.equal(id,100);return mutate(id,options);
  };
  await assert.rejects(()=>publishRelease(f.options),/Multiple/u);
  assert.equal(f.history.find(r=>r.id===999).assets.length,0);
  assert.equal(f.history.find(r=>r.id===100).assets.length,4);
  assert(f.history.every(r=>r.draft));
});

test("GitHub transport targets the validated release ID and never redirects credentials",async t=>{
  const dir=await temporary(t), file=`${dir}/asset.xpi`;await writeFile(file,"bytes");
  const calls=[];
  const github=new GitHub("Quince-Pie/stackma","test-token",async(url,options)=>{calls.push({url,options});return new Response(null,{status:201});});
  await github.mutate(123,{file,name:"asset.xpi"});
  await github.mutate(123,{body:{tag_name:"v1.1.1",draft:false,make_latest:"true"}});
  assert.equal(calls[0].url,"https://uploads.github.com/repos/Quince-Pie/stackma/releases/123/assets?name=asset.xpi");
  assert.equal(calls[1].url,"https://api.github.com/repos/Quince-Pie/stackma/releases/123");
  assert(calls.every(c=>c.options.redirect==="error"));
  assert.equal(calls[0].options.body.toString(),"bytes");
  assert.equal(JSON.parse(calls[1].options.body).draft,false);
  await assert.rejects(()=>github.mutate(-1,{body:{}}));
});

test("failed GitHub reads cancel their bodies and distinguish absence from authorization failure",async()=>{
  for(const status of [404,401,403,500]) {
    let cancelled=false;
    const github=new GitHub("Quince-Pie/stackma","test",async()=>({status,ok:false,body:{async cancel(){cancelled=true;}}}));
    if(status===404) assert.equal(await github.get("releases/tags/v1.1.1"),null);
    else await assert.rejects(()=>github.get("releases/tags/v1.1.1"),new RegExp(`HTTP ${status}`,"u"));
    assert(cancelled);
  }
});

test("public AMO eligibility is revalidated without forwarding GitHub or AMO credentials",async()=>{
  const record={id:"stackma@extensions.local",channel:"listed",version:"1.1.1",versionId:42,signed:{sha256:"a".repeat(64),bytes:100},license:{sha256:sha256("terms"),apiSha256:sha256("terms")}};
  const addon={guid:record.id,status:"public",is_disabled:false};
  const version={id:42,version:record.version,channel:"listed",license:{text:{"en-US":"terms"}},file:{status:"public",hash:`sha256:${record.signed.sha256}`,size:100}};
  const fake=async(url,options)=>{assert.equal(options.headers,undefined);return Response.json(url.includes("versions/")?version:addon);};
  await checkAmoPublication(record,fake);
  for(const state of ["disabled","nominated","rejected"]) {
    addon.status=state;await assert.rejects(()=>checkAmoPublication(record,fake));
  }
  addon.status="public";version.file.hash=`sha256:${"b".repeat(64)}`;
  await assert.rejects(()=>checkAmoPublication(record,fake),/changed/u);
});

test("AMO approval withdrawal between staging and publication preserves the draft",async t=>{
  const f=await fixture(t);let checks=0;
  await assert.rejects(()=>publishRelease({...f.options,amoCheck:async()=>{if(++checks===2)throw new Error("approval withdrawn");}}),/approval withdrawn/u);
  assert.equal(f.history[0].draft,true);assert.equal(f.history[0].assets.length,4);
});

test("anonymous publication checks the same rendered license without accepting changed links or terms", async () => {
  const raw = "Copyright <sam@hocevar.net>\nUnchanged terms";
  const api = 'Copyright &lt;<a href="/" rel="nofollow">sam@hocevar.net</a>&gt;\nUnchanged terms';
  const record = { id: "stackma@extensions.local", channel: "listed", version: "1.1.2", versionId: 42,
    signed: { sha256: "a".repeat(64), bytes: 100 }, license: { sha256: sha256(raw), apiSha256: sha256(api) } };
  const addon = { guid: record.id, status: "public", is_disabled: false };
  const version = { id: 42, version: record.version, channel: "listed", license: { text: { "en-US": api } },
    file: { status: "public", hash: `sha256:${record.signed.sha256}`, size: 100 } };
  const fake = async (url, options) => {
    assert.equal(options.headers, undefined);
    return Response.json(url.includes("versions/") ? version : addon);
  };
  await checkAmoPublication(record, fake);
  for (const text of [api.replace("Unchanged", "Changed"), api.replace('href="/"', 'href="https://evil.invalid/"')]) {
    version.license.text["en-US"] = text;
    await assert.rejects(() => checkAmoPublication(record, fake), /license changed/u);
  }
});
