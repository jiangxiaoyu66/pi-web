import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");

test("existing skills panel delegates only its list to the grouping tree", () => {
  assert.match(source, /<SkillGroupTree\b/);
  assert.match(source, /onToggleGroup=\{\(node, enabled\) => void setGroupSkills\(node\.id, node\.skills, enabled\)\}/);
  assert.doesNotMatch(source, /const groupDefinitions =/);
  assert.match(source, /loading && skills\.length === 0/);
});

test("single, batch, update and install share a synchronous write guard", () => {
  assert.match(source, /const writeInProgress = useRef\(false\)/);
  assert.match(source, /if \(!beginWrite\(\)\) return;/);
  assert.match(source, /onBeginInstall=\{beginInstall\}/);
  assert.match(source, /onEndInstall=\{endInstall\}/);
  assert.match(source, /disabled=\{writeBusy\}/);
  assert.match(source, /onInstalled=\{loadSkills\}/);
});

test("detail reports its mobile title independently of collapsed sidebar rows", () => {
  assert.match(source, /reportDetailTitle\(skill\.name\)/);
  assert.match(source, /closest\("\[hidden\]"\)/);
});
