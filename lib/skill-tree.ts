import type { SkillInfo } from "@/lib/api-types";

type SkillScope = "project" | "global" | "path";
type SkillGrouping = NonNullable<SkillInfo["grouping"]>;

export type SkillTreeNode = {
  id: string;
  type: "scope" | "source" | "directory";
  scope: SkillScope;
  kind?: "plugin" | "local" | "path";
  label: string;
  children: SkillTreeNode[];
  skills: SkillInfo[];
  leaves: SkillInfo[];
};

function legacyScope(skill: SkillInfo): SkillScope {
  const info = skill.sourceInfo;
  // Older responses used source instead of scope. An explicit temporary or
  // unknown scope must not be promoted to global by that compatibility rule.
  const scope = info?.scope ?? info?.source;
  if (scope === "project") return "project";
  return scope === "user" ? "global" : "path";
}

/** Build from loaded records only; no filesystem or server dependencies. */
export function buildSkillTree(skills: SkillInfo[]): SkillTreeNode[] {
  const nodes = new Map<string, SkillTreeNode>();
  const scopes = new Map<SkillScope, SkillTreeNode>();
  const getNode = (
    type: SkillTreeNode["type"], scope: SkillScope, label: string,
    grouping?: SkillGrouping, segments: string[] = [],
  ): SkillTreeNode => {
    const id = JSON.stringify([
      type, scope, grouping?.kind ?? null, grouping?.sourceKey ?? "",
      grouping?.rootKey ?? "", segments,
    ]);
    let node = nodes.get(id);
    if (!node) {
      node = {
        id, type, scope, ...(grouping && { kind: grouping.kind }), label,
        children: [], skills: [], leaves: [],
      };
      nodes.set(id, node);
    }
    return node;
  };
  const appendChild = (parent: SkillTreeNode, child: SkillTreeNode) => {
    if (!parent.children.includes(child)) parent.children.push(child);
  };
  const seen = new Set<string>();
  // Stable partition: enabled wins a duplicate filePath, and original order is
  // preserved among enabled records and among dormant records, at every node.
  const ordered = [
    ...skills.filter((skill) => !skill.disableModelInvocation),
    ...skills.filter((skill) => skill.disableModelInvocation),
  ];
  for (const skill of ordered) {
    if (seen.has(skill.filePath)) continue;
    seen.add(skill.filePath);
    const scope = skill.grouping?.scope ?? legacyScope(skill);
    const scopeNode = getNode("scope", scope, scope);
    scopes.set(scope, scopeNode);
    scopeNode.skills.push(skill);
    let parent = scopeNode;
    // Without annotation preserve the old scope + skills.sh buckets, rather
    // than inventing plugin/root identities from install locks or file paths.
    const grouping = skill.grouping ?? (skill.install?.skillsShUrl && scope !== "path" ? {
      scope, kind: "path" as const, sourceKey: "skills.sh", sourceLabel: "skills.sh",
      rootKey: "", directorySegments: [],
    } : undefined);
    if (grouping) {
      const label = grouping.kind === "local" ? grouping.rootKey : grouping.sourceLabel;
      const source = getNode("source", scope, label, grouping);
      appendChild(parent, source);
      source.skills.push(skill);
      parent = source;
      const segments: string[] = [];
      for (const segment of grouping.directorySegments) {
        segments.push(segment);
        const directory = getNode("directory", scope, segment, grouping, segments);
        appendChild(parent, directory);
        directory.skills.push(skill);
        parent = directory;
      }
    }
    parent.leaves.push(skill);
  }
  for (const node of nodes.values()) {
    // Sources retain loader order; category order is independent of which
    // descendant happened to be loaded first.
    if (node.type !== "scope") {
      node.children.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    }
  }
  return (["project", "global", "path"] as const)
    .flatMap((scope) => {
      const node = scopes.get(scope);
      return node ? [node] : [];
    });
}

/** Includes scope, source and all categories, never a leaf identifier. */
export function findSkillAncestors(nodes: SkillTreeNode[], filePath: string): string[] {
  for (const node of nodes) {
    if (node.leaves.some((skill) => skill.filePath === filePath)) return [node.id];
    const descendants = findSkillAncestors(node.children, filePath);
    if (descendants.length) return [node.id, ...descendants];
  }
  return [];
}
