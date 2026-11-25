import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { SkillInfo } from "@/lib/api-types";

interface SkillGroupingOptions {
  cwd: string;
  agentDir: string;
  homeDir?: string;
}

/** Display metadata only: logical paths preserve the loader's symlink identity. */
export function annotateSkillGrouping(
  skills: SkillInfo[],
  { cwd, agentDir, homeDir = homedir() }: SkillGroupingOptions,
): SkillInfo[] {
  return skills.map((skill) => {
    const info = skill.sourceInfo;
    const scope = info?.scope === "user" ? "global" : info?.scope === "project" ? "project" : "path";
    const source = info?.source || skill.filePath;
    if (info?.origin === "package") {
      return { ...skill, grouping: {
        scope, kind: "plugin", sourceKey: source, sourceLabel: source,
        rootKey: "", directorySegments: [],
      } };
    }

    // Choose by path syntax, not the host OS, so Windows drive/UNC paths also
    // have correct containment and separator semantics when tested elsewhere.
    const path = /^[a-z]:[\\/]|^\\\\|^\/\//i.test(skill.filePath) ? win32 : posix;
    const file = path.normalize(skill.filePath);
    const roots = [
      path.join(agentDir, "skills"),
      path.join(homeDir, ".agents", "skills"),
      path.join(cwd, ".pi", "skills"),
      path.join(cwd, ".agents", "skills"),
    ];
    // SDK auto discovery can report ancestor configuration directories. Do not
    // confuse an arbitrary explicit path (or SkillInfo.baseDir) with a config.
    if (info?.source === "auto" && info.baseDir &&
        [".pi", ".agents", "agent"].includes(path.basename(path.normalize(info.baseDir)))) {
      roots.push(path.join(info.baseDir, "skills"));
    }
    const relativeFile = (root: string): string | undefined => {
      if (!path.isAbsolute(root) || !path.isAbsolute(file)) return undefined;
      const relative = path.relative(root, file);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
      return relative;
    };
    const root = roots
      .filter((candidate) => relativeFile(candidate) !== undefined)
      .sort((a, b) => b.length - a.length)[0];
    if (root) {
      const segments = relativeFile(root)!.split(path.sep);
      const filename = segments.pop();
      if (filename?.toLowerCase() === "skill.md") segments.pop();
      return { ...skill, grouping: {
        scope, kind: "local", sourceKey: root, sourceLabel: root,
        rootKey: root, directorySegments: segments,
      } };
    }
    return { ...skill, grouping: {
      scope, kind: "path", sourceKey: source, sourceLabel: source,
      rootKey: "", directorySegments: [],
    } };
  });
}
