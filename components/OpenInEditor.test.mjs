import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { editorUri } from "../lib/editor-links.ts";

const require = createRequire(import.meta.url);
const source = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
function fixture(initial = null) {
  let preference = initial;
  let cursor = 0;
  const states = [];
  const launches = [];
  let throws = false;
  const SidebarMenu = () => null;
  const exports = {};
  const react = { ...require("react"), useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], (value) => { states[index] = value; }];
  } };
  const mocks = {
    react,
    "@/hooks/useI18n": { useI18n: () => ({ t: (key, values) => values?.editor ? `${key}:${values.editor}` : key }) },
    "@/hooks/useIsMobile": { useIsMobile: () => false },
    "@/hooks/useEditorPreference": { useEditorPreference: () => preference, setEditorPreference: (next) => { preference = next; } },
    "@/lib/editor-links": { editorUri },
    "./SidebarMenu": { SidebarMenu },
  };
  const compiled = ts.transpileModule(source("./OpenInEditor.tsx"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function("require", "exports", "window", compiled)((id) => mocks[id] ?? require(id), exports,
    { location: { assign(uri) { if (throws) throw Error("blocked"); launches.push(uri); } } });
  return {
    render(target = { path: "/项目/worktree/a #?%.ts" }) { cursor = 0; return exports.useEditorActions(target); },
    menu(actions) { return actions.menu.props.children.find((child) => child?.type === SidebarMenu); },
    launches,
    block() { throws = true; },
  };
}
function event(extra = {}) {
  return { stopped: false, defaultPrevented: false, currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, right: 20, bottom: 20 }) },
    stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...extra };
}

test("first activation chooses an editor, keeps the original row click isolated and launches encoded real paths", () => {
  const f = fixture();
  let a = f.render();
  const click = event();
  a.button.props.onClick(click);
  assert.equal(click.stopped, true);
  assert.deepEqual(f.launches, []);
  a = f.render();
  const menu = f.menu(a);
  assert.ok(menu);
  assert.equal(menu.props.returnFocusTo, click.currentTarget);
  assert.equal(menu.props.items[0].id, "local-only");
  menu.props.items.find((item) => item.id === "cursor").onSelect();
  assert.deepEqual(f.launches, ["cursor://file/%E9%A1%B9%E7%9B%AE/worktree/a%20%23%3F%25.ts"]);
  menu.props.onClose();
  a = f.render();
  assert.equal(f.menu(a), undefined);
  a.button.props.onClick(event());
  assert.equal(f.launches.length, 2, "remembered editor is a direct user-activated link");
});

test("keyboard and context menus allow changing a remembered editor without activating the row", () => {
  for (const trigger of ["ContextMenu", "F10", "pointer"]) {
    const f = fixture("vscode");
    const a = f.render();
    const e = event({ key: trigger, shiftKey: trigger === "F10", clientX: 12, clientY: 13 });
    if (trigger === "pointer") a.onContextMenu(e); else a.onKeyDown(e);
    assert.equal(e.stopped, true);
    assert.equal(e.defaultPrevented, true);
    const menu = f.menu(f.render());
    assert.equal(menu.props.items.find((item) => item.id === "vscode").checked, true);
    menu.props.items.find((item) => item.id === "cursor").onSelect();
    assert.match(f.launches[0], /^cursor:\/\/file\//);
  }
});

test("workspace/file changes hide a menu tied to an old URI; unavailable paths cannot launch", () => {
  const f = fixture();
  f.render({ path: "a.ts", cwd: "/worktree/old" }).onContextMenu(event());
  assert.ok(f.menu(f.render({ path: "a.ts", cwd: "/worktree/old" })));
  assert.equal(f.menu(f.render({ path: "a.ts", cwd: "/worktree/new" })), undefined);
  assert.equal(f.menu(f.render({ path: "a.ts", cwd: "/worktree/old" })), undefined, "returning to the previous file must not resurrect its menu");
  const unavailable = f.render({ path: null });
  assert.equal(unavailable.button.props.disabled, true);
  unavailable.onContextMenu(event());
  assert.equal(f.menu(f.render({ path: null })), undefined);
  assert.deepEqual(f.launches, []);
});

test("a synchronous protocol refusal reports failure, never success", () => {
  const f = fixture("cursor");
  f.block();
  f.render().button.props.onClick(event());
  const alert = f.render().menu.props.children.find((child) => child?.props?.role === "alert");
  assert.equal(alert.props.children, "files.editorFailed");
  assert.deepEqual(f.launches, []);
});

test("all media/document/text toolbars and both sidebar layouts retain editor wiring", () => {
  const viewer = source("./FileViewer.tsx");
  for (const name of ["ImageViewer", "AudioViewer", "VideoViewer", "DocumentViewer", "TextFileViewer"]) {
    const file = ts.createSourceFile("FileViewer.tsx", viewer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const body = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(file);
    assert.ok(body, name);
    assert.match(body, /<OpenInEditorButton target=\{\{ path: (?:isDeletedDiff \? null : )?filePath, cwd \}\}/, name);
  }
  const sidebar = source("./SessionSidebar.tsx");
  assert.equal(sidebar.match(/<OpenInEditorButton target=\{\{ path: explorerCwd, isDirectory: true \}\}/g)?.length, 2);
});

test("file rows preserve preview, download, mention, directory expansion and keyboard access; tags use real file paths", () => {
  const tree = source("./FileExplorer.tsx");
  for (const pattern of [/useEditorActions\(\{ path: node.fullPath, cwd, isDirectory: node.isDir \}\)/,
    /onContextMenu=\{editor.onContextMenu\}/, /tabIndex=\{0\}/,
    /event.target !== event.currentTarget/, /event.key === "Enter" \|\| event.key === " "/,
    /onOpenFile\(node.fullPath, node.name\)/, /onToggleExpanded\(node.fullPath, next\)/,
    /onAtMention\(getRelativeFilePath\(node.fullPath, cwd\), node.isDir\)/,
    /encodeFilePathForApi\(node.fullPath\)\}\?type=download/]) assert.match(tree, pattern);
  const tags = source("./TurnWrittenFiles.tsx");
  assert.match(tags, /useEditorActions\(\{ path: filePath \}\)/);
  assert.match(tags, /onOpenFile\?\.\(filePath\)/);
  assert.match(tags, /onContextMenu=\{editor.onContextMenu\}/);
  assert.match(tags, /onKeyDown=\{editor.onKeyDown\}/);
});

test("editor strings exist in all three supported locales without raw-key UI", () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = source(`../lib/i18n/messages/${locale}.ts`);
    for (const key of ["openInEditor", "openInEditorNamed", "editorLocalOnly", "editorChangeHint", "editorUnavailable", "editorFailed"]) {
      assert.match(messages, new RegExp(`"files\\.${key}": "[^"]+"`));
    }
  }
});
