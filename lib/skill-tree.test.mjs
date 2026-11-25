import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { buildSkillTree, findSkillAncestors } = await jiti.import("./skill-tree.ts");
const skill = (filePath, grouping, extra = {}) => ({
  name: filePath, description: "test", filePath, baseDir: "/unused",
  sourceInfo: {}, disableModelInvocation: false, ...(grouping && { grouping }), ...extra,
});
const grouping = (overrides = {}) => ({
  scope: "global", kind: "local", sourceKey: "/skills", sourceLabel: "/skills",
  rootKey: "/skills", directorySegments: [], ...overrides,
});
const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children)]);

test("same plugin is aggregated, distinct full sources and scopes stay separate", () => {
  const plugin = grouping({ kind: "plugin", rootKey: "", sourceKey: "npm:one", sourceLabel: "plugin" });
  const entries = [skill("a", plugin), skill("b", plugin),
    skill("c", { ...plugin, sourceKey: "npm:two" }),
    skill("d", { ...plugin, scope: "project" }),
    skill("e", { ...plugin, scope: "path" })];
  const nodes = buildSkillTree(entries);
  assert.deepEqual(nodes.map((node) => node.scope), ["project", "global", "path"]);
  assert.deepEqual(nodes[1].children.map((node) => node.skills.map((entry) => entry.filePath)), [["a", "b"], ["c"]]);
  assert.equal(nodes[1].children[0].label, "plugin");
  assert.equal(nodes[1].children[0].kind, "plugin");
  assert.deepEqual(nodes[1].children[0].leaves.map((entry) => entry.filePath), ["a", "b"]);
});

test("nested categories have direct leaves and deduplicated full descendant sets", () => {
  const entries = [skill("root", grouping()), skill("deep", grouping({ directorySegments: ["video", "edit"] })),
    skill("middle", grouping({ directorySegments: ["video"] })),
    skill("other", grouping({ rootKey: "/other", sourceKey: "/other", directorySegments: ["video"] }))];
  const nodes = buildSkillTree(entries);
  const source = nodes[0].children[0];
  assert.equal(source.label, "/skills");
  assert.deepEqual(source.leaves.map((entry) => entry.filePath), ["root"]);
  assert.equal(source.children[0].label, "video");
  assert.deepEqual(source.children[0].leaves.map((entry) => entry.filePath), ["middle"]);
  assert.deepEqual(source.children[0].skills.map((entry) => entry.filePath), ["deep", "middle"]);
  const ancestors = findSkillAncestors(nodes, "deep");
  assert.deepEqual(ancestors, [nodes[0].id, source.id, source.children[0].id, source.children[0].children[0].id]);
  assert.deepEqual(findSkillAncestors(nodes, "missing"), []);
  assert.equal(nodes[0].children.length, 2, "different roots never merge");
});

test("IDs encode complete identity, survive reorder and labels, and cannot collide", () => {
  const entries = [skill("a", grouping({ directorySegments: ["a/b", "c"] })),
    skill("b", grouping({ directorySegments: ["a", "b/c"] })),
    skill("c", grouping({ sourceKey: "/other", directorySegments: ["a/b", "c"] }))];
  const first = buildSkillTree(entries);
  const second = buildSkillTree([...entries].reverse().map((entry) => ({ ...entry, grouping: { ...entry.grouping, sourceLabel: "renamed" } })));
  assert.deepEqual(flatten(first).map((node) => node.id).sort(), flatten(second).map((node) => node.id).sort());
  const ids = flatten(first).map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => Array.isArray(JSON.parse(id))));
});

test("enabled first, stable input order within each state, duplicate filePath keeps enabled winner", () => {
  const entries = [skill("duplicate", grouping(), { disableModelInvocation: true }),
    skill("off", grouping(), { disableModelInvocation: true }), skill("z", grouping()), skill("a", grouping()),
    skill("duplicate", grouping({ sourceKey: "/loser", rootKey: "/loser" })), skill("z", grouping())];
  const nodes = buildSkillTree(entries);
  assert.deepEqual(nodes[0].skills.map((entry) => entry.filePath), ["z", "a", "duplicate", "off"]);
  const allLeaves = flatten(nodes).flatMap((node) => node.leaves);
  assert.equal(allLeaves.length, 5 - 1);
  assert.equal(new Set(allLeaves.map((entry) => entry.filePath)).size, 4);
  assert.equal(allLeaves.find((entry) => entry.filePath === "duplicate").disableModelInvocation, false);
});

test("unannotated skills preserve old scope and skills.sh grouping, never infer temporary as global", () => {
  const entries = [skill("global", null, { sourceInfo: { source: "user" } }),
    skill("project", null, { sourceInfo: { scope: "project" } }),
    skill("installed", null, { sourceInfo: { scope: "user" }, install: { skillsShUrl: "https://skills.sh/a/b/c" } }),
    skill("temporary", null, { sourceInfo: { scope: "temporary", source: "user" } }), skill("unknown")];
  const nodes = buildSkillTree(entries);
  assert.deepEqual(nodes.map((node) => node.scope), ["project", "global", "path"]);
  assert.deepEqual(nodes[1].skills.map((entry) => entry.filePath), ["global", "installed"]);
  assert.equal(nodes[1].children[0].label, "skills.sh");
  assert.notEqual(nodes[1].children[0].kind, "plugin");
  assert.deepEqual(nodes[2].skills.map((entry) => entry.filePath), ["temporary", "unknown"]);
  assert.equal(nodes.reduce((sum, node) => sum + node.skills.length, 0), entries.length);
});

test("path source label is unchanged and empty input creates no nodes", () => {
  const source = "/extra/custom.md";
  const nodes = buildSkillTree([skill("a", grouping({ scope: "path", kind: "path", sourceKey: source, sourceLabel: source, rootKey: "" }))]);
  assert.equal(nodes[0].children[0].label, source);
  assert.deepEqual(buildSkillTree([]), []);
});

test("tree module is client-safe: only type imports, no Node or runtime dependencies", async () => {
  const source = await readFile(new URL("./skill-tree.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from\s*["'](?:node:|path|fs|os)|require\s*\()/);
  assert.ok(source.split("\n").filter((line) => line.startsWith("import ")).every((line) => line.startsWith("import type ")));
});
