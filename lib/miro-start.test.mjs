import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-miro-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  copyFileSync(new URL("../bin/miro-start.sh", import.meta.url), join(root, "bin/miro-start.sh"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-b", "miro/main");
  git("add", "bin/miro-start.sh");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const check = (...args) => spawnSync("bash", ["bin/miro-start.sh", ...args], { cwd: root, encoding: "utf8" });
  return { root, git, check };
}

test("Miro stable launcher accepts a clean main checkout without starting a server", t => {
  const { check } = fixture(t);
  const result = check("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clean miro\/main/);
});

test("Miro stable launcher refuses development branches and never switches them", t => {
  const { git, check } = fixture(t);
  git("switch", "-c", "miro/dev");
  const result = check("--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected miro\/main/);
  assert.equal(git("branch", "--show-current").toString().trim(), "miro/dev");
});

test("Miro stable launcher refuses detached HEAD", t => {
  const { git, check } = fixture(t);
  git("checkout", "--detach");
  assert.match(check("--check").stderr, /detached HEAD/);
});

test("Miro stable launcher refuses uncommitted files without deleting them", t => {
  const { root, check } = fixture(t);
  writeFileSync(join(root, "pending.txt"), "unfinished work");
  const result = check("--check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncommitted worktree/);
});

test("Miro stable launcher rejects unsupported arguments and missing dependencies", t => {
  const { check } = fixture(t);
  assert.equal(check("--unexpected").status, 2);
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dependencies are missing/);
});
