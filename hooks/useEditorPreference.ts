"use client";

import { useSyncExternalStore } from "react";
import type { Editor } from "@/lib/editor-links";

export const EDITOR_PREFERENCE_KEY = "pi-web:editor";
let preference: Editor | null = null;
const listeners = new Set<() => void>();
const parse = (raw: unknown): Editor | null => raw === "vscode" || raw === "cursor" ? raw : null;
function readStored(): Editor | null {
  try { return parse(window.localStorage.getItem(EDITOR_PREFERENCE_KEY)); }
  catch { return preference; }
}
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== EDITOR_PREFERENCE_KEY) return;
  preference = readStored();
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  if (!listeners.size) {
    preference = readStored();
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
export function setEditorPreference(next: Editor) {
  const parsed = parse(next);
  if (!parsed) return;
  preference = parsed;
  try { window.localStorage.setItem(EDITOR_PREFERENCE_KEY, parsed); } catch { /* page-only choice */ }
  listeners.forEach((listener) => listener());
}
export function useEditorPreference(): Editor | null {
  return useSyncExternalStore(subscribe, () => preference, () => null);
}
