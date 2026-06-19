// src/state.ts — thin, debounced wrapper over read_state/write_state (SADD §2.1).
// Single responsibility: own the in-memory copy of the persisted kv model, expose
// typed getters/setters, and flush writes to the backend on a debounce so rapid
// form edits don't hammer the IPC boundary. No business logic — just persistence.

import { ipc } from "./ipc";
import type { AppState, SessionState, Theme } from "./types";

const WRITE_DEBOUNCE_MS = 350;

function emptyState(): AppState {
  return {
    projects: {},
    session: { formValues: {} },
  };
}

class StateStore {
  private state: AppState = emptyState();
  private loaded = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribers: Set<(s: AppState) => void> = new Set();

  async load(): Promise<AppState> {
    const persisted = await ipc.readState();
    if (persisted) {
      // Merge defensively — the backend may predate fields we now expect.
      this.state = {
        ...emptyState(),
        ...persisted,
        projects: persisted.projects ?? {},
        session: {
          formValues: {},
          ...(persisted.session ?? {}),
        },
      };
    }
    this.loaded = true;
    return this.state;
  }

  get(): AppState {
    return this.state;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  subscribe(fn: (s: AppState) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private notify(): void {
    for (const fn of this.subscribers) fn(this.state);
  }

  // ---- session helpers ----

  session(): SessionState {
    return this.state.session;
  }

  getFormValue(key: string): unknown {
    return this.state.session.formValues[key];
  }

  setFormValue(key: string, value: unknown): void {
    this.state.session.formValues[key] = value;
    this.scheduleFlush();
    this.notify();
  }

  getTheme(): Theme {
    return this.state.session.theme ?? "dark";
  }

  setTheme(theme: Theme): void {
    this.state.session.theme = theme;
    this.scheduleFlush();
  }

  getPreviewLayer(): string | undefined {
    return this.state.session.previewLayer;
  }

  setPreviewLayer(id: string | undefined): void {
    this.state.session.previewLayer = id;
    this.scheduleFlush();
  }

  // ---- project helpers ----

  activeProjectRoot(): string | undefined {
    const name = this.state.active_project;
    if (!name) return undefined;
    return this.state.projects[name];
  }

  // ---- flush ----

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, WRITE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await ipc.writeState(this.state);
    } catch {
      /* persistence is best-effort; never block the UI on a write */
    }
  }
}

export const store = new StateStore();
