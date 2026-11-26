export const fileCloseActions = ["this", "others", "left", "right", "all"] as const;
type Action = typeof fileCloseActions[number];

/** Input is the displayed (possibly drag-reordered) panel strip. */
export function fileCloseTargets(tabs: readonly { id: string; kind?: string }[], anchor: string, action: Action): string[] {
  const files = tabs.filter(tab => tab.kind === undefined);
  const index = files.findIndex(tab => tab.id === anchor);
  if (index < 0) return [];
  return files.filter((_, i) => {
    switch (action) {
      case "this": return i === index;
      case "others": return i !== index;
      case "left": return i < index;
      case "right": return i > index;
      case "all": return true;
    }
  }).map(tab => tab.id);
}
