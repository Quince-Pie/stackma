import assert from "node:assert/strict";
import test from "node:test";
import { AdminClient, environments, inspect, matchesRef, releaseEventPolicy, rulesets, runPolicy } from "../../scripts/release/repository-policy.js";

// A model of the repository administration endpoints the policy reads and writes.
function world(overrides = {}) {
  const state = {
    rulesets: [], actionsPolicies: [], nextId: 10,
    environments: { "release-signing": { deployment_branch_policy: null, protection_rules: [] } },
    policies: { "release-signing": [] },
    immutable: false, workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: true },
    status: {},
    ...overrides,
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url), method = options.method;
    const path = target.pathname.replace("/repos/Quince-Pie/stackma", "");
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({ method, path, body, auth: options.headers.Authorization, redirect: options.redirect });
    assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10");
    if (state.status[`${method} ${path}`]) return new Response("denied", { status: state.status[`${method} ${path}`] });
    let match;
    if (path === "/rulesets" && method === "GET") return Response.json(state.rulesets.map(({ id, name, source_type }) => ({ id, name, source_type })));
    if (path === "/rulesets" && method === "POST") { const created = { ...body, id: state.nextId++, source_type: "Repository" }; state.rulesets.push(created); return Response.json(created, { status: 201 }); }
    if ((match = /^\/rulesets\/(\d+)$/u.exec(path))) {
      const index = state.rulesets.findIndex(entry => entry.id === Number(match[1]));
      if (method === "GET") return Response.json(state.rulesets[index]);
      if (method === "PUT") { state.rulesets[index] = { ...body, id: state.rulesets[index].id, source_type: "Repository" }; return Response.json(state.rulesets[index]); }
    }
    if ((match = /^\/environments\/([^/]+)$/u.exec(path))) {
      const name = decodeURIComponent(match[1]);
      if (method === "GET") return state.environments[name] ? Response.json({ name, ...state.environments[name] }) : new Response(null, { status: 404 });
      if (method === "PUT") {
        const rules = [];
        if (body.wait_timer) rules.push({ type: "wait_timer", wait_timer: body.wait_timer });
        if (body.reviewers) rules.push({ type: "required_reviewers", prevent_self_review: body.prevent_self_review, reviewers: body.reviewers.map(entry => ({ type: entry.type, reviewer: { id: entry.id } })) });
        state.environments[name] = { deployment_branch_policy: body.deployment_branch_policy, protection_rules: rules };
        state.policies[name] ??= [];
        return Response.json({ name, ...state.environments[name] });
      }
    }
    if ((match = /^\/environments\/([^/]+)\/deployment-branch-policies$/u.exec(path))) {
      const name = decodeURIComponent(match[1]);
      // Observed: 404 while custom branch policies are off; POST also needs them on.
      if (state.environments[name]?.deployment_branch_policy?.custom_branch_policies !== true) return new Response(null, { status: 404 });
      if (method === "GET") return Response.json({ total_count: state.policies[name].length, branch_policies: state.policies[name] });
      if (method === "POST") {
        if (state.policies[name].some(policy => policy.name === body.name && policy.type === body.type)) return new Response(null, { status: 303, headers: { location: "https://api.github.com/elsewhere" } });
        state.policies[name].push({ id: 1, ...body }); return Response.json({ id: 1, ...body });
      }
    }
    if (path === "/immutable-releases" && method === "GET") return state.immutable ? Response.json({ enabled: true, enforced_by_owner: false }) : new Response(null, { status: 404 });
    if (path === "/immutable-releases" && method === "PUT") { state.immutable = true; return new Response(null, { status: 204 }); }
    if (path === "/actions/permissions/workflow" && method === "GET") return Response.json(state.workflow);
    if (path === "/actions/permissions/workflow" && method === "PUT") { state.workflow = body; return new Response(null, { status: 204 }); }
    if (path === "/actions/policies" && method === "GET") return Response.json({ total_count: state.actionsPolicies.length,
      policies: state.actionsPolicies.map(({ id, name, source_type, enforcement }) => ({ id, name, source_type, enforcement })) });
    if (path === "/actions/policies" && method === "POST") {
      const policy = { ...body, id: state.nextId++, source_type: "Repository" }; state.actionsPolicies.push(policy);
      return Response.json(policy, { status: 201 });
    }
    if ((match = /^\/actions\/policies\/(\d+)$/u.exec(path))) {
      const index = state.actionsPolicies.findIndex(p => p.id === Number(match[1]));
      if (method === "GET") return Response.json(state.actionsPolicies[index]);
      if (method === "PUT") { state.actionsPolicies[index] = { ...body, id: Number(match[1]), source_type: "Repository" }; return Response.json(state.actionsPolicies[index]); }
    }
    return assert.fail(`Unexpected ${method} ${path}`);
  };
  return { state, requests, client: new AdminClient("Quince-Pie/stackma", "admin-token", fetchImpl), writes: () => requests.filter(request => request.method !== "GET") };
}

test("checking is read-only and reports every missing or weaker setting", async () => {
  const w = world();
  const logs = [];
  assert.equal(await runPolicy({ client: w.client, log: line => logs.push(line) }), false);
  assert.equal(w.writes().length, 0);
  assert.deepEqual(logs.map(line => line.split(" ")[0]), ["MISSING", "MISSING", "DRIFT", "MISSING", "MISSING", "DRIFT", "OK", "MISSING"]);
  assert(w.requests.every(request => request.auth === "Bearer admin-token" && request.redirect === "manual"));
});

test("applying creates the declared rulesets, branch policies and immutability, then verifies them", async () => {
  const w = world();
  assert.equal(await runPolicy({ client: w.client, apply: true, log: () => {} }), true);
  const created = w.state.rulesets.map(({ name, target, enforcement, bypass_actors, conditions, rules }) => ({ name, target, enforcement, bypass_actors, conditions, rules }));
  assert.deepEqual(created, rulesets);
  for (const name of environments) {
    assert.deepEqual(w.state.environments[name].deployment_branch_policy, { protected_branches: false, custom_branch_policies: true });
    assert.deepEqual(w.state.policies[name].map(({ name: branch, type }) => ({ branch, type })), [{ branch: "main", type: "branch" }]);
  }
  assert.equal(w.state.immutable, true);
  assert.deepEqual(w.state.actionsPolicies.map(({ id: _id, source_type: _source, ...policy }) => policy), [releaseEventPolicy]);
  assert(!w.requests.some(request => request.method === "DELETE"));
  const again = world({ ...w.state, status: {} });
  assert.equal(await runPolicy({ client: again.client, apply: true, log: () => {} }), true);
  assert.equal(again.writes().length, 0, "a compliant repository needs no writes");
});

test("an existing identical branch policy answered with 303 is accepted and verified", async () => {
  const w = world({ environments: { "release-signing": { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [] } },
    policies: { "release-signing": [{ id: 1, name: "main", type: "branch" }] } });
  assert.deepEqual(await w.client.request("POST", "/environments/release-signing/deployment-branch-policies", { name: "main", type: "branch" }), {});
  assert.equal(await runPolicy({ client: w.client, log: () => {} }), false, "other settings still differ");
  const redirected = world({ status: { "POST /rulesets": 303 } });
  await assert.rejects(() => redirected.client.request("POST", "/rulesets", rulesets[0]), /POST \/rulesets returned HTTP 303/u);
});

test("the release event exception is narrowly scoped and preserves other policy restrictions", async () => {
  const actor = { type: "restrict_actions_actors", parameters: { allowed_actors: [{ id: 1, type: "User" }] } };
  const own = { ...releaseEventPolicy, id: 50, source_type: "Repository", enforcement: "disabled",
    rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["workflow_dispatch"] } }, actor] };
  const other = { name: "another policy", id: 51, source_type: "Repository", enforcement: "active", conditions: {},
    rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["push"] } }] };
  const inherited = { name: "parent policy", id: 52, source_type: "Organization", enforcement: "active" };
  const w = world({ actionsPolicies: [own, other, inherited] });
  assert.equal(await runPolicy({ client: w.client, apply: true, log: () => {} }), false);
  assert.deepEqual(w.state.actionsPolicies[0].conditions, releaseEventPolicy.conditions);
  assert.deepEqual(w.state.actionsPolicies[0].rules, [...releaseEventPolicy.rules, actor]);
  assert.deepEqual(w.state.actionsPolicies[1], other);
  assert.deepEqual(w.state.actionsPolicies[2], inherited);
  const findings = await inspect(w.client);
  assert(findings.some(f => f.item.includes("another policy") && f.writes.length === 0));
  assert(findings.some(f => f.item.includes("parent policy") && f.writes.length === 0));
  const wrongScope = world({ actionsPolicies: [{ ...own, conditions: {}, enforcement: "active" }] });
  const finding = (await inspect(wrongScope.client)).find(f => f.item === "release workflow events");
  assert.equal(finding.status, "drift"); assert.deepEqual(finding.writes, [], "Do not move unrelated actor restrictions to a narrower scope automatically");
});

test("changing an environment's branch policy keeps its reviewers and wait timer", async () => {
  const reviewers = { type: "required_reviewers", prevent_self_review: true, reviewers: [{ type: "User", reviewer: { id: 7, login: "maintainer" } }] };
  const w = world({ environments: { "release-signing": { deployment_branch_policy: null, protection_rules: [{ type: "wait_timer", wait_timer: 5 }, reviewers] } } });
  await runPolicy({ client: w.client, apply: true, log: () => {} });
  const put = w.requests.find(request => request.method === "PUT" && request.path === "/environments/release-signing");
  assert.deepEqual(put.body, { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, wait_timer: 5, prevent_self_review: true, reviewers: [{ type: "User", id: 7 }] });
});

test("a drifted ruleset is restored, keeping extra rules but dropping a tag creation rule, and extra deploy policies are only reported", async () => {
  const drifted = { id: 3, name: "Stackma release tags", source_type: "Repository", target: "tag", enforcement: "evaluate",
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } }, rules: [{ type: "deletion" }, { type: "creation" }, { type: "required_signatures" }] };
  const w = world({ rulesets: [drifted], policies: { "release-signing": [{ id: 2, name: "release/*", type: "branch" }] },
    environments: { "release-signing": { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [] } } });
  const findings = await inspect(w.client);
  assert.match(findings[0].detail, /enforcement evaluate; 1 bypass actor\(s\); missing rules update; a creation rule stops Publish release from creating tags/u);
  const logs = [];
  assert.equal(await runPolicy({ client: w.client, apply: true, log: line => logs.push(line) }), false);
  const restored = w.state.rulesets.find(entry => entry.id === 3);
  assert.equal(restored.enforcement, "active");
  assert.deepEqual(restored.bypass_actors, []);
  assert.deepEqual(restored.rules.map(rule => rule.type).sort(), ["deletion", "required_signatures", "update"]);
  assert.deepEqual(w.state.policies["release-signing"].map(policy => policy.name).sort(), ["main", "release/*"]);
  assert(logs.some(line => /extra deployment policies release\/\* \(remove them manually\)/u.test(line)));
});

test("a compliant tag ruleset that only adds a creation rule is still drift", async () => {
  const w = world({ rulesets: [{ ...rulesets[0], id: 4, source_type: "Repository", rules: [...rulesets[0].rules, { type: "creation" }] }] });
  const [tags] = await inspect(w.client);
  assert.equal(tags.status, "drift");
  assert.deepEqual(tags.writes[0][2].rules, rulesets[0].rules);
});

test("other active rulesets that block the workflows' tag or branch creation are reported, never changed", async () => {
  const other = (id, target, include, extra = {}) => ({ id, name: `other ${id}`, source_type: "Repository", target, enforcement: "active",
    bypass_actors: [], conditions: { ref_name: { include, exclude: [] } }, rules: [{ type: "creation" }], ...extra });
  const w = world({ rulesets: [
    other(21, "tag", ["refs/tags/v*"]), other(22, "tag", ["~ALL"]), other(23, "branch", ["refs/heads/release/**"]),
    other(24, "tag", ["refs/tags/w*"]), other(25, "tag", ["refs/tags/v*"], { enforcement: "evaluate" }),
    other(26, "tag", ["~ALL"], { conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/tags/v*"] } } }),
    other(27, "branch", ["~DEFAULT_BRANCH"]), other(28, "tag", ["refs/tags/v*"], { rules: [{ type: "deletion" }] }),
  ] });
  const findings = await inspect(w.client);
  const reported = findings.filter(finding => finding.item.startsWith("ruleset \"other"));
  assert.deepEqual(reported.map(finding => finding.item), ['ruleset "other 21"', 'ruleset "other 22"', 'ruleset "other 23"']);
  assert(reported.every(finding => finding.status === "drift" && finding.writes.length === 0));
  assert.match(reported[2].detail, /release\/v\* branches/u);
});

test("ruleset patterns follow fnmatch segments", () => {
  for (const [pattern, ref, expected] of [["refs/tags/v*", "refs/tags/v1.2.3", true], ["refs/tags/v*", "refs/tags/v1/extra", false], ["refs/tags/v*", "refs/tags/nested/v1", false],
    ["refs/tags/**", "refs/tags/nested/v1", true], ["refs/tags/v?.*", "refs/tags/v1.2.3", true], ["refs/tags/v1.2.?", "refs/tags/v1.2.3", true],
    ["refs/tags/v[0-9]*", "refs/tags/v1.2.3", true], ["refs/tags/v[!0-9]*", "refs/tags/v1.2.3", false], ["refs/tags/v1.2.3", "refs/tags/v1x2x3", false],
    ["~ALL", "refs/tags/v1.2.3", true], ["~DEFAULT_BRANCH", "refs/heads/release/v1.2.3", false]]) {
    assert.equal(matchesRef(pattern, ref), expected, `${pattern} vs ${ref}`);
  }
});

test("disabled pull-request creation is restored without changing default token permissions", async () => {
  const w = world({ workflow: { default_workflow_permissions: "write", can_approve_pull_request_reviews: false } });
  await runPolicy({ client: w.client, apply: true, log: () => {} });
  assert.deepEqual(w.state.workflow, { default_workflow_permissions: "write", can_approve_pull_request_reviews: true });
});

test("missing administrator rights stop with a clear message, and a token is required", async () => {
  const w = world({ status: { "GET /rulesets": 403 } });
  await assert.rejects(() => runPolicy({ client: w.client, log: () => {} }), /HTTP 403; use a token of a repository administrator/u);
  assert.throws(() => new AdminClient("Quince-Pie/stackma", ""), /administrator token is required/u);
  const duplicate = world({ rulesets: [{ ...rulesets[0], id: 1, source_type: "Repository" }, { ...rulesets[0], id: 2, source_type: "Repository" }] });
  await assert.rejects(() => inspect(duplicate.client), /Several rulesets are named/u);
});

test("malformed settings replies never echo private response bodies", async () => {
  const client = new AdminClient("Quince-Pie/stackma", "fixture-token", async () => new Response("synthetic-private-response"));
  await assert.rejects(() => client.request("GET", "/rulesets"), error => /unreadable JSON/u.test(error.message) && !String(error.stack).includes("synthetic-private"));
});
