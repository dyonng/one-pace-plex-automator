import { writable } from "svelte/store";

export type ThemePref = "auto" | "light" | "dark";

const STORAGE_KEY = "one-pace-theme";
const DARK_THEME  = "onepace";
const LIGHT_THEME = "onepace-light";

function getStored(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "auto") return v;
  } catch { /* private browsing / storage blocked */ }
  return "auto";
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true; // can't detect → fall back to dark
  }
}

function resolvedName(pref: ThemePref): string {
  if (pref === "dark")  return DARK_THEME;
  if (pref === "light") return LIGHT_THEME;
  return systemPrefersDark() ? DARK_THEME : LIGHT_THEME;
}

export function applyTheme(pref: ThemePref): void {
  document.documentElement.setAttribute("data-theme", resolvedName(pref));
}

// Run immediately at module load — before Svelte mounts — to avoid FOUC.
const _initial = getStored();
applyTheme(_initial);

export const themePref = writable<ThemePref>(_initial);

themePref.subscribe((pref) => {
  try { localStorage.setItem(STORAGE_KEY, pref); } catch {}
  applyTheme(pref);
});

// Re-apply when the OS preference flips (only matters when pref === "auto").
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    let current: ThemePref = "auto";
    const unsub = themePref.subscribe((v) => { current = v; });
    unsub();
    if (current === "auto") applyTheme("auto");
  });
}
