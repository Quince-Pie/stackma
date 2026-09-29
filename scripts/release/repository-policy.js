import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Repository settings that the release guide assumes. Checking is read-only;
// --apply creates or updates only these items and never deletes anything.
export const rulesets = [
  // Releases resolve tags by name and require them never to move. Creation stays
  // open: Publish release creates each tag with GITHUB_TOKEN after verification.
  { name: "Stackma release tags", target: "tag", enforcement: "active", bypass_actors: [],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "update" }] },
  // Release resolution relies on merged history. Ordinary pushes stay allowed.
  { name: "Stackma main history", target: "branch", enforcement: "active", bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }] },
];
export const environments = ["release-signing", "release-publication", "release-chrome-web-store"];
export const releaseEventPolicy = {
  name: "Stackma release workflow events", enforcement: "active",
  conditions: { workflow_path: { include: [".github/workflows/release.yml"], exclude: [] } },
  rules: [{ type: "restrict_action_events", parameters: { allowed_events: ["pull_request_target", "workflow_dispatch"] } }],
};
const branchPolicy = { protected_branches: false, custom_branch_policies: true };
// Refs the workflows create with GITHUB_TOKEN, which cannot bypass rulesets on a
// user-owned repository: Release creates release/v* branches, Publish release v* tags.
const createdRefs = { branch: "refs/heads/release/v1.2.3", tag: "refs/tags/v1.2.3" };

// Ruleset ref patterns are fnmatch-style: * and ? stay within one path segment,
// ** crosses segments, and ~ALL matches every ref of the ruleset's target.
export function matchesRef(pattern, ref) {
  if (pattern === "~ALL") return true;
  if (pattern.startsWith("~")) return false;
  const source = pattern.replace(/[.+^${}()|\\]/gu, "\\$&").replace(/\[!/gu, "[^")
    .replace(/\*\*|\*|\?/gu, token => token === "**" ? ".*" : token === "*" ? "[^/]*" : "[^/]");
  return new RegExp(`^${source}$`, "u").test(ref);
}

function blocksCreation(ruleset) {
  const ref = createdRefs[ruleset.target];
  const refs = ruleset.conditions?.ref_name;
  return ruleset.enforcement === "active" && ref !== undefined && (ruleset.rules ?? []).some(rule => rule.type === "creation") &&
    (refs?.include ?? []).some(pattern => matchesRef(pattern, ref)) && !(refs?.exclude ?? []).some(pattern => matchesRef(pattern, ref));
}

export class AdminClient {
  constructor(repository, token, fetchImpl = fetch) {
    assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert(token, "A repository administrator token is required (GH_TOKEN, or gh auth login)");
    this.repository = repository;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  async request(method, path, body) {
    // Never follow a redirect with the token; report its status instead.
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}${path}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 404 && method === "GET") { await response.body?.cancel(); return null; }
    // GitHub answers 303 when an identical deployment branch policy already exists.
    if (response.status === 303 && method === "POST" && path.endsWith("/deployment-branch-policies")) { await response.body?.cancel(); return {}; }
    if (!response.ok) {
      await response.body?.cancel();
      const hint = [401, 403].includes(response.status) ? "; use a token of a repository administrator" : "";
      throw new Error(`${method} ${path} returned HTTP ${response.status}${hint}`);
    }
    if (response.status === 204) return {};
    try { return await response.json(); }
    catch { throw new Error("GitHub settings returned unreadable JSON; inspect the requested setting before retrying"); }
  }
}

const sorted = values => [...values].sort();
const ruleTypes = rules => sorted((rules ?? []).map(rule => rule.type));

function rulesetDrift(actual, desired) {
  const drift = [];
  if (actual.target !== desired.target) drift.push(`target ${actual.target}`);
  if (actual.enforcement !== desired.enforcement) drift.push(`enforcement ${actual.enforcement}`);
  if ((actual.bypass_actors ?? []).length > 0) drift.push(`${actual.bypass_actors.length} bypass actor(s)`);
  const refs = actual.conditions?.ref_name;
  if (JSON.stringify(sorted(refs?.include ?? [])) !== JSON.stringify(sorted(desired.conditions.ref_name.include)) || (refs?.exclude ?? []).length > 0) {
    drift.push(`refs ${JSON.stringify(refs ?? null)}`);
  }
  const missing = ruleTypes(desired.rules).filter(type => !ruleTypes(actual.rules).includes(type));
  if (missing.length > 0) drift.push(`missing rules ${missing.join(", ")}`);
  if (desired.target === "tag" && ruleTypes(actual.rules).includes("creation")) drift.push("a creation rule stops Publish release from creating tags");
  return drift;
}

// Keep existing reviewers, wait timer and self-review settings when changing
// only the deployment branch policy through the environment PUT endpoint.
function environmentBody(environment) {
  const body = { deployment_branch_policy: branchPolicy };
  for (const rule of environment?.protection_rules ?? []) {
    if (rule.type === "wait_timer") body.wait_timer = rule.wait_timer;
    if (rule.type === "required_reviewers") {
      body.prevent_self_review = Boolean(rule.prevent_self_review);
      body.reviewers = rule.reviewers.map(entry => ({ type: entry.type, id: entry.reviewer.id }));
    }
  }
  return body;
}

/** Read the current settings. Each finding carries the writes that --apply would make. */
export async function inspect(client) {
  const findings = [];
  const listed = await client.request("GET", "/rulesets?per_page=100");
  assert(Array.isArray(listed), "Cannot list repository rulesets");
  for (const desired of rulesets) {
    const matches = listed.filter(entry => entry.name === desired.name && entry.source_type === "Repository");
    assert(matches.length <= 1, `Several rulesets are named ${desired.name}; resolve them manually`);
    if (matches.length === 0) {
      findings.push({ item: `ruleset "${desired.name}"`, status: "missing", writes: [["POST", "/rulesets", desired]] });
      continue;
    }
    const actual = await client.request("GET", `/rulesets/${matches[0].id}`);
    const drift = rulesetDrift(actual, desired);
    // Restore the declared refs, enforcement and empty bypass list, and keep
    // other added rules, except a tag creation rule, which breaks releases.
    const extraRules = (actual.rules ?? []).filter(rule => !ruleTypes(desired.rules).includes(rule.type) &&
      !(desired.target === "tag" && rule.type === "creation"));
    findings.push({ item: `ruleset "${desired.name}"`, status: drift.length ? "drift" : "ok", detail: drift.join("; "),
      writes: drift.length ? [["PUT", `/rulesets/${matches[0].id}`, { ...desired, rules: [...desired.rules, ...extraRules] }]] : [] });
  }
  for (const summary of listed.filter(entry => entry.source_type === "Repository" && !rulesets.some(desired => desired.name === entry.name))) {
    const ruleset = await client.request("GET", `/rulesets/${summary.id}`);
    if (ruleset && blocksCreation(ruleset)) {
      findings.push({ item: `ruleset "${summary.name}"`, status: "drift", writes: [],
        detail: `restricts creating ${ruleset.target === "tag" ? "v* tags" : "release/v* branches"}, which the release workflows need; remove that rule manually` });
    }
  }
  for (const name of environments) {
    const environment = await client.request("GET", `/environments/${name}`);
    // GitHub answers 404 for this list while custom branch policies are off.
    const listing = environment ? await client.request("GET", `/environments/${name}/deployment-branch-policies?per_page=100`) : null;
    const policies = listing === null ? [] : listing.branch_policies;
    assert(Array.isArray(policies), "Cannot list deployment branch policies");
    const writes = [];
    const drift = [];
    if (!environment) drift.push("environment missing");
    if (JSON.stringify(environment?.deployment_branch_policy ?? null) !== JSON.stringify(branchPolicy)) {
      drift.push(`deployment branches ${JSON.stringify(environment?.deployment_branch_policy ?? null)}`);
      writes.push(["PUT", `/environments/${name}`, environmentBody(environment)]);
    }
    if (!policies.some(policy => policy.name === "main" && (policy.type ?? "branch") === "branch")) {
      drift.push("no main branch policy");
      writes.push(["POST", `/environments/${name}/deployment-branch-policies`, { name: "main", type: "branch" }]);
    }
    const extra = policies.filter(policy => !(policy.name === "main" && (policy.type ?? "branch") === "branch"));
    if (extra.length > 0) drift.push(`extra deployment policies ${extra.map(policy => policy.name).join(", ")} (remove them manually)`);
    findings.push({ item: `environment ${name}`, status: !environment ? "missing" : drift.length ? "drift" : "ok", detail: drift.join("; "), writes });
  }
  const immutable = await client.request("GET", "/immutable-releases");
  findings.push({ item: "immutable releases", status: immutable?.enabled === true ? "ok" : "drift",
    detail: immutable?.enabled === true ? "" : "disabled", writes: immutable?.enabled === true ? [] : [["PUT", "/immutable-releases"]] });
  const workflow = await client.request("GET", "/actions/permissions/workflow");
  assert(workflow && typeof workflow.can_approve_pull_request_reviews === "boolean", "Cannot read workflow permissions");
  findings.push({ item: "Actions may create pull requests", status: workflow.can_approve_pull_request_reviews ? "ok" : "drift",
    detail: workflow.can_approve_pull_request_reviews ? "" : "disabled; Release cannot open version PRs",
    writes: workflow.can_approve_pull_request_reviews ? [] : [["PUT", "/actions/permissions/workflow",
      { default_workflow_permissions: workflow.default_workflow_permissions, can_approve_pull_request_reviews: true }]] });
  // Public repositories require an explicit applicable target-event policy
  // when GitHub's default restriction becomes enforced on 2026-11-02.
  const policies = await client.request("GET", "/actions/policies?has_parents=true&per_page=100");
  assert(Array.isArray(policies?.policies) && Number.isSafeInteger(policies.total_count) &&
    policies.total_count === policies.policies.length && policies.total_count <= 100,
  "Cannot establish complete Actions event policy history");
  assert.equal(new Set(policies.policies.map(p => p.id)).size, policies.policies.length, "Duplicate Actions policy identity");
  const own = policies.policies.filter(p => p.source_type === "Repository" && p.name === releaseEventPolicy.name);
  assert(own.length <= 1, "Several release event policies exist; inspect them manually");
  if (own.length === 0) findings.push({ item: "release workflow events", status: "missing",
    writes: [["POST", "/actions/policies", releaseEventPolicy]] });
  for (const summary of policies.policies) {
    assert(Number.isSafeInteger(summary.id) && summary.id > 0, "Invalid Actions policy identity");
    if (summary.source_type !== "Repository") {
      findings.push({ item: `inherited Actions policy "${summary.name}"`, status: "drift", writes: [],
        detail: "requires administrator inspection; a repository allow cannot override a parent restriction" });
      continue;
    }
    const actual = await client.request("GET", `/actions/policies/${summary.id}`);
    assert(actual && Array.isArray(actual.rules), "Cannot read Actions policy");
    const extras = actual.rules.filter(rule => rule.type !== "restrict_action_events");
    if (summary.name === releaseEventPolicy.name) {
      const events = actual.rules.filter(rule => rule.type === "restrict_action_events");
      const paths = actual.conditions?.workflow_path;
      const correctScope = paths && JSON.stringify(sorted(paths.include ?? [])) === JSON.stringify(releaseEventPolicy.conditions.workflow_path.include) &&
        (paths.exclude ?? []).length === 0 && Object.keys(actual.conditions).length === 1;
      const correct = actual.enforcement === "active" && correctScope &&
        events.length === 1 && JSON.stringify(sorted(events[0].parameters?.allowed_events ?? [])) ===
        JSON.stringify(sorted(releaseEventPolicy.rules[0].parameters.allowed_events));
      findings.push({ item: "release workflow events", status: correct ? "ok" : "drift", detail: correct ? "" : "release.yml must allow only its target and dispatch events",
        writes: correct || (!correctScope && extras.length > 0) ? [] : [["PUT", `/actions/policies/${summary.id}`, { ...releaseEventPolicy, rules: [...releaseEventPolicy.rules, ...extras] }]] });
    }
    if (actual.enforcement !== "active") continue;
    const paths = actual.conditions?.workflow_path;
    assert(!paths || (Array.isArray(paths.include) && Array.isArray(paths.exclude)), "Malformed Actions workflow scope");
    const applies = !paths || ((paths.include.length === 0 || paths.include.some(p => matchesRef(p, ".github/workflows/release.yml"))) &&
      !paths.exclude.some(p => matchesRef(p, ".github/workflows/release.yml")));
    if (!applies) continue;
    if (extras.length > 0 || (summary.name !== releaseEventPolicy.name && actual.rules.some(rule =>
      rule.type === "restrict_action_events" && releaseEventPolicy.rules[0].parameters.allowed_events.some(event => !rule.parameters?.allowed_events?.includes(event))))) {
      findings.push({ item: `Actions policy "${summary.name}"`, status: "drift", writes: [],
        detail: "additional event/actor restrictions need administrator review; never relaxed automatically" });
    }
  }
  return findings;
}

export async function runPolicy({ client, apply = false, log = console.log }) {
  let findings = await inspect(client);
  const show = list => { for (const finding of list) log(`${finding.status.toUpperCase().padEnd(7)} ${finding.item}${finding.detail ? `: ${finding.detail}` : ""}`); };
  show(findings);
  if (apply && findings.some(finding => finding.writes.length > 0)) {
    for (const finding of findings) for (const [method, path, body] of finding.writes) {
      log(`${method} ${path}`);
      await client.request(method, path, body);
    }
    log("After applying:");
    findings = await inspect(client);
    show(findings);
  }
  return findings.every(finding => finding.status === "ok");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const repository = process.argv.find(arg => arg.startsWith("--repository="))?.slice("--repository=".length) ?? process.env.GITHUB_REPOSITORY ?? "Quince-Pie/tab-gantry";
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    try { token = (await promisify(execFile)("gh", ["auth", "token"], { timeout: 30_000 })).stdout.trim(); }
    catch { token = undefined; }
  }
  const ok = await runPolicy({ client: new AdminClient(repository, token), apply: process.argv.includes("--apply") });
  if (!ok) process.exitCode = 1;
}
