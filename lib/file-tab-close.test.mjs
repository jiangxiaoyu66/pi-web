import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { fileCloseActions, fileCloseTargets } = await createJiti(import.meta.url).import("./file-tab-close.ts");
const tabs = [{ id: "c" }, { kind: "side", id: "s" }, { id: "b" }, { kind: "terminal", id: "t" }, { kind: "agent", id: "g" }, { id: "a" }];

test("all five actions use displayed order and skip non-files", () => {
  assert.deepEqual(fileCloseActions.map(action => fileCloseTargets(tabs, "b", action)), [["b"], ["c", "a"], ["c"], ["a"], ["c", "b", "a"]]);
});

test("missing/non-file anchors and empty directions have no targets", () => {
  for (const anchor of ["gone", "t", "g", "s"]) for (const action of fileCloseActions) assert.deepEqual(fileCloseTargets(tabs, anchor, action), []);
  assert.deepEqual(fileCloseTargets(tabs, "c", "left"), []);
  assert.deepEqual(fileCloseTargets(tabs, "a", "right"), []);
  assert.deepEqual(fileCloseTargets(tabs.slice(0, 2), "c", "others"), []);
});
