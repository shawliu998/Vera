import type { VeraTheme } from "./veraModelSettingsApi";

const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export interface VeraThemeDocumentRoot {
  classList: Pick<DOMTokenList, "toggle">;
  dataset: DOMStringMap;
  style: Pick<CSSStyleDeclaration, "colorScheme">;
}

export interface VeraThemeMedia {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

function setResolvedTheme(
  root: VeraThemeDocumentRoot,
  theme: VeraTheme,
  prefersDark: boolean,
): void {
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
  root.dataset.veraTheme = theme;
  root.dataset.veraResolvedTheme = dark ? "dark" : "light";
  root.style.colorScheme = dark ? "dark" : "light";
}

/**
 * Apply a server-persisted theme and keep `system` synchronized. The returned
 * cleanup always removes the exact media listener installed by this call.
 */
export function installVeraTheme(
  theme: VeraTheme,
  options: {
    root?: VeraThemeDocumentRoot;
    media?: VeraThemeMedia;
  } = {},
): () => void {
  const root = options.root ?? document.documentElement;
  const media =
    options.media ??
    (typeof window !== "undefined"
      ? window.matchMedia(SYSTEM_DARK_QUERY)
      : undefined);
  const apply = () => setResolvedTheme(root, theme, media?.matches ?? false);
  apply();
  if (theme !== "system" || !media) return () => undefined;
  media.addEventListener("change", apply);
  return () => media.removeEventListener("change", apply);
}

export { SYSTEM_DARK_QUERY as VERA_SYSTEM_DARK_QUERY };
