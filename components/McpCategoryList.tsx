import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { McpScope, McpServerInfo } from "@/lib/api-types";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useMcpCategories } from "@/hooks/useMcpCategories";
import { categoryForServer, getMcpCategoryBucketKey, McpCategoryError, type McpCategoryOperation, type McpCategoryBucket } from "@/lib/mcp-categories";
import { revealHiddenCharacters } from "@/lib/mcp-server-display";
import { SidebarMenu, type SidebarMenuAnchor, type SidebarMenuItem } from "./SidebarMenu";
import { mcpServerKey } from "./mcp-config-helpers";

const EMPTY_BUCKET: McpCategoryBucket = { categories: [], assignments: {} };

type Menu = {
  mode: "create" | "actions" | "rename" | "delete" | "move" | "skip-migration";
  id?: string;
  serverName?: string;
  opener: HTMLButtonElement;
  anchor: SidebarMenuAnchor;
};

/** Presentation-only categories. No MCP configuration or runtime actions enter here. */
export function McpCategoryList({ scope, cwd, servers, selected, renderServer }: {
  scope: McpScope;
  cwd?: string;
  servers: McpServerInfo[];
  selected: string | null;
  renderServer: (server: McpServerInfo) => ReactNode;
}) {
  const { t } = useI18n();
  const sheet = useIsMobile();
  const { preferences, apply, ready, loading, saving: pending, error: storeError, refresh, migrationBlocked, skipBrowserMigration } = useMcpCategories();
  const bucketKey = getMcpCategoryBucketKey(scope, cwd);
  const bucket = preferences.buckets[bucketKey] ?? EMPTY_BUCKET;
  const categories = bucket?.categories ?? [];
  const [menu, setMenu] = useState<Menu | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const collapsed = new Set(bucket.collapsed ?? []);
  const previousSelection = useRef<{ selected: string | null; category: string | null } | null>(null);
  const disabled = !ready || saving || pending;
  const root = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selectedServer = servers.find((server) => mcpServerKey(server) === selected);
  const selectedCategory = selectedServer ? categoryForServer(bucket, selectedServer.name) ?? "" : null;
  useEffect(() => {
    if (!ready) return;
    const previous = previousSelection.current;
    previousSelection.current = { selected, category: selectedCategory };
    // Restore saved folds on load; only a new selection/move reveals its row.
    if (previous && (previous.selected !== selected || previous.category !== selectedCategory) &&
      selectedCategory !== null && bucket.collapsed?.includes(selectedCategory)) {
      void apply({ type: "collapse", bucketKey, id: selectedCategory, collapsed: false }).catch(() => {});
    }
  }, [selected, selectedCategory, ready, bucket.collapsed, bucketKey, apply]);

  const shown = menu && (menu.serverName === undefined || servers.some((server) => server.name === menu.serverName))
    && (menu.id === undefined || categories.some((category) => category.id === menu.id)) ? menu : null;
  const menuCategory = categories.find((category) => category.id === shown?.id);
  const scopeName = t(scope === "project" ? "skills.scope.project" : "skills.scope.global");
  const open = (button: HTMLButtonElement, mode: Menu["mode"], values: { id?: string; serverName?: string } = {}) => {
    setError("");
    setDraft(categories.find((category) => category.id === values.id)?.name ?? "");
    setMenu({ mode, ...values, opener: button, anchor: { kind: "rect", rect: button.getBoundingClientRect(), align: "end" } });
  };
  const change = async (operation: McpCategoryOperation) => {
    if (savingRef.current || disabled) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await apply(operation);
      setMenu(null);
      // Moving a row or deleting a group can unmount the menu's opener.
      requestAnimationFrame(() => {
        if (menu?.opener.isConnected) return;
        const moved = [...(root.current?.querySelectorAll<HTMLButtonElement>("button[data-mcp-category-move]") ?? [])]
          .find((button) => button.dataset.mcpCategoryMove === (menu?.serverName === undefined ? undefined : encodeURIComponent(JSON.stringify(menu.serverName))));
        const target = moved?.getClientRects().length ? moved
          : moved?.closest(".mcp-category-section")?.querySelector<HTMLButtonElement>(".mcp-category-title") ?? addButton.current;
        target?.focus({ preventScroll: true });
      });
    } catch (failure) {
      setError(t(failure instanceof McpCategoryError
        ? failure.reason === "duplicate-name" ? "mcp.categories.duplicate" : "mcp.categories.invalid"
        : "mcp.categories.unsaved"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const items: SidebarMenuItem[] = shown?.mode === "move" ? [
    { type: "header", id: "move-label", label: t("mcp.categories.move", { name: revealHiddenCharacters(shown.serverName!) }) },
    ...[{ id: "", name: t("mcp.categories.uncategorized") }, ...categories].map((category): SidebarMenuItem => ({
      type: "item", id: category.id || "uncategorized", label: revealHiddenCharacters(category.name),
      checked: categoryForServer(bucket, shown.serverName!) === (category.id || null),
      onSelect: (event) => { event.keepOpen(); change({ type: "move", bucketKey, serverName: shown.serverName!, categoryId: category.id || null }); },
    })),
  ] : [
    { type: "item", id: "rename", label: t("mcp.categories.rename"), onSelect: (event) => { event.keepOpen(); setError(""); setDraft(menuCategory?.name ?? ""); setMenu((current) => current ? { ...current, mode: "rename" } : null); } },
    { type: "item", id: "delete", label: t("mcp.categories.delete"), danger: true, onSelect: (event) => { event.keepOpen(); setMenu((current) => current ? { ...current, mode: "delete" } : null); } },
  ];
  const skipMigration = async () => {
    if (savingRef.current || !migrationBlocked || loading || pending) return;
    savingRef.current = true; setSaving(true);
    try { await skipBrowserMigration(); setMenu(null); }
    catch { setError(t("mcp.categories.unsaved")); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const formTitle = shown?.mode === "skip-migration" ? t("mcp.categories.skipMigration")
    : shown?.mode === "rename" ? t("mcp.categories.rename") : shown?.mode === "delete" ? t("mcp.categories.delete") : t("mcp.categories.create");
  const form = shown && ["create", "rename", "delete", "skip-migration"].includes(shown.mode);
  const sections = [...categories, { id: "", name: t("mcp.categories.uncategorized") }];
  return <div className="mcp-category-list" ref={root}>
    {scope === "global" && loading && <div role="status" className="mcp-category-note">{t("mcp.categories.loading")}</div>}
    {scope === "global" && storeError && <div role="alert" className="mcp-category-note">
      {t(storeError === "migration-marker" ? "mcp.categories.migrationMarker" : "mcp.categories.unsaved")} <span>{storeError}</span>{" "}
      <button type="button" disabled={loading || pending || saving} onClick={() => void refresh()}>{t("i18n.refresh")}</button>
      {migrationBlocked && <>
        <p>{t("mcp.categories.migrationBlocked")}</p>
        <button type="button" disabled={loading || pending || saving} onClick={(event) => open(event.currentTarget, "skip-migration")}>{t("mcp.categories.skipMigration")}</button>
      </>}
    </div>}
    {sections.map((category, index) => {
      const members = servers.filter((server) => (categoryForServer(bucket, server.name) ?? "") === category.id);
      if (!category.id && members.length === 0) return null;
      const isCollapsed = collapsed.has(category.id);
      // DOM linkage need not URI-encode untrusted JSON/MCP names. Validation
      // rejects lone surrogates; this also keeps rendering total as a backstop.
      const contentId = `${id}-category-${index}`;
      const name = revealHiddenCharacters(category.name);
      return <div key={category.id} className="mcp-category-section" data-category-id={category.id}>
        <div className="mcp-category-heading">
          <button type="button" disabled={!ready} aria-disabled={disabled} className="mcp-category-title" aria-expanded={!isCollapsed} aria-controls={contentId} title={name}
            onClick={(event) => {
              if (disabled) return;
              if (!isCollapsed && document.getElementById(contentId)?.contains(document.activeElement)) event.currentTarget.focus();
              void apply({ type: "collapse", bucketKey, id: category.id, collapsed: !isCollapsed }).catch(() => {});
            }}>
            <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span><span>{name}</span><span>{members.length}</span>
          </button>
          {category.id && <button type="button" disabled={disabled} className="mcp-category-menu" aria-haspopup="menu" aria-label={t("mcp.categories.actions", { name })}
            onClick={(event) => open(event.currentTarget, "actions", { id: category.id })}>⋯</button>}
        </div>
        <div id={contentId} className="mcp-category-members" hidden={isCollapsed}>
          {members.length === 0 && <div className="mcp-category-note">{t("mcp.categories.empty")}</div>}
          {members.map((server) => <div key={server.name} className="mcp-category-server">
            {renderServer(server)}
            <button type="button" disabled={disabled} className="mcp-category-menu" data-mcp-category-move={encodeURIComponent(JSON.stringify(server.name))} aria-haspopup="menu"
              aria-label={t("mcp.categories.move", { name: revealHiddenCharacters(server.name) })}
              onClick={(event) => open(event.currentTarget, "move", { serverName: server.name })}>⋯</button>
          </div>)}
        </div>
      </div>;
    })}
    <button type="button" disabled={disabled} className="mcp-category-add" ref={addButton} aria-label={t("mcp.categories.createIn", { scope: scopeName })}
      onClick={(event) => open(event.currentTarget, "create")}>＋ {t("mcp.categories.create")}</button>
    {shown && <SidebarMenu open layer="settings" anchor={shown.anchor} sheet={sheet} ariaLabel={form ? formTitle : shown.mode === "move" ? t("mcp.categories.move", { name: revealHiddenCharacters(shown.serverName!) }) : t("mcp.categories.actions", { name: revealHiddenCharacters(menuCategory?.name ?? "") })}
      title={form ? formTitle : undefined} cancelLabel={t("sidebar.cancel")} returnFocusTo={shown.opener} onClose={() => setMenu(null)}
      items={form ? undefined : items} focusKey={shown.mode} width={280}>
      {form ? <form className="mcp-category-form" onSubmit={(event) => {
        event.preventDefault();
        if (shown.mode === "skip-migration") void skipMigration();
        else if (shown.mode === "delete") change({ type: "delete", bucketKey, id: shown.id! });
        else if (shown.mode === "rename") change({ type: "rename", bucketKey, id: shown.id!, name: draft });
        else change({ type: "create", bucketKey, id: crypto.randomUUID(), name: draft });
      }}>
        {shown.mode === "skip-migration" ? <p>{t("mcp.categories.skipMigrationNote")}</p> : shown.mode === "delete" ? <p>{t("mcp.categories.deleteNote", { name: revealHiddenCharacters(menuCategory?.name ?? "") })}</p> :
          <label>{t("mcp.categories.name")}<input value={draft} maxLength={80} aria-label={t("mcp.categories.name")} onChange={(event) => { setDraft(event.target.value); setError(""); }} /></label>}
        {error && <p role="alert">{error}</p>}
        <div className="mcp-category-form-actions">
          <button type="button" onClick={() => setMenu(null)}>{t("sidebar.cancel")}</button>
          <button type="submit" disabled={shown.mode === "skip-migration" ? !migrationBlocked || loading || pending || saving : disabled || (shown.mode !== "delete" && !draft.trim())}>
            {shown.mode === "skip-migration" ? t("mcp.categories.skipMigrationConfirm") : shown.mode === "delete" ? t("mcp.categories.delete") : t("i18n.save")}
          </button>
        </div>
      </form> : error ? <p role="alert" className="mcp-category-note">{error}</p> : undefined}
    </SidebarMenu>}
  </div>;
}
