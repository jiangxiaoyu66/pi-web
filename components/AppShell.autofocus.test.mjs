import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const text = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("AppShell.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler;
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(source) === "handleComposerReady") handler = node.initializer.arguments[0];
    if (node.name.getText(source) === "launchAutofocusRef") initializer = node.initializer.arguments[0];
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(handler);
assert.ok(initializer);
const js = ts.transpileModule(`(${handler.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const makeHandler = new Function("scope", `with (scope) { return ${js} }`);

for (const query of ["", "?autofocus=0", "?autofocus=true", "?autofocus=1", "?cwd=%2Ftmp&autofocus=1"]) {
  test(`launch autofocus is explicitly opt-in: ${query || "no query"}`, () => {
    const searchParams = new URLSearchParams(query);
    const enabled = new Function("searchParams", `return ${initializer.getText(source)}`)(searchParams);
    assert.equal(enabled, searchParams.get("autofocus") === "1");
  });
}

function setup({ requested = true, ready = true, modal = false, otherFocus = false } = {}) {
  let calls = 0;
  const body = {};
  const scope = {
    launchAutofocusRef: { current: requested },
    chatInputRef: { current: ready ? { focus() { calls++; } } : null },
    document: { body, activeElement: otherFocus ? {} : body, querySelector: () => modal ? {} : null },
  };
  return { scope, run: makeHandler(scope), count: () => calls };
}

test("focuses once across Strict Mode effects and session switches", () => {
  const c = setup();
  c.run();
  c.run();
  assert.equal(c.count(), 1);
});

test("waits until the composer ref is ready", () => {
  const c = setup({ ready: false });
  c.run();
  assert.equal(c.scope.launchAutofocusRef.current, true);
  c.scope.chatInputRef.current = { focus() {} };
  c.run();
  assert.equal(c.scope.launchAutofocusRef.current, false);
});

for (const options of [{ requested: false }, { modal: true }, { otherFocus: true }]) {
  test(`does not steal focus: ${JSON.stringify(options)}`, () => {
    const c = setup(options);
    c.run();
    assert.equal(c.count(), 0);
    c.scope.document.activeElement = c.scope.document.body;
    c.scope.document.querySelector = () => null;
    c.run();
    assert.equal(c.count(), 0, "a skipped launch request must not fire later");
  });
}

test("only the main ChatWindow reports readiness after loading and extension UI", () => {
  const chat = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(chat, /if \(!panel && !loading && !error && !extensionDialog && !extensionCustomUi\)\s*\{\s*onComposerReady\?\.\(\)/);
  assert.match(text, /onComposerReady=\{handleComposerReady\}/);
});
