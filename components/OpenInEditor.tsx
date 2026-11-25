"use client";

import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { setEditorPreference, useEditorPreference } from "@/hooks/useEditorPreference";
import { editorUri, type Editor, type EditorTarget } from "@/lib/editor-links";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";

export const EDITOR_NAMES = { vscode: "VS Code", cursor: "Cursor" } as const;

interface EditorButtonStyle {
  variant?: "file" | "sidebar";
  iconSize?: number;
}

function EditorIcon({ size, sidebar }: { size: number; sidebar: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sidebar ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-12-2 16" /></svg>;
}

/** Shared by toolbar buttons and the real-file rows' context menus. */
export function useEditorActions(target: EditorTarget, { variant = "file", iconSize = 14 }: EditorButtonStyle = {}) {
  const { t } = useI18n();
  const preference = useEditorPreference();
  const sheet = useIsMobile();
  const [menuState, setMenuState] = useState<{ anchor: SidebarMenuAnchor; opener: HTMLElement; path: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const uri = editorUri(preference ?? "vscode", target);
  const reason = uri ? null : t("files.editorUnavailable");
  const label = preference ? t("files.openInEditorNamed", { editor: EDITOR_NAMES[preference] }) : t("files.openInEditor");
  // Menus cannot apply a choice to a different target after a workspace switch.
  const menuOpen = menuState !== null && menuState.path === uri;
  // Forget the old opener as well, so returning to an earlier tab cannot
  // resurrect a dismissed menu after the target (or editor) changed.
  if (menuState !== null && menuState.path !== uri) setMenuState(null);
  const showMenu = (opener: HTMLElement, anchor: SidebarMenuAnchor) => {
    if (!uri) return;
    setFailed(false);
    setMenuState({ opener, anchor, path: uri });
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showMenu(event.currentTarget, { kind: "point", x: event.clientX || rect.left, y: event.clientY || rect.bottom });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    showMenu(event.currentTarget, { kind: "rect", rect, align: "end" });
  };
  const launch = (editor: Editor) => {
    const next = editorUri(editor, target);
    if (!next) return;
    setEditorPreference(editor);
    // A user activation is required. No await, server command, host inference or
    // success notice: the browser cannot tell whether the application opened.
    try { window.location.assign(next); } catch { setFailed(true); }
  };
  const items: SidebarMenuItem[] = [
    { type: "custom", id: "local-only", content: <p style={{ margin: 0, padding: "8px 12px", fontSize: 11, color: "var(--text-muted)", whiteSpace: "normal" }}>{t("files.editorLocalOnly")}</p> },
    ...(["vscode", "cursor"] as const).map((editor): SidebarMenuItem => ({
      type: "item", id: editor,
      label: t("files.openInEditorNamed", { editor: EDITOR_NAMES[editor] }),
      checked: preference === editor,
      onSelect: () => launch(editor),
    })),
  ];
  const button = (
    <button
      type="button"
      className={`${variant === "sidebar" ? "sidebar-tool-button" : "file-viewer-icon-button"} editor-open-button`}
      disabled={!uri}
      title={reason ?? `${label}\n${t("files.editorLocalOnly")}\n${t("files.editorChangeHint")}`}
      aria-label={reason ?? label}
      aria-haspopup={preference ? undefined : "menu"}
      aria-expanded={menuOpen || undefined}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        event.stopPropagation();
        setFailed(false);
        if (preference) launch(preference);
        else {
          const rect = event.currentTarget.getBoundingClientRect();
          showMenu(event.currentTarget, { kind: "rect", rect, align: "end" });
        }
      }}
    ><EditorIcon size={iconSize} sidebar={variant === "sidebar"} /></button>
  );
  const menu = <>
    {menuOpen && <SidebarMenu
      open={menuOpen}
      anchor={menuState?.anchor ?? null}
      sheet={sheet}
      ariaLabel={t("files.openInEditor")}
      title={t("files.openInEditor")}
      items={items}
      cancelLabel={t("sidebar.cancel")}
      returnFocusTo={menuState?.opener}
      onClose={() => setMenuState(null)}
      width={280}
    />}
    {failed && <span role="alert" style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("files.editorFailed")}</span>}
  </>;
  return { button, menu, onContextMenu, onKeyDown };
}

export function OpenInEditorButton({ target, ...style }: { target: EditorTarget } & EditorButtonStyle) {
  const actions = useEditorActions(target, style);
  return <>{actions.button}{actions.menu}</>;
}
