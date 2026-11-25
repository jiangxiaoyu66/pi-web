import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" } });
const data = await jiti.import("../lib/mcp-categories.ts");
const { createMcpCategoriesClient } = await jiti.import("../lib/mcp-categories-client.ts");
const filename = fileURLToPath(new URL("./McpCategoryList.tsx", import.meta.url));
const script = new Script(jiti.transform({ source: readFileSync(filename, "utf8"), filename, ts: true, jsx: true }));
const bucketKey = '["global"]';

function fixture(client) {
  let stateIndex = 0;
  const states = [], exports = {};
  script.runInNewContext({ exports, React: require("react"), require(id) {
    if (id === "react") return {
      useEffect() {}, useId: () => ":r1:", useRef: value => ({ current: value }),
      useState(initial) {
        const index = stateIndex++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
      },
    };
    if (id.includes("jsx-runtime")) return require(id);
    if (id.endsWith("useI18n")) return { useI18n: () => ({ t: key => key }) };
    if (id.endsWith("useIsMobile")) return { useIsMobile: () => false };
    if (id.endsWith("useMcpCategories")) return { useMcpCategories: () => ({ ...client.getSnapshot(), ...client }) };
    if (id.endsWith("mcp-categories")) return data;
    if (id.endsWith("mcp-server-display")) return { revealHiddenCharacters: value => value };
    if (id.endsWith("SidebarMenu")) return { SidebarMenu: ({ children }) => children };
    if (id.endsWith("mcp-config-helpers")) return { mcpServerKey: server => server.name };
    throw Error(`Unexpected import ${id}`);
  } });
  return {
    render(props = {}) {
      stateIndex = 0;
      return exports.McpCategoryList({ scope: "global", servers: [], selected: null, renderServer: () => null, ...props });
    },
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const button = (tree, label) => nodes(tree).find(node => node.type === "button" && (
  node.props.children === label || (label === "mcp.categories.create" && node.props.className === "mcp-category-add")
));

for (const bad of ["\ud800", "\udc00"]) {
  test(`rendering remains total for surrogate-shaped JSON or raw MCP server names: ${JSON.stringify(bad)}`, () => {
    const preferences = { version: 1, buckets: { [bucketKey]: { categories: [{ id: bad, name: "valid" }], assignments: {} } } };
    assert.equal(data.validateMcpCategories(preferences), false, "normal client boundary refuses this snapshot");
    // Backstop test injects malformed JSON directly, as the independent review did.
    const client = { getSnapshot: () => ({ preferences, ready: true, loading: false, saving: false, error: null }) };
    const tree = fixture(client).render({ servers: [{ name: bad }], renderServer: () => "server" });
    assert.doesNotThrow(() => renderToStaticMarkup(tree));
    const move = nodes(tree).find(node => node.props?.["data-mcp-category-move"]);
    assert.equal(move.props["data-mcp-category-move"], encodeURIComponent(JSON.stringify(bad)));
    const title = nodes(tree).find(node => node.props?.className === "mcp-category-title");
    assert.equal(title.props["aria-controls"], ":r1:-category-0");
  });
}

test("blocked migration UI requires opening and confirming before enabling server-only storage", async () => {
  const requests = [];
  const client = createMcpCategoriesClient({
    storage() { throw new DOMException("blocked", "SecurityError"); },
    fetch: async (_url, init) => {
      requests.push(init.method);
      return Response.json({ exists: false, preferences: data.EMPTY_MCP_CATEGORIES });
    },
  });
  await client.refresh(); assert.equal(client.getSnapshot().migrationBlocked, true);
  const component = fixture(client);
  let tree = component.render();
  assert.equal(button(tree, "mcp.categories.skipMigrationConfirm"), undefined);
  assert.equal(button(tree, "mcp.categories.create").props.disabled, true);
  const opener = button(tree, "mcp.categories.skipMigration");
  assert.ok(opener); assert.equal(opener.props.disabled, false);
  opener.props.onClick({ currentTarget: { getBoundingClientRect: () => ({}) } });
  tree = component.render();
  assert.equal(client.getSnapshot().ready, false, "opening confirmation alone cannot discard migration");
  assert.deepEqual(requests, ["GET"]);
  assert.ok(renderToStaticMarkup(tree).includes("mcp.categories.skipMigrationNote"));
  const form = nodes(tree).find(node => node.type === "form");
  assert.equal(button(tree, "mcp.categories.skipMigrationConfirm").props.disabled, false);
  form.props.onSubmit({ preventDefault() {} });
  // The real client queues GET; wait through that HTTP boundary, not a mocked apply.
  while (!client.getSnapshot().ready) await new Promise(resolve => setTimeout(resolve, 0));
  tree = component.render();
  assert.deepEqual(requests, ["GET", "GET"]);
  assert.equal(button(tree, "mcp.categories.create").props.disabled, false);
  assert.equal(button(tree, "mcp.categories.skipMigration"), undefined);
});
