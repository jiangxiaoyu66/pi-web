type SavePicker = (options: { id: string; suggestedName: string }) => Promise<FileSystemFileHandle>;

export async function downloadSession(id: string, format: "md" | "jsonl", confirmation: string) {
  const browser = window as Window & { showSaveFilePicker?: SavePicker };
  const filename = `${id}.${format}`;
  let handle: FileSystemFileHandle | undefined;
  // Ask before fetching, while the menu click still carries user activation.
  if (typeof browser.showSaveFilePicker === "function") {
    try {
      handle = await browser.showSaveFilePicker({ id: "session-download", suggestedName: filename });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
  } else if (!browser.confirm(confirmation)) return;

  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/download?format=${format}`, { cache: "no-store", redirect: "error" });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
  }
  if (handle && response.body) {
    await response.body.pipeTo(await handle.createWritable());
    return;
  }
  const blob = await response.blob();
  if (handle) {
    await blob.stream().pipeTo(await handle.createWritable());
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
