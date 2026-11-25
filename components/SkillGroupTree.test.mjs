import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

// createRequire also supports NODE_PATH for an external, read-only dependency tree.
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" }, tsconfigPaths: true,
  alias: { react: require.resolve("react"), "react/jsx-runtime": require.resolve("react/jsx-runtime") },
});
const { SkillGroupTree } = await jiti.import("./SkillGroupTree.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { buildSkillTree } = await jiti.import("../lib/skill-tree.ts");
const source = await readFile(new URL("./SkillGroupTree.tsx", import.meta.url), "utf8");
const skill = (name, root = "/Users/test/skills") => ({
  name, filePath: `${root}/category/${name}/SKILL.md`, disableModelInvocation: name === "off",
  grouping: { scope: "global", kind: "local", sourceKey: root, sourceLabel: root, rootKey: root, directorySegments: ["category"] },
});
const skills = [skill("on"), skill("off")];
function render(overrides = {}) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(SkillGroupTree, {
      skills, selectedFilePath: null, renderSkill: (s) => React.createElement("button", null, `leaf:${s.name}`),
      busy: false, bulkGroup: null, groupStatus: null, onToggleGroup() {}, ...overrides,
    })));
}

test("scopes start open but collapsed sources do not render focusable leaves", () => {
  const html = render();
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /leaf:on/);
  assert.match(html, /1\/2/);
});

test("initial selection opens every ancestor and renders supplied rows", () => {
  const html = render({ selectedFilePath: skills[0].filePath });
  assert.doesNotMatch(html, /aria-expanded="false"/);
  assert.match(html, /leaf:on/);
  assert.match(html, /leaf:off/);
  assert.match(html, /Local skills/);
  assert.match(html, /~\/skills/);
});

test("all nested switches have descriptive labels, counts and busy locking", () => {
  const html = render({ selectedFilePath: skills[0].filePath, busy: true });
  assert.equal((html.match(/role="switch"/g) ?? []).length, 3);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.match(html, /Show every skill in category in the model prompt/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /Controls automatic invocation/);
});

test("failure details and recovery stay visible outside collapsed groups", () => {
  const group = buildSkillTree(skills)[0].children[0].children[0].id;
  const html = render({ groupStatus: { group, error: "off: Access denied" } });
  assert.match(html, /role="alert"/);
  assert.match(html, /off: Access denied/);
  assert.match(html, /Expand failed group/);
  assert.doesNotMatch(html, /leaf:off/);
});

test("plugin and path names use source labels, directories keep original labels", () => {
  for (const kind of ["plugin", "path"]) {
    const entry = { ...skills[0], grouping: { ...skills[0].grouping, kind, sourceLabel: "original-source" } };
    const html = render({ skills: [entry], selectedFilePath: entry.filePath });
    assert.match(html, /original-source/);
    assert.match(html, /category/);
  }
});

test("selection guard prevents reloads and toggles from reopening user-collapsed groups", () => {
  assert.match(source, /findSkillAncestors\(nodes, selectedFilePath\)/);
  assert.match(source, /lastSelection\.current === selectedFilePath/);
  assert.match(source, /lastSelection\.current = selectedFilePath/);
  assert.match(source, /new Map/);
  assert.match(source, /bulkGroup === node\.id/);
  assert.match(source, /onToggleGroup\(node, enabled\)/);
});

test("collapse restores descendant focus, recovery opens the target and its ancestors", () => {
  assert.match(source, /contains\(document\.activeElement\)/);
  assert.match(source, /\.focus\(\)/);
  assert.match(source, /aria-controls=/);
  assert.match(source, /aria-expanded=/);
  assert.doesNotMatch(source, /ConfigSidebarItem/);
  assert.match(source, /findGroupPath/);
});

test("tree-only CSS caps indentation and translations exist in all locales", async () => {
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  assert.match(css, /\.skill-group-tree[\s\S]*?min-width: 0/);
  const source = await readFile(new URL("./SkillGroupTree.tsx", import.meta.url), "utf8");
  assert.match(source, /Math\.min\(depth, 3\)/);
  assert.match(source, /Math\.min\(depth \+ 1, 4\)/);
  assert.match(css, /padding-inline-start: calc\(8px \+ var\(--skill-tree-leaf-indent, 10px\)\)/);
  assert.match(css, /\.skill-group-tree-label > span[\s\S]*?text-overflow: ellipsis/);
  for (const [file, name] of [["en", "enLocale"], ["zh-CN", "zhCNLocale"], ["zh-TW", "zhTWLocale"]]) {
    const locale = (await jiti.import(`../lib/i18n/messages/${file}.ts`))[name];
    for (const key of ["skills.tree.local", "skills.tree.invocationHint", "skills.tree.expandFailed"]) {
      assert.ok(locale.messages[key], `${file}: ${key}`);
    }
  }
});
