"use client";

import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { SkillInfo } from "@/lib/api-types";
import { buildSkillTree, findSkillAncestors } from "@/lib/skill-tree";
import type { SkillTreeNode } from "@/lib/skill-tree";
import { shortenPath } from "@/lib/display-path";
import { useI18n } from "@/hooks/useI18n";
import { ConfigSidebarGroupSwitch } from "./SettingsUi";

interface SkillGroupTreeProps {
  skills: SkillInfo[];
  selectedFilePath: string | null;
  renderSkill: (skill: SkillInfo) => ReactNode;
  busy: boolean;
  bulkGroup: string | null;
  groupStatus: { group: string; error: string } | null;
  onToggleGroup: (node: SkillTreeNode, enabled: boolean) => void;
}

function findGroupPath(nodes: SkillTreeNode[], id: string): SkillTreeNode[] {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const path = findGroupPath(node.children, id);
    if (path.length) return [node, ...path];
  }
  return [];
}

export function SkillGroupTree({
  skills, selectedFilePath, renderSkill, busy, bulkGroup, groupStatus, onToggleGroup,
}: SkillGroupTreeProps) {
  const { t } = useI18n();
  const treeId = useId();
  const nodes = useMemo(() => buildSkillTree(skills), [skills]);
  const [expanded, setExpanded] = useState(() => new Map<string, boolean>(
    selectedFilePath ? findSkillAncestors(nodes, selectedFilePath).map((id) => [id, true]) : [],
  ));
  const lastSelection = useRef<string | null | undefined>(undefined);
  const titles = useRef(new Map<string, HTMLButtonElement>());
  const contents = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (lastSelection.current === selectedFilePath) return;
    const ancestors = selectedFilePath ? findSkillAncestors(nodes, selectedFilePath) : [];
    // A selection can arrive before its records. Retry only until it is found.
    if (selectedFilePath && !ancestors.length) return;
    lastSelection.current = selectedFilePath;
    if (ancestors.length) setExpanded((previous) => {
      const next = new Map(previous);
      for (const id of ancestors) next.set(id, true);
      return next;
    });
  }, [nodes, selectedFilePath]);

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    titles.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [expanded]);

  function toggle(node: SkillTreeNode, open: boolean) {
    if (open && contents.current.get(node.id)?.contains(document.activeElement)) {
      titles.current.get(node.id)?.focus();
    }
    setExpanded((previous) => new Map(previous).set(node.id, !open));
  }

  function revealFailure() {
    if (!groupStatus) return;
    const path = findGroupPath(nodes, groupStatus.group);
    if (!path.length) return;
    pendingFocus.current = groupStatus.group;
    setExpanded((previous) => {
      const next = new Map(previous);
      for (const node of path) next.set(node.id, true);
      return next;
    });
  }

  function renderNode(node: SkillTreeNode, depth: number): ReactNode {
    const open = expanded.get(node.id) ?? node.type === "scope";
    const domId = `${treeId}-${encodeURIComponent(node.id)}`;
    const local = node.type === "source" && node.kind === "local";
    const label = node.type === "scope" ? t(`skills.scope.${node.scope}`)
      : local ? t("skills.tree.local") : node.label;
    const enabled = node.skills.filter((skill) => !skill.disableModelInvocation).length;
    const total = node.skills.length;
    const allEnabled = total > 0 && enabled === total;
    const groupLabel = local ? `${label} · ${shortenPath(node.label)}` : label;
    return (
      <div key={node.id} className="skill-group-tree-node" style={{
        "--skill-tree-indent": `${Math.min(depth, 3) * 10}px`,
        "--skill-tree-leaf-indent": `${Math.min(depth + 1, 4) * 10}px`,
      } as CSSProperties}>
        <div className="skill-group-tree-heading">
          <button
            type="button"
            className="skill-group-tree-title"
            ref={(element) => { if (element) titles.current.set(node.id, element); else titles.current.delete(node.id); }}
            aria-expanded={open}
            aria-controls={`${domId}-children`}
            onClick={() => toggle(node, open)}
          >
            <span className="skill-group-tree-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="skill-group-tree-label" title={groupLabel}>
              <span>{label}</span>
              {local && <span className="skill-group-tree-root">{shortenPath(node.label)}</span>}
            </span>
          </button>
          <span id={`${domId}-count`} className="skill-group-tree-count-description">{enabled}/{total}</span>
          <ConfigSidebarGroupSwitch
            enabled={enabled}
            total={total}
            label={t(allEnabled ? "skills.groupSwitchOn" : "skills.groupSwitchOff", { group: groupLabel })}
            describedBy={`${domId}-count ${treeId}-hint`}
            disabled={busy}
            loading={bulkGroup === node.id}
            onChange={(enabled) => onToggleGroup(node, enabled)}
          />
        </div>
        <div
          id={`${domId}-children`}
          ref={(element) => { if (element) contents.current.set(node.id, element); else contents.current.delete(node.id); }}
          hidden={!open}
        >
          {open && <>
            {node.children.map((child) => renderNode(child, depth + 1))}
            <div className="skill-group-tree-leaves">
              {node.leaves.map((skill) => <Fragment key={skill.filePath}>{renderSkill(skill)}</Fragment>)}
            </div>
          </>}
        </div>
      </div>
    );
  }

  return (
    <div className="skill-group-tree">
      <p id={`${treeId}-hint`} className="skill-group-tree-hint">{t("skills.tree.invocationHint")}</p>
      {groupStatus && <div className="skill-group-tree-error" role="alert">
        <div>{groupStatus.error}</div>
        <button type="button" onClick={revealFailure}>{t("skills.tree.expandFailed")}</button>
      </div>}
      {nodes.map((node) => renderNode(node, 0))}
    </div>
  );
}
