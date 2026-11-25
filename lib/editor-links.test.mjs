import assert from "node:assert/strict";
import test from "node:test";

const subject = () => import("./editor-links.ts");

test("encodes real filenames once, never as URL syntax or line selectors", async () => {
  const { editorUri } = await subject();
  assert.equal(editorUri("vscode", { path: "文 档/a#?%:12.ts", cwd: "/work/tree" }), "vscode://file/work/tree/%E6%96%87%20%E6%A1%A3/a%23%3F%25%3A12.ts");
  assert.equal(editorUri("cursor", { path: "/work/a%20b" }), "cursor://file/work/a%2520b");
});

test("keeps workspace and directory identities, including dot folders", async () => {
  const { editorUri, resolveEditorPath } = await subject();
  assert.equal(editorUri("cursor", { path: "/repo-worktrees/feature.with.dot", isDirectory: true }), "cursor://file/repo-worktrees/feature.with.dot/?windowId=_blank");
  assert.equal(resolveEditorPath({ path: "src/../a.ts", cwd: "/repo-worktrees/feature" }), "/repo-worktrees/feature/a.ts");
  assert.equal(resolveEditorPath({ path: "/outside/a.ts", cwd: "/repo" }), "/outside/a.ts");
});

test("requests new windows only for directories in both editors", async () => {
  const { editorUri } = await subject();
  for (const editor of ["vscode", "cursor"]) {
    assert.equal(editorUri(editor, { path: "/repo", isDirectory: true }), `${editor}://file/repo/?windowId=_blank`);
    assert.equal(editorUri(editor, { path: "/", isDirectory: true }), `${editor}://file/?windowId=_blank`);
    assert.equal(editorUri(editor, { path: "目录#?%", cwd: "/repo", isDirectory: true }), `${editor}://file/repo/%E7%9B%AE%E5%BD%95%23%3F%25/?windowId=_blank`);
    assert.equal(editorUri(editor, { path: "C:\\repo", isDirectory: true }), `${editor}://file/C:/repo/?windowId=_blank`);
    assert.equal(editorUri(editor, { path: "/repo/file.ts", isDirectory: false }), `${editor}://file/repo/file.ts`);
    assert.equal(editorUri(editor, { path: "/repo/file.ts" }), `${editor}://file/repo/file.ts`);
  }
});

test("supports Windows drive and relative paths without using the browser OS", async () => {
  const { editorUri, resolveEditorPath } = await subject();
  assert.equal(editorUri("vscode", { path: "C:\\中文 目录\\a#?%.ts" }), "vscode://file/C:/%E4%B8%AD%E6%96%87%20%E7%9B%AE%E5%BD%95/a%23%3F%25.ts");
  assert.equal(resolveEditorPath({ path: "src\\a.ts", cwd: "D:\\worktrees\\feature" }), "D:/worktrees/feature/src/a.ts");
});

test("refuses missing, ambiguous, network and unsafe targets", async () => {
  const { editorUri } = await subject();
  for (const path of [undefined, "", "a.ts", "~/a.ts", "https://host/a", "vscode://file/a", "javascript:alert(1)", "C:relative", "\\\\host\\share\\a", "//host/share/a", "/a\u0000b", "/a\nb", "/a\ud800"]) {
    assert.equal(editorUri("vscode", { path }), null, String(path));
  }
  assert.equal(editorUri("vscode", { path: "../secret", cwd: "/repo" }), null);
  assert.equal(editorUri("vscode", { path: "/ambiguous", cwd: "C:/repo" }), null);
  assert.equal(editorUri("vscode", { path: "a", cwd: "relative" }), null);
  assert.equal(editorUri("evil", { path: "/repo" }), null);
});
