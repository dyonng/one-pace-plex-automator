import { writable } from "svelte/store";

export type ThemePref = "auto" | "light" | "dark" | "other";

const STORAGE_KEY        = "one-pace-theme";
const CUSTOM_STORAGE_KEY = "one-pace-theme-custom";
const DARK_THEME         = "dark";
const LIGHT_THEME        = "light";

export const DAISYUI_THEMES = [
  "light", "dark", "cupcake", "bumblebee", "emerald", "corporate",
  "synthwave", "retro", "cyberpunk", "valentine", "halloween", "garden",
  "forest", "aqua", "lofi", "pastel", "fantasy", "wireframe", "black",
  "luxury", "dracula", "cmyk", "autumn", "business", "acid", "lemonade",
  "night", "coffee", "winter", "dim", "nord", "sunset",
] as const;

export type DaisyTheme = (typeof DAISYUI_THEMES)[number];

function getStored(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "auto" || v === "other") return v;
  } catch {}
  return "auto";
}

function getStoredCustom(): DaisyTheme {
  try {
    const v = localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (v && (DAISYUI_THEMES as readonly string[]).includes(v)) return v as DaisyTheme;
  } catch {}
  return "synthwave";
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

function resolvedName(pref: ThemePref, custom: DaisyTheme): string {
  if (pref === "dark")  return DARK_THEME;
  if (pref === "light") return LIGHT_THEME;
  if (pref === "other") return custom;
  return systemPrefersDark() ? DARK_THEME : LIGHT_THEME;
}

function applyResolved(pref: ThemePref, custom: DaisyTheme): void {
  document.documentElement.setAttribute("data-theme", resolvedName(pref, custom));
}

// Apply before Svelte mounts to prevent FOUC.
const _initPref   = getStored();
const _initCustom = getStoredCustom();
applyResolved(_initPref, _initCustom);

export const themePref   = writable<ThemePref>(_initPref);
export const customTheme = writable<DaisyTheme>(_initCustom);

// Keep a local mirror so both subscribers can read each other's current value.
let _pref   = _initPref;
let _custom = _initCustom;

themePref.subscribe((pref) => {
  _pref = pref;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch {}
  applyResolved(_pref, _custom);
});

customTheme.subscribe((custom) => {
  _custom = custom;
  try { localStorage.setItem(CUSTOM_STORAGE_KEY, custom); } catch {}
  applyResolved(_pref, _custom);
});

// Re-apply when OS preference changes while in Auto mode.
if (typeof window !== "undefined") {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (_pref === "auto") applyResolved("auto", _custom);
  });
}
