import assert from "node:assert/strict";
import test from "node:test";
import { approvedVersions, cli, GitHubClient, maximumAutomaticAttempts, planResume, runResume } from "../../scripts/release/resume.js";

// A small model of the public GitHub and AMO read APIs plus workflow dispatch.
function world(overrides = {}) {
  const state = {
    tags: ["v1.1.1", "v1.1.2", "v1.1.3", "v1.1.4", "v1.2", "v01.1.5", "nightly"],
    releases: [{ tag_name: "v1.1.1", draft: false }, { tag_name: "v1.1.3", draft: true }],
    addon: { status: 200, body: { guid: "stackma@extensions.local", status: "public", is_disabled: false } },
    versions: { "1.1.4": "public" },
    active: {}, dispatched: [], failures: {}, jobs: {},
    ...overrides,
  };
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url), method = options.method ?? "GET";
    requests.push({ url: target, method, auth: Boolean(options.headers?.Authorization), redirect: options.redirect, body: options.body, signal: options.signal });
    const failure = state.failures[target.hostname];
    if (failure instanceof Error) throw failure;
    if (typeof failure === "number") return new Response("service error", { status: failure });
    if (failure) return new Response("service error", { status: failure.status, headers: failure.headers });
    if (target.hostname === "addons.mozilla.org") {
      const match = /\/versions\/v([^/]+)\/$/u.exec(target.pathname);
      if (match) {
        const version = decodeURIComponent(match[1]);
        if (state.versionDetail) return state.versionDetail(version);
        const status = state.versions[version];
        if (!status || status === "rejected") return new Response(null, { status: 404 });
        if (typeof status === "number") return new Response(null, { status });
        return Response.json({ id: Object.keys(state.versions).indexOf(version) + 1, version, channel: "listed", file: { status } });
      }
      if (!target.pathname.endsWith("/versions/")) {
        assert.equal(target.pathname, "/api/v5/addons/addon/stackma%40extensions.local/");
        return state.addon.body ? Response.json(state.addon.body, { status: state.addon.status }) : new Response(null, { status: state.addon.status });
      }
      assert.equal(target.searchParams.get("page_size"), "50");
      assert.equal(target.searchParams.has("filter"), false);
      const page = Number(target.searchParams.get("page") ?? 1);
      const versions = Object.entries(state.versions).filter(([, status]) => status === "public")
        .map(([version], index) => ({ id: index + 1, version, channel: "listed", file: { status: "public" } }));
      const next = new URL(target);
      next.searchParams.set("page", String(page + 1));
      const history = { count: versions.length, page_size: 50, page_count: Math.max(1, Math.ceil(versions.length / 50)),
        next: page * 50 < versions.length ? next.href : null, results: versions.slice((page - 1) * 50, page * 50) };
      return Response.json(state.versionPage ? state.versionPage(history, page) : history);
    }
    assert.equal(target.hostname, "api.github.com");
    const path = target.pathname.replace("/repos/Quince-Pie/tab-gantry/", "");
    if (path === "git/matching-refs/tags/v") return Response.json(state.tags.map(tag => ({ ref: `refs/tags/${tag}`, object: { sha: "a".repeat(40), type: "commit" } })));
    if (path === "releases") {
      const page = Number(target.searchParams.get("page") ?? 1);
      return Response.json(state.releases.slice((page - 1) * 100, page * 100));
    }
    if (path === "actions/workflows/release.yml/runs") {
      const status = target.searchParams.get("status");
      if (status) return Response.json({ total_count: state.active[status] ? "2,500+" : 0, workflow_runs: state.active[status] ? [{ status }] : [] });
      assert.equal(target.searchParams.get("event"), "workflow_dispatch");
      const actor = target.searchParams.get("actor");
      assert(actor === null || actor === "github-actions[bot]");
      const page = Number(target.searchParams.get("page") ?? 1);
      const since = target.searchParams.get("created")?.slice(2);
      const automatic = state.dispatched.filter(run => (!actor || run.actor?.login === actor) && (!since || Date.parse(run.created_at) >= Date.parse(since)));
      const history = { total_count: automatic.length, workflow_runs: automatic.slice((page - 1) * 100, page * 100) };
      return Response.json(state.historyPage ? state.historyPage(history, page) : history);
    }
    const jobPath = /^actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/u.exec(path);
    if (jobPath) {
      const key = `${jobPath[1]}:${jobPath[2]}`;
      const jobs = Object.hasOwn(state.jobs, key) ? state.jobs[key] : [];
      return jobs === null ? new Response(null, { status: 404 }) : Response.json({ total_count: jobs.length, jobs });
    }
    if (path === "actions/workflows/release.yml/dispatches" && method === "POST") {
      return Response.json({ workflow_run_id: 99, run_url: "https://api.github.com/repos/Quince-Pie/tab-gantry/actions/runs/99", html_url: "https://github.com/Quince-Pie/tab-gantry/actions/runs/99" });
    }
    return assert.fail(`Unexpected request ${method} ${target}`);
  };
  const github = new GitHubClient("Quince-Pie/tab-gantry", "workflow-token", fetchImpl);
  return { state, requests, fetchImpl, github, posts: () => requests.filter(request => request.method === "POST") };
}

// actor started the run; triggering_actor started its latest attempt.
let runId = 0;
const run = (title, login = "github-actions[bot]", rerunBy = login) => {
  const id = ++runId, created = new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString();
  return { id, display_title: title, event: "workflow_dispatch", run_attempt: 1, created_at: created, updated_at: created,
    actor: { login }, triggering_actor: { login: rerunBy }, status: "completed", conclusion: "failure" };
};

test("an approved tag without a published release is dispatched once on main, and AMO never sees credentials", async () => {
  const w = world();
  const logs = [];
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: line => logs.push(line) });
  assert.deepEqual(plan, { action: "dispatch", tag: "v1.1.4", attempts: 0, notes: [], attention: [], run: "https://github.com/Quince-Pie/tab-gantry/actions/runs/99" });
  assert(logs.some(line => line.includes("Run: https://github.com/Quince-Pie/tab-gantry/actions/runs/99")));
  const [post] = w.posts();
  assert.equal(post.url.pathname, "/repos/Quince-Pie/tab-gantry/actions/workflows/release.yml/dispatches");
  assert.deepEqual(JSON.parse(post.body), { ref: "main", inputs: { tag: "v1.1.4" } });
  assert(w.requests.every(request => request.redirect === "error"));
  assert(w.requests.filter(request => request.url.hostname === "addons.mozilla.org").every(request => !request.auth));
  assert(w.requests.filter(request => request.url.hostname === "api.github.com").every(request => request.auth));
  const checked = w.requests.filter(request => /\/versions\//u.test(request.url.pathname));
  assert.equal(checked.length, 1, "all unpublished tags share the public version-list query");
  assert.equal(checked[0].url.pathname, "/api/v5/addons/addon/stackma%40extensions.local/versions/");
});

test("nothing is dispatched while the listing or the version is not publicly approved", async () => {
  for (const overrides of [
    { addon: { status: 401, body: { detail: "Authentication credentials were not provided." } } },
    { addon: { status: 200, body: { guid: "stackma@extensions.local", status: "nominated", is_disabled: false } } },
    { addon: { status: 200, body: { guid: "stackma@extensions.local", status: "public", is_disabled: true } } },
    { versions: { "1.1.4": 401 } },
    { versions: { "1.1.4": "unreviewed" } },
    { versions: { "1.1.4": "disabled" } },
    { versions: { "1.1.4": "rejected" } },
    { versions: {} },
  ]) {
    const w = world(overrides);
    const plan = await planResume({ github: w.github, fetchImpl: w.fetchImpl });
    assert.equal(plan.action, "none");
    assert.equal(w.posts().length, 0);
  }
  const w = world({ addon: { status: 401, body: {} } });
  await planResume({ github: w.github, fetchImpl: w.fetchImpl });
  assert.equal(w.requests.filter(request => /\/versions\//u.test(request.url.pathname)).length, 0, "a non-public listing needs no version reads");
});

test("an explicitly retired approved tag is never dispatched and does not hide the next approved tag", async () => {
  const w = world();
  assert.equal((await planResume({ github: w.github, fetchImpl: w.fetchImpl, retired: new Set(["v1.1.4"]) })).action, "none");
  assert.equal(w.posts().length, 0);
  const both = world({ tags: ["v1.1.4", "v1.1.5"], versions: { "1.1.4": "public", "1.1.5": "public" } });
  const plan = await runResume({ github: both.github, fetchImpl: both.fetchImpl, retired: new Set(["v1.1.4"]), log: () => {} });
  assert.equal(plan.tag, "v1.1.5");
  assert.deepEqual(JSON.parse(both.posts()[0].body), { ref: "main", inputs: { tag: "v1.1.5" } });
});

test("a queued, running or waiting publisher defers dispatch", async () => {
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    const w = world({ active: { [status]: 1 } });
    const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
    assert.equal(plan.action, "wait");
    assert.equal(w.posts().length, 0);
  }
});

test("automatic attempts are capped per tag, reruns by people do not reset the count, and runs started by people do not count", async () => {
  // The second automatic run was rerun by the owner; it still counts as automatic.
  const bots = [run("Publish release v1.1.4"), run("Publish release v1.1.4", "github-actions[bot]", "Quince-Pie")];
  assert.equal(bots.length, maximumAutomaticAttempts);
  const logs = [];
  const w = world({ dispatched: bots });
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: line => logs.push(line) });
  assert.equal(plan.action, "attention");
  assert.equal(plan.attention.length, 1);
  assert.equal(w.posts().length, 0);
  assert(logs.some(line => line.startsWith("::error title=Release needs attention::v1.1.4")));
  const people = world({ dispatched: [run("Publish release v1.1.4", "Quince-Pie"), run("Publish release v1.1.4", "Quince-Pie"), run("Publish release v1.1.4")] });
  assert.deepEqual(await planResume({ github: people.github, fetchImpl: people.fetchImpl }), { action: "dispatch", tag: "v1.1.4", attempts: 1, notes: [], attention: [] });
});

test("the oldest approved version is dispatched first and a capped tag does not block the next", async () => {
  const w = world({ versions: { "1.1.3": "public", "1.1.4": "public" }, releases: [{ tag_name: "v1.1.1", draft: false }] });
  assert.equal((await planResume({ github: w.github, fetchImpl: w.fetchImpl })).tag, "v1.1.3");
  const capped = world({ versions: { "1.1.3": "public", "1.1.4": "public" }, releases: [{ tag_name: "v1.1.1", draft: false }],
    dispatched: [run("Publish release v1.1.3"), run("Publish release v1.1.3")] });
  const plan = await planResume({ github: capped.github, fetchImpl: capped.fetchImpl });
  assert.equal(plan.tag, "v1.1.4");
  assert.deepEqual(plan.attention.map(item => item.split(":")[0]), ["v1.1.3"]);
  const later = world({ versions: { "1.1.3": "public", "1.1.4": "public" }, releases: [{ tag_name: "v1.1.1", draft: false }],
    dispatched: [run("Publish release v1.1.4"), run("Publish release v1.1.4")] });
  const both = await planResume({ github: later.github, fetchImpl: later.fetchImpl });
  assert.equal(both.tag, "v1.1.3");
  assert.deepEqual(both.attention.map(item => item.split(":")[0]), ["v1.1.4"], "a stuck tag after the dispatched one is still reported");
});

test("the command fails only when an approved version needs a person, so GitHub notifies the schedule's owner", async () => {
  const env = { GITHUB_REPOSITORY: "Quince-Pie/tab-gantry", GH_TOKEN: "workflow-token" };
  const stuck = world({ dispatched: [run("Publish release v1.1.4"), run("Publish release v1.1.4")] });
  assert.equal(await cli({ argv: [], env, fetchImpl: stuck.fetchImpl, log: () => {} }), 1);
  const ready = world();
  assert.equal(await cli({ argv: ["--dry-run"], env, fetchImpl: ready.fetchImpl, log: () => {} }), 0);
  assert.equal(ready.posts().length, 0);
  const outage = world({ failures: { "addons.mozilla.org": 503 } });
  assert.equal(await cli({ argv: ["--repository=Quince-Pie/tab-gantry"], env: { GH_TOKEN: "workflow-token" }, fetchImpl: outage.fetchImpl, log: () => {} }), 0);
  await assert.rejects(() => cli({ argv: [], env: {}, fetchImpl: ready.fetchImpl, log: () => {} }), /GITHUB_REPOSITORY/u);
});

test("service outages skip the run without dispatching; malformed data fails", async () => {
  for (const failures of [{ "addons.mozilla.org": 503 }, { "addons.mozilla.org": 429 }, { "api.github.com": 502 }, { "addons.mozilla.org": new TypeError("fetch failed") },
    { "api.github.com": { status: 403, headers: { "x-ratelimit-remaining": "0" } } }, { "api.github.com": { status: 403, headers: { "retry-after": "60" } } }]) {
    const w = world({ failures });
    const logs = [];
    const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: line => logs.push(line) });
    assert.equal(plan.action, "retry-later");
    assert.equal(w.posts().length, 0);
    assert(logs.some(line => line.startsWith("::warning title=Release status unavailable::")));
  }
  for (const failures of [{ "api.github.com": 403 }, { "addons.mozilla.org": 400 }]) {
    const w = world({ failures });
    await assert.rejects(() => runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} }), /HTTP 40[03]/u);
  }
  const w = world({ addon: { status: 200, body: { guid: "other@example.invalid", status: "public", is_disabled: false } } });
  await assert.rejects(() => planResume({ github: w.github, fetchImpl: w.fetchImpl }), /Unexpected AMO listing/u);
});

test("a dry run reports the dispatch without writing, and dispatching requires a token", async () => {
  const w = world();
  const logs = [];
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, dryRun: true, log: line => logs.push(line) });
  assert.equal(plan.action, "dispatch");
  assert.equal(w.posts().length, 0);
  assert(logs.some(line => line.startsWith("Would dispatch Publish release for v1.1.4")));
  await assert.rejects(() => new GitHubClient("Quince-Pie/tab-gantry", undefined, w.fetchImpl).dispatch("v1.1.4"), /requires GH_TOKEN/u);
  await assert.rejects(() => w.github.dispatch("v1.1"), /stable vMAJOR/u);
});

test("unrelated newer dispatches cannot reset a tag's automatic attempt count", async () => {
  const dispatched = [...Array.from({ length: 997 }, (_, i) => run(`Publish release v2.0.${i}`)),
    run("Publish release v1.1.4"), run("Publish release v1.1.4", "github-actions[bot]", "Quince-Pie")];
  const w = world({ dispatched });
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
  assert.equal(plan.action, "attention");
  assert.match(plan.attention[0], /2 automatic/u);
  assert.equal(w.posts().length, 0);
  const pages = w.requests.filter(request => request.url.searchParams.has("event"));
  assert.deepEqual(pages.map(request => request.url.searchParams.get("page")), Array.from({ length: 10 }, (_, i) => String(i + 1)));
});

test("incomplete, changing or repeated history needs attention without a dispatch", async () => {
  for (const overrides of [
    { historyPage: () => ({ total_count: 1000, workflow_runs: [] }) },
    { historyPage: () => ({ total_count: "2,500+", workflow_runs: [] }) },
    { historyPage: () => ({ total_count: 2, workflow_runs: [run("Publish release v1.1.4")] }) },
    { dispatched: Array.from({ length: 101 }, () => run("Publish release v2.0.0")), historyPage: (history, page) => ({ ...history, total_count: page === 1 ? 101 : 102 }) },
  ]) {
    const w = world(overrides);
    const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
    assert.equal(plan.action, "attention");
    assert.equal(plan.attention.length, 1);
    assert.equal(w.posts().length, 0);
  }
  const dispatched = Array.from({ length: 101 }, () => run("Publish release v2.0.0"));
  dispatched[100] = dispatched[0];
  const duplicate = world({ dispatched });
  const plan = await planResume({ github: duplicate.github, fetchImpl: duplicate.fetchImpl });
  assert.equal(plan.action, "attention");
  assert.match(plan.attention[0], /repeated a run/u);
});

test("malformed run identity or event fails rather than granting a fresh automatic attempt", async () => {
  for (const change of [{ id: undefined }, { event: "push" }, { actor: null }, { display_title: null }]) {
    const w = world({ historyPage: () => ({ total_count: 1, workflow_runs: [{ ...run("Publish release v1.1.4"), ...change }] }) });
    await assert.rejects(() => runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} }), /workflow run/u);
    assert.equal(w.posts().length, 0);
  }
});

test("old superseded tags do not block automatic publication of approved oldest or newest versions", async () => {
  const tags = Array.from({ length: 120 }, (_, i) => `v1.0.${i}`);
  const w = world({ tags, releases: [], versions: { "1.0.0": "public", "1.0.119": "public" } });
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
  assert.equal(plan.action, "dispatch");
  assert.equal(plan.tag, "v1.0.0");
  assert.deepEqual(plan.attention, []);
  assert.equal(w.requests.filter(request => request.url.hostname === "addons.mozilla.org").length, 2, "one listing and one public-history page, independent of 120 unpublished tags");
  const newer = world({ tags, releases: [], versions: { "1.0.119": "public" } });
  assert.equal((await planResume({ github: newer.github, fetchImpl: newer.fetchImpl })).tag, "v1.0.119");
});

test("public history covers all pages and stops early only when every candidate is found", async () => {
  const versions = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`1.0.${i}`, "public"]));
  const w = world({ tags: ["v1.0.0", "v1.0.119", "v2.0.0", "v3.0.0", "v4.0.0"], releases: [], versions });
  const plan = await planResume({ github: w.github, fetchImpl: w.fetchImpl });
  assert.equal(plan.tag, "v1.0.0");
  assert.equal(w.requests.filter(request => request.url.pathname.endsWith("/versions/")).length, 3);
  const found = world({ tags: ["v1.0.0", "v1.0.1"], releases: [], versions });
  assert.equal((await planResume({ github: found.github, fetchImpl: found.fetchImpl })).tag, "v1.0.0");
  assert.equal(found.requests.filter(request => request.url.pathname.endsWith("/versions/")).length, 1);
  const noncanonical = world({ tags: ["v1.0.0", "v2.0.0"], releases: [], versions: { "1.0b1": "public", "1.0.0": "public" } });
  assert.equal((await planResume({ github: noncanonical.github, fetchImpl: noncanonical.fetchImpl })).tag, "v1.0.0");
});

test("AMO pagination cannot change destination, filtering, page order or page size", async () => {
  const base = "https://addons.mozilla.org/api/v5/addons/addon/stackma%40extensions.local/versions/";
  for (const next of [
    `${base.replace("https:", "http:")}?page=2&page_size=50`,
    "https://example.invalid/api/v5/addons/addon/stackma%40extensions.local/versions/?page=2&page_size=50",
    `${base.replace("addons.mozilla.org", "user:password@addons.mozilla.org")}?page=2&page_size=50`,
    `${base.replace("stackma%40extensions.local", "other")}?page=2&page_size=50`,
    `${base}?page=2&page_size=50&filter=all_without_unlisted`,
    `${base}?page=2&page=2&page_size=50`,
    `${base}?page=1&page_size=50`, `${base}?page=2&page_size=25`, `${base}?page=2&page_size=50#fragment`,
  ]) {
    const w = world({ versionPage: history => ({ ...history, next }) });
    await assert.rejects(() => planResume({ github: w.github, fetchImpl: w.fetchImpl }), /AMO (pagination|next)/u);
    assert.equal(w.requests.filter(request => request.url.pathname.endsWith("/versions/")).length, 1);
    assert.equal(w.posts().length, 0);
  }
});

test("a public-list channel or status contradiction and malformed version fields fail", async () => {
  for (const change of [{ channel: "unlisted" }, { file: { status: "unreviewed" } }, { file: null }, { id: 0 }, { version: null }, { version: "x".repeat(256) }]) {
    const w = world({ versionPage: history => ({ ...history, results: [{ ...history.results[0], ...change }] }) });
    await assert.rejects(() => planResume({ github: w.github, fetchImpl: w.fetchImpl }), /AMO (version|public version)/u);
    assert.equal(w.posts().length, 0);
  }
});

test("incomplete or changing AMO pagination does not dispatch a partially observed candidate", async () => {
  const versions = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`1.0.${i}`, "public"]));
  for (const versionPage of [
    history => ({ ...history, count: history.count + 1, next: null }),
    (history, page) => ({ ...history, count: history.count + (page === 2 ? 1 : 0) }),
    (history, page) => page === 1 ? history : { ...history, results: [{ id: 1, version: "1.0.0", channel: "listed", file: { status: "public" } }] },
  ]) {
    const w = world({ tags: ["v1.0.0", "v2.0.0", "v3.0.0"], releases: [], versions, versionPage });
    const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
    assert.equal(plan.action, "attention");
    assert.equal(w.posts().length, 0);
  }
});

test("AMO read bound is explicit when candidates remain unresolved at the limit", async () => {
  const versions = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`1.0.${i}`, "public"]));
  const w = world({ tags: Array.from({ length: 120 }, (_, i) => `v2.0.${i}`), releases: [], versions });
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
  assert.equal(plan.action, "attention");
  assert.match(plan.attention[0], /100-read/u);
  assert.equal(w.requests.filter(request => request.url.pathname.endsWith("/versions/")).length, 100);
  assert.equal(w.posts().length, 0);
  const found = world({ tags: ["v1.0.0"], releases: [], versions });
  assert.equal((await planResume({ github: found.github, fetchImpl: found.fetchImpl })).action, "dispatch");
  assert.equal(found.requests.filter(request => request.url.hostname === "addons.mozilla.org").length, 2);
});

test("adaptive approval lookup matches the independent ready-set oracle and request costs", async () => {
  const cases = [
    { publicCount: 5001, candidates: ["1.0.5000"], reads: 2, pages: 0 },
    { publicCount: 5001, candidates: ["2.0.0"], reads: 2, pages: 0 },
    { publicCount: 2, candidates: Array.from({ length: 120 }, (_, i) => `1.0.${i}`), reads: 2, pages: 1 },
    { publicCount: 200, candidates: ["1.0.198", "1.0.199"], reads: 4, pages: 1 },
    { publicCount: 200, candidates: ["1.0.0", "1.0.199"], reads: 3, pages: 1 },
    { publicCount: 120, candidates: ["1.0.119", "2.0.0"], reads: 4, pages: 1 },
    { publicCount: 51, candidates: ["1.0.50", "2.0.0", "3.0.0"], reads: 3, pages: 2 },
  ];
  for (const { publicCount, candidates, reads, pages } of cases) {
    const versions = Object.fromEntries(Array.from({ length: publicCount }, (_, i) => [`1.0.${i}`, "public"]));
    const w = world({ versions });
    const expected = new Set(candidates.filter(version => versions[version] === "public"));
    assert.deepEqual(await approvedVersions(candidates, w.fetchImpl), expected);
    assert.equal(w.requests.filter(request => request.url.hostname === "addons.mozilla.org").length, reads);
    assert.equal(w.requests.filter(request => request.url.pathname.endsWith("/versions/")).length, pages);
    assert.equal(w.posts().length, 0);
  }
});

test("point reads observe later approval and never dispatch after an ambiguous final read", async () => {
  const versions = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`1.0.${i}`, "public"]));
  const detail = (version, status) => Response.json({ id: version === "2.0.0" ? 201 : 202, version, channel: "listed", file: { status } });
  const changed = world({ versions, versionDetail: version => detail(version, version === "2.0.0" ? "public" : "disabled") });
  assert.deepEqual(await approvedVersions(["2.0.0", "2.0.1"], changed.fetchImpl), new Set(["2.0.0"]));
  let calls = 0;
  const ambiguous = world({ tags: ["v2.0.0", "v2.0.1"], releases: [], versions, versionDetail: version => {
    if (++calls === 1) return detail(version, "public");
    return new Response(null, { status: 503 });
  } });
  const plan = await runResume({ github: ambiguous.github, fetchImpl: ambiguous.fetchImpl, log: () => {} });
  assert.equal(calls, 2);
  assert.equal(plan.action, "retry-later");
  assert.equal(ambiguous.posts().length, 0);
});

test("single-version readiness validates returned identity, channel and status", async () => {
  for (const change of [{ version: "3.0.0" }, { channel: "unlisted" }, { file: { status: "unknown" } }, { id: null }]) {
    const w = world({ versionDetail: version => Response.json({ id: 1, version, channel: "listed", file: { status: "public" }, ...change }) });
    await assert.rejects(() => approvedVersions(["2.0.0"], w.fetchImpl), /AMO version/u);
    assert.equal(w.posts().length, 0);
  }
});

test("human dispatches do not consume the automatic-history search bound", async () => {
  const dispatched = [...Array.from({ length: 1500 }, () => run("Publish release v1.1.4", "Quince-Pie")), run("Publish release v1.1.4")];
  const w = world({ dispatched });
  const plan = await planResume({ github: w.github, fetchImpl: w.fetchImpl });
  assert.equal(plan.action, "dispatch");
  assert.equal(plan.attempts, 1);
  const history = w.requests.filter(request => request.url.searchParams.has("event"));
  assert.equal(history.length, 1);
  assert.equal(history[0].url.searchParams.get("actor"), "github-actions[bot]");
});

const ownedRelease = tag => ({ tag_name: tag, draft: false,
  body: `<!-- tab-gantry-release:${tag}:${"a".repeat(40)}:${"b".repeat(64)}:${"c".repeat(64)} -->` });
const gateJob = (run, conclusion = "success", completed = run.updated_at) => ({
  run_id: run.id, name: "Publish the verified signed release", status: "completed", conclusion: "failure",
  steps: [{ name: "Reconcile, publish and verify the immutable release", status: "completed", conclusion, completed_at: completed }],
});

test("a published release with a failed final gate or lost publish reply gets the remaining automatic attempt", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const failed = { ...run("Publish release v1.1.4"), conclusion };
    const w = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], versions: {}, dispatched: [failed],
      jobs: { [`${failed.id}:1`]: [gateJob(failed, "failure")] } });
    const dry = await runResume({ github: w.github, fetchImpl: w.fetchImpl, dryRun: true, log: () => {} });
    assert.equal(dry.action, "dispatch");
    assert.equal(dry.published, true);
    assert.equal(dry.attempts, 1);
    assert.equal(w.posts().length, 0);
    assert.equal(w.requests.filter(request => request.url.hostname === "addons.mozilla.org").length, 0);
    const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
    assert.equal(plan.published, true);
    assert.equal(w.posts().length, 1);
  }
});

test("a second incomplete publication reports the run without deleting or recreating the release", async () => {
  const first = run("Publish release v1.1.4"), last = run("Publish release v1.1.4");
  const w = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [last, first] });
  const plan = await runResume({ github: w.github, fetchImpl: w.fetchImpl, log: () => {} });
  assert.equal(plan.action, "attention");
  assert.match(plan.attention[0], /publication exists.*final verification is incomplete/u);
  assert(plan.attention[0].includes(`/actions/runs/${last.id}`));
  assert.equal(w.posts().length, 0);
  assert(w.requests.every(request => request.method === "GET"));
});

test("successful mandatory verification clears a diagnostics failure but green skipped publication does not", async () => {
  const failed = run("Publish release v1.1.4");
  const diagnostic = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [failed],
    jobs: { [`${failed.id}:1`]: [gateJob(failed)] } });
  assert.equal((await planResume({ github: diagnostic.github, fetchImpl: diagnostic.fetchImpl })).action, "none");
  const green = { ...run("Publish release v1.1.4"), conclusion: "success" };
  const skipped = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [green, failed],
    jobs: { [`${green.id}:1`]: [gateJob(green, "skipped")] } });
  assert.equal((await planResume({ github: skipped.github, fetchImpl: skipped.fetchImpl })).action, "attention");
  const recovered = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [green, failed],
    jobs: { [`${green.id}:1`]: [gateJob(green)] } });
  assert.equal((await planResume({ github: recovered.github, fetchImpl: recovered.fetchImpl })).action, "none");
  assert(!recovered.requests.some(request => request.url.searchParams.has("created")), "successful bot recovery needs no all-actor history query");
});

test("a human rerun is checked at its exact current attempt, including a green awaiting-review rerun", async () => {
  const rerun = { ...run("Publish release v1.1.4", "github-actions[bot]", "Quince-Pie"), conclusion: "success", run_attempt: 2 };
  for (const conclusion of ["success", "skipped"]) {
    const w = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [rerun],
      jobs: { [`${rerun.id}:1`]: [gateJob(rerun, "failure")], [`${rerun.id}:2`]: [gateJob(rerun, conclusion)] } });
    const plan = await planResume({ github: w.github, fetchImpl: w.fetchImpl });
    assert.equal(plan.action, conclusion === "success" ? "none" : "dispatch");
    assert(w.requests.some(request => request.url.pathname.includes(`/attempts/2/jobs`)));
    assert(!w.requests.some(request => request.url.pathname.includes(`/attempts/1/jobs`)));
  }
});

test("a later human dispatch clears a failed bot publication only through a later successful gate", async () => {
  const failed = run("Publish release v1.1.4"), human = { ...run("Publish release v1.1.4", "Quince-Pie"), conclusion: "success" };
  for (const completed of [human.updated_at, failed.updated_at]) {
    const w = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [human, failed],
      jobs: { [`${human.id}:1`]: [gateJob(human, "success", completed)] } });
    const plan = await planResume({ github: w.github, fetchImpl: w.fetchImpl });
    assert.equal(plan.action, completed === human.updated_at ? "none" : "dispatch", "equal timestamps do not establish later verification");
    const query = w.requests.find(request => request.url.searchParams.has("created"));
    assert.equal(query.url.searchParams.get("created"), `>=${failed.created_at}`);
  }
});

test("healthy first publications do not reread jobs and missing retained verification reports uncertainty", async () => {
  const healthy = { ...run("Publish release v1.1.4"), conclusion: "success" };
  const w = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [healthy] });
  assert.equal((await planResume({ github: w.github, fetchImpl: w.fetchImpl })).action, "none");
  assert(!w.requests.some(request => request.url.pathname.endsWith("/jobs")));
  const failed = { ...run("Publish release v1.1.4"), conclusion: "cancelled" };
  const missing = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")], dispatched: [failed], jobs: { [`${failed.id}:1`]: null } });
  const plan = await planResume({ github: missing.github, fetchImpl: missing.fetchImpl });
  assert.equal(plan.action, "attention");
  assert.match(plan.attention[0], /missing or incomplete/u);
  assert.equal(missing.posts().length, 0);
});

test("published verification and human recovery searches retain explicit bounds", async () => {
  const tags = Array.from({ length: 51 }, (_, i) => `v1.0.${i}`);
  const w = world({ tags, releases: tags.map(ownedRelease), dispatched: tags.map(tag => run(`Publish release ${tag}`)) });
  const plan = await planResume({ github: w.github, fetchImpl: w.fetchImpl });
  assert.equal(plan.action, "attention");
  assert.match(plan.attention[0], /50-job-history-read/u);
  assert.equal(w.requests.filter(request => request.url.pathname.endsWith("/jobs")).length, 50);
  assert.equal(w.posts().length, 0);
  const failed = run("Publish release v1.1.4");
  const busy = world({ tags: ["v1.1.4"], releases: [ownedRelease("v1.1.4")],
    dispatched: [failed, ...Array.from({ length: 1000 }, () => run("Publish release v1.1.4", "Quince-Pie"))] });
  const uncertain = await planResume({ github: busy.github, fetchImpl: busy.fetchImpl });
  assert.equal(uncertain.action, "attention");
  assert.match(uncertain.attention[0], /1000-run search bound/u);
  assert.equal(busy.posts().length, 0);
});

test("a lost dispatch acknowledgement is not retried before activity is reconciled", async () => {
  for (const failure of ["transport", "server"]) {
    const w = world();
    const fetchImpl = async (url, options) => {
      const response = await w.fetchImpl(url, options);
      if (options?.method === "POST") {
        w.state.dispatched.unshift(run("Publish release v1.1.4"));
        w.state.active.queued = 1;
        if (failure === "transport") throw new TypeError("acknowledgement lost");
        return new Response(null, { status: 502 });
      }
      return response;
    };
    const github = new GitHubClient("Quince-Pie/tab-gantry", "workflow-token", fetchImpl);
    const first = await runResume({ github, fetchImpl, log: () => {} });
    assert.equal(first.action, "retry-later");
    assert.equal(w.posts().length, 1);
    const next = await runResume({ github, fetchImpl, log: () => {} });
    assert.equal(next.action, "wait");
    assert.equal(w.posts().length, 1);
  }
});

test("GitHub response bodies are bounded without relying on Content-Length", async () => {
  for (const headers of [{ "Content-Length": "64" }, {}]) {
    let cancelled = false;
    const fetchImpl = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(" ".repeat(64))); },
      cancel() { cancelled = true; },
    }), { headers });
    const github = new GitHubClient("Quince-Pie/tab-gantry", undefined, fetchImpl, { responseBytes: 32 });
    await assert.rejects(() => github.get("releases"), /32-byte response bound/u);
    assert(cancelled);
  }
});

test("a stalled dispatch response body times out and the next run reconciles accepted activity", async () => {
  const w = world();
  let cancelled = false;
  const fetchImpl = async (url, options) => {
    const response = await w.fetchImpl(url, options);
    if (options?.method === "POST") {
      w.state.dispatched.unshift(run("Publish release v1.1.4"));
      w.state.active.requested = 1;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    }
    return response;
  };
  const github = new GitHubClient("Quince-Pie/tab-gantry", "workflow-token", fetchImpl, { timeoutMs: 20 });
  // AbortSignal.timeout is unref'ed; keep the isolated test process alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const first = await runResume({ github, fetchImpl, log: () => {} });
    assert.equal(first.action, "retry-later");
    assert(cancelled);
    assert.equal(w.posts().length, 1);
    assert.equal((await runResume({ github, fetchImpl, log: () => {} })).action, "wait");
    assert.equal(w.posts().length, 1);
  } finally { clearTimeout(keepAlive); }
});

test("an already-expired deadline rejects cleanly before reading JSON", async () => {
  const fetchImpl = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ message: "late headers" });
  };
  const github = new GitHubClient("Quince-Pie/tab-gantry", undefined, fetchImpl, { timeoutMs: 1 });
  await assert.rejects(() => github.get("releases"), /body timed out/u);
});
