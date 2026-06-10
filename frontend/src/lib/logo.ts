import { writable } from "svelte/store";

export const LOGOS = [
  { id: "straw-hat", label: "Straw Hat" },
  { id: "jolly-roger", label: "Jolly Roger" },
  { id: "devil-fruit", label: "Devil Fruit" },
] as const;

export type LogoId = (typeof LOGOS)[number]["id"];

const STORAGE_KEY = "one-pace-logo";
const DEFAULT_LOGO: LogoId = "straw-hat";

export function logoUrl(id: LogoId): string {
  return `/logos/${id}.svg`;
}

function getStored(): LogoId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && LOGOS.some((l) => l.id === v)) return v as LogoId;
  } catch {}
  return DEFAULT_LOGO;
}

export const logo = writable<LogoId>(getStored());

logo.subscribe((id) => {
  try { localStorage.setItem(STORAGE_KEY, id); } catch {}
  document.querySelector('link[rel="icon"]')?.setAttribute("href", logoUrl(id));
});
