import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { annotateSkillGrouping } = await jiti.import("./skill-grouping.ts");
const options = { cwd: "/work/project", agentDir: "/home/me/.pi/agent", homeDir: "/home/me" };
const skill = (filePath, sourceInfo = {}, extra = {}) => ({
  name: "skill", description: "test", filePath, baseDir: "/not/a/config/root",
  disableModelInvocation: false, sourceInfo, ...extra,
});
const group = (entry, opts = options) => annotateSkillGrouping([entry], opts)[0].grouping;

test("package origin groups by full source and SDK scope, never install metadata", () => {
  const entries = ["a", "b"].map((name) => skill(`/pkg/${name}/SKILL.md`, {
    origin: "package", source: "npm:@team/plugin@1.0.0", scope: "user",
  }));
  const grouped = annotateSkillGrouping(entries, options);
  assert.deepEqual(grouped[0].grouping, grouped[1].grouping);
  assert.deepEqual(grouped[0].grouping, {
    scope: "global", kind: "plugin", sourceKey: "npm:@team/plugin@1.0.0",
    sourceLabel: "npm:@team/plugin@1.0.0", rootKey: "", directorySegments: [],
  });
  assert.equal(group(skill("/pkg/a/SKILL.md", { ...entries[0].sourceInfo, scope: "project" })).scope, "project");
  assert.notEqual(group(skill("/pkg/a/SKILL.md", { ...entries[0].sourceInfo, source: "npm:@team/plugin@2.0.0" })).sourceKey, grouped[0].grouping.sourceKey);
  assert.equal(entries[0].grouping, undefined, "input is not mutated");
});

test("known roots retain classification folders but omit the SKILL.md parent", () => {
  const cases = [
    ["/home/me/.pi/agent/skills/video/edit/cut/SKILL.md", "user", "/home/me/.pi/agent/skills", ["video", "edit"]],
    ["/home/me/.agents/skills/cut/SKILL.md", "user", "/home/me/.agents/skills", []],
    ["/work/project/.pi/skills/cut/SKILL.md", "project", "/work/project/.pi/skills", []],
    ["/work/project/.agents/skills/video/notes.md", "project", "/work/project/.agents/skills", ["video"]],
    ["/work/project/.pi/skills/notes.md", "project", "/work/project/.pi/skills", []],
  ];
  for (const [file, scope, root, segments] of cases) {
    const result = group(skill(file, { scope, source: "auto" }, { install: { package: "stale@cut", source: "wrong" } }));
    assert.equal(result.kind, "local");
    assert.equal(result.rootKey, root);
    assert.deepEqual(result.directorySegments, segments);
  }
});

test("auto configuration roots accept ancestors and pick the most specific root", () => {
  const entry = skill("/work/.agents/skills/category/cut/SKILL.md", { source: "auto", scope: "project", baseDir: "/work/.agents" });
  assert.equal(group(entry).rootKey, "/work/.agents/skills");
  const nested = skill("/home/me/.pi/agent/skills/nested/.pi/skills/cat/cut/SKILL.md", {
    source: "auto", scope: "user", baseDir: "/home/me/.pi/agent/skills/nested/.pi",
  });
  assert.equal(group(nested).rootKey, "/home/me/.pi/agent/skills/nested/.pi/skills");
  assert.deepEqual(group(nested).directorySegments, ["cat"]);
});

test("invalid, missing, single-skill and non-auto baseDir cannot invent a root", () => {
  for (const sourceInfo of [
    { source: "auto" },
    { source: "auto", baseDir: "/outside/.agents" },
    { source: "auto", baseDir: "/extra/cut" },
    { source: "explicit", baseDir: "/extra/.pi" },
  ]) {
    const entry = skill("/extra/cut/skills/notes.md", sourceInfo, { baseDir: "/extra/cut" });
    assert.equal(group(entry).kind, "path");
  }
  assert.equal(group(skill("/extra/.pi/skills-other/cut/SKILL.md", { source: "auto", baseDir: "/extra/.pi" })).kind, "path");
  assert.equal(group(skill("/extra/notes.md", { source: "/extra/notes.md" })).sourceLabel, "/extra/notes.md");
  assert.equal(group(skill("/work/project/.pi/skills/../../escape/SKILL.md", { scope: "project" })).kind, "path");
});

test("scope follows SDK metadata even for temporary files inside global roots", () => {
  for (const scope of ["temporary", "unknown", undefined]) {
    assert.equal(group(skill("/home/me/.pi/agent/skills/cut/SKILL.md", { scope, source: "user" })).scope, "path");
  }
  assert.equal(group(skill("/home/me/.pi/agent/skills/cut/SKILL.md", { scope: "project" })).scope, "project");
});

test("Windows drive and UNC paths use Node path semantics on every host", () => {
  const opts = { cwd: "C:\\work\\project", agentDir: "C:\\Users\\me\\.pi\\agent", homeDir: "C:\\Users\\me" };
  const result = group(skill("c:\\WORK\\project\\.pi\\skills\\video\\cut\\SKILL.md", { scope: "project" }), opts);
  assert.equal(result.kind, "local");
  assert.deepEqual(result.directorySegments, ["video"]);
  assert.equal(result.rootKey, "C:\\work\\project\\.pi\\skills");
  assert.equal(group(skill("D:\\work\\project\\.pi\\skills\\cut\\SKILL.md"), opts).kind, "path");
  const unc = { cwd: "\\\\server\\share\\project", agentDir: opts.agentDir, homeDir: opts.homeDir };
  assert.equal(group(skill("\\\\server\\share\\project\\.agents\\skills\\cut\\SKILL.md", { scope: "project" }), unc).kind, "local");
});

test("symlinked loaded skills retain their logical path, without scanning targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-grouping-"));
  try {
    const target = join(root, "target");
    const agentDir = join(root, "agent");
    await mkdir(target);
    await mkdir(join(agentDir, "skills"), { recursive: true });
    await writeFile(join(target, "SKILL.md"), "body");
    await symlink(target, join(agentDir, "skills", "linked"), process.platform === "win32" ? "junction" : "dir");
    const filePath = join(agentDir, "skills", "linked", "SKILL.md");
    const [result] = annotateSkillGrouping([skill(filePath, { scope: "user" })], { cwd: root, agentDir, homeDir: root });
    assert.equal(result.filePath, filePath);
    assert.equal(result.grouping.rootKey, join(agentDir, "skills"));
    assert.deepEqual(result.grouping.directorySegments, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
