// src/dnd.ts — drag-and-drop onto path pickers (SADD §3.4, nice-to-have).
// Single responsibility: accept a native file/folder drop onto a picker control,
// validate it against that picker's PathSpec, and write the path in. Compatible
// drop zones highlight while a drag is in flight.
//
// File *paths* are only available through Tauri's drag-drop events (the HTML5
// drop event in a webview yields no real filesystem path), so this is a no-op in
// a plain browser — Browse still works there via the prompt fallback.
//
// Tauri reports a drag position in PHYSICAL pixels relative to the webview, but
// `drop` may omit it and the physical/logical mapping varies by platform — so we
// don't rely on the drop coordinate alone. We track the hovered row during the
// drag and, failing that, drop into the sole eligible picker.

import { tauriAvailable } from "./dialog";

const PICKER_SEL = ".field__pickerrow";

/** Does this dropped path satisfy the picker's declared kind/extensions? */
function rowAccepts(row: HTMLElement, path: string): boolean {
  const kind = row.dataset.pathKind ?? "file";
  // Directories: we can't tell file-vs-folder from the string alone, so accept
  // any drop and let the CLI validate. (Extension masking is the file case.)
  if (kind === "directory") return true;
  const exts = (row.dataset.pathExt ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (exts.length === 0) return true; // unfiltered file picker
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m !== null && exts.includes(m[1]);
}

function allRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(PICKER_SEL));
}

function eligibleRows(path: string): HTMLElement[] {
  return allRows().filter((r) => rowAccepts(r, path));
}

/** Write a dropped path into the picker's text input and notify the form. */
function applyDrop(row: HTMLElement, path: string): void {
  const input = row.querySelector<HTMLInputElement>("input");
  if (!input) return;
  input.value = path;
  // Reuse the form's own change wiring (persist + re-resolve preview).
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function clearHighlights(): void {
  document
    .querySelectorAll(`${PICKER_SEL}.dnd-eligible, ${PICKER_SEL}.dnd-over`)
    .forEach((el) => el.classList.remove("dnd-eligible", "dnd-over"));
}

/**
 * Map a Tauri drag position to the picker row under the cursor. Tauri gives
 * physical pixels, but the logical/physical mapping isn't guaranteed, so try the
 * dpr-scaled coordinate first and the raw coordinate as a fallback.
 */
function rowAtPosition(x: number, y: number): HTMLElement | null {
  const dpr = window.devicePixelRatio || 1;
  for (const [cx, cy] of [
    [x / dpr, y / dpr],
    [x, y],
  ]) {
    const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
    const row = (el?.closest(PICKER_SEL) as HTMLElement | null) ?? null;
    if (row) return row;
  }
  return null;
}

/**
 * Subscribe to the webview's drag-drop events. Safe to call once at boot; a
 * no-op outside Tauri. Returns an unlisten fn (unused at the app root).
 */
export async function setupDragDrop(): Promise<() => void> {
  if (!tauriAvailable()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");

  // `over` carries no paths in Tauri v2 — remember what `enter` reported. We also
  // remember the row currently under the cursor so `drop` works even if its
  // position is absent or maps imperfectly.
  let lastPath: string | undefined;
  let hoverRow: HTMLElement | null = null;

  const repaint = (path: string | undefined, pos?: { x: number; y: number }) => {
    clearHighlights();
    hoverRow = null;
    if (!path) return;
    for (const r of eligibleRows(path)) r.classList.add("dnd-eligible");
    if (pos) {
      const hit = rowAtPosition(pos.x, pos.y);
      if (hit && rowAccepts(hit, path)) {
        hoverRow = hit;
        hit.classList.add("dnd-over");
      }
    }
  };

  const unlisten = await getCurrentWebview().onDragDropEvent((ev) => {
    const p = ev.payload as {
      type: "enter" | "over" | "drop" | "leave";
      paths?: string[];
      position?: { x: number; y: number };
    };

    if (p.type === "enter") {
      lastPath = p.paths?.[0];
      repaint(lastPath, p.position);
    } else if (p.type === "over") {
      repaint(lastPath, p.position);
    } else if (p.type === "leave") {
      lastPath = undefined;
      hoverRow = null;
      clearHighlights();
    } else if (p.type === "drop") {
      const path = p.paths?.[0] ?? lastPath;
      const positioned = p.position ? rowAtPosition(p.position.x, p.position.y) : null;
      // Resolution order: the row under the drop point, else the row last hovered
      // during the drag, else the only eligible picker on screen.
      let target = positioned ?? hoverRow;
      if (!target && path) {
        const elig = eligibleRows(path);
        if (elig.length === 1) target = elig[0];
      }
      clearHighlights();
      lastPath = undefined;
      hoverRow = null;
      if (path && target && rowAccepts(target, path)) applyDrop(target, path);
    }
  });

  return unlisten;
}
