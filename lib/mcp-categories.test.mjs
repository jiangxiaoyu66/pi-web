import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { EMPTY_MCP_CATEGORIES: EMPTY, McpCategoryError, getMcpCategoryBucketKey: key, parseMcpCategories: parse, categoryForServer: category, updateMcpCategories: update } = await jiti.import("./mcp-categories.ts");
const globalKey = '["global"]';
const create = (state = EMPTY, id = "a", name = " Tools ", bucketKey = globalKey) => update(state, { type: "create", bucketKey, id, name });
const fails = (reason, fn) => assert.throws(fn, e => e instanceof McpCategoryError && e.reason === reason);

test("scope keys are JSON tuples, project requires a nonblank cwd", () => {
  assert.equal(key("global", "/ignored"), globalKey);
  assert.equal(key("project", "/a,\"b"), JSON.stringify(["project", '/a,"b']));
  for (const args of [["project"], ["project", " "], ["other"]]) fails("invalid-scope", () => key(...args));
});
test("malformed documents and unknown versions fall back to empty", () => {
  for (const raw of [null, "", "{", "null", "[]", '{"version":2,"buckets":{}}', '{"version":1,"buckets":[]}']) assert.deepEqual(parse(raw), EMPTY);
});
test("parsing filters invalid entries, deduplicates trimmed names/ids and retains absent servers for Undo", () => {
  const state = parse(JSON.stringify({ version: 1, buckets: { [globalKey]: {
    categories: [{ id: "a", name: " Tools " }, { id: "a", name: "Else" }, { id: "b", name: "Tools" }, { id: "", name: "Empty" }, { id: "c", name: " " }, { id: "d", name: "x".repeat(81) }, { id: "e", name: "x".repeat(80) }],
    assignments: { absent: "a", invalid: "missing", blank: "", " ": "a" },
  }, bad: { categories: [], assignments: {} } } }));
  assert.deepEqual(state.buckets[globalKey].categories, [{ id: "a", name: "Tools" }, { id: "e", name: "x".repeat(80) }]);
  assert.deepEqual(state.buckets[globalKey].assignments, { absent: "a" });
  assert.equal(Object.hasOwn(state.buckets, "bad"), false);
  assert.equal(category(state.buckets[globalKey], "absent"), "a");
  assert.equal(category(state.buckets[globalKey], "constructor"), null);
});
test("create/rename/move/delete are immutable and bucket-isolated", () => {
  const first = create();
  const project = key("project", "/p");
  const second = create(first, "a", "Project", project);
  const moved = update(second, { type: "move", bucketKey: globalKey, serverName: "server", categoryId: "a" });
  const renamed = update(moved, { type: "rename", bucketKey: globalKey, id: "a", name: " Renamed " });
  assert.equal(renamed.buckets[globalKey].categories[0].id, "a");
  assert.equal(renamed.buckets[globalKey].categories[0].name, "Renamed");
  assert.equal(first.buckets[globalKey].categories[0].name, "Tools");
  assert.deepEqual(first.buckets[globalKey].assignments, {});
  const unassigned = update(renamed, { type: "move", bucketKey: globalKey, serverName: "server", categoryId: null });
  assert.equal(category(unassigned.buckets[globalKey], "server"), null);
  const deleted = update(renamed, { type: "delete", bucketKey: globalKey, id: "a" });
  assert.deepEqual(deleted.buckets[globalKey], { categories: [], assignments: {} });
  assert.equal(deleted.buckets[project], second.buckets[project]);
  assert.deepEqual(EMPTY, { version: 1, buckets: {} });
});
test("invalid operations expose typed reasons and never alter input", () => {
  const state = create(create(), "b", "Other");
  const before = JSON.stringify(state);
  for (const name of ["", " ", "x".repeat(81)]) fails("invalid-name", () => create(state, "c", name));
  fails("duplicate-name", () => create(state, "c", " Tools "));
  fails("duplicate-name", () => update(state, { type: "rename", bucketKey: globalKey, id: "a", name: "Other" }));
  for (const id of ["", " ", "missing"]) {
    fails("missing-category", () => update(state, { type: "rename", bucketKey: globalKey, id, name: "New" }));
    fails("missing-category", () => update(state, { type: "delete", bucketKey: globalKey, id }));
    fails("missing-category", () => update(state, { type: "move", bucketKey: globalKey, serverName: "s", categoryId: id }));
  }
  fails("missing-category", () => create(state, "a", "New"));
  fails("missing-category", () => create(state, " ", "New"));
  fails("invalid-scope", () => create(state, "c", "New", "bad"));
  assert.equal(JSON.stringify(state), before);
});
test("folds persist independently, include Uncategorized, and are cleaned on category deletion", () => {
  let state = create();
  for (const id of ["a", ""]) state = update(state, { type: "collapse", bucketKey: globalKey, id, collapsed: true });
  assert.deepEqual(parse(JSON.stringify(state)), state);
  const expanded = update(state, { type: "collapse", bucketKey: globalKey, id: "", collapsed: false });
  assert.deepEqual(expanded.buckets[globalKey].collapsed, ["a"]);
  const deleted = update(state, { type: "delete", bucketKey: globalKey, id: "a" });
  assert.deepEqual(deleted.buckets[globalKey].collapsed, [""]);
  fails("missing-category", () => update(state, { type: "collapse", bucketKey: globalKey, id: "missing", collapsed: true }));
});

test("category translations have identical keys across all built-in locales", async () => {
  const locales = await Promise.all(["en", "zh-CN", "zh-TW"].map(locale => jiti.import(`./i18n/messages/${locale}.ts`)));
  const categoryKeys = locale => Object.keys(Object.values(locale).find(value => value?.messages)?.messages ?? {}).filter(key => key.startsWith("mcp.categories.")).sort();
  assert.deepEqual(categoryKeys(locales[1]), categoryKeys(locales[0]));
  assert.deepEqual(categoryKeys(locales[2]), categoryKeys(locales[0]));
  assert.ok(categoryKeys(locales[0]).includes("mcp.categories.loading"));
});

for (const bad of ["\ud800", "\udc00", "ok\ud800bad", "\ud800\ud800"]) {
  test(`lone surrogates fail all category boundaries: ${JSON.stringify(bad)}`, async () => {
    const { isMcpCategoryString, validateMcpCategories, parseMcpCategoriesRequest } = await jiti.import("./mcp-categories.ts");
    assert.equal(isMcpCategoryString(bad), false);
    fails("missing-category", () => create(EMPTY, bad, "valid"));
    fails("invalid-name", () => create(EMPTY, "id", bad));
    fails("invalid-scope", () => key("project", `/cwd-${bad}`));
    const bucket = { categories: [{ id: bad, name: "valid" }], assignments: {} };
    const invalid = { version: 1, buckets: { [globalKey]: bucket } };
    assert.equal(validateMcpCategories(invalid), false);
    assert.equal(parseMcpCategoriesRequest({ version: 1, action: "import", preferences: invalid }), null);
    assert.deepEqual(parse(JSON.stringify(invalid)).buckets[globalKey].categories, []);
    assert.equal(parseMcpCategoriesRequest({ version: 1, operation: { type: "create", bucketKey: globalKey, id: bad, name: "valid" } }), null);
    assert.equal(parseMcpCategoriesRequest({ version: 1, operation: { type: "move", bucketKey: globalKey, serverName: bad, categoryId: null } }), null);
  });
}

test("paired surrogates and multilingual text remain valid without lossy replacement", async () => {
  const { validateMcpCategories } = await jiti.import("./mcp-categories.ts");
  const state = create(EMPTY, "🧪", "研究 🧪", key("project", "/项目/🧪"));
  assert.ok(validateMcpCategories(state));
  assert.deepEqual(parse(JSON.stringify(state)), state);
});

test("prototype-like ids, names and server names are safe and survive serialization", () => {
  let state = create(EMPTY, "__proto__", "constructor");
  for (const serverName of ["__proto__", "constructor"]) state = update(state, { type: "move", bucketKey: globalKey, serverName, categoryId: "__proto__" });
  const bucket = parse(JSON.stringify(state)).buckets[globalKey];
  assert.equal(category(bucket, "__proto__"), "__proto__");
  assert.equal(category(bucket, "constructor"), "__proto__");
  assert.equal({}.polluted, undefined);
});
