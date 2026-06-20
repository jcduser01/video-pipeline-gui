// src/theme.ts — explicit light/dark toggle (SADD §2.1).
// Single responsibility: apply a theme by setting data-theme on <html> and
// persist the choice. REQUIREMENT: ignore the OS `prefers-color-scheme` entirely
// — the control tower's theme is an explicit operator choice, never inherited.
// Both palettes live in styles.css as CSS-variable blocks keyed on data-theme.

import { store } from "./state";
import type { Theme } from "./types";

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
}

/** Initialise from persisted state (default dark). Never reads OS preference. */
export function initTheme(): Theme {
  const theme = store.getTheme();
  applyTheme(theme);
  return theme;
}

export function toggleTheme(): Theme {
  const next: Theme = store.getTheme() === "dark" ? "light" : "dark";
  store.setTheme(next);
  applyTheme(next);
  return next;
}
