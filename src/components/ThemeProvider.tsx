import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES } from "@/lib/themes";

const STORAGE_KEY = "openscope.theme";

interface ThemeCtxValue {
  theme: string;
  setTheme: (id: string) => void;
  /** Apply a theme transiently (hover preview) without committing/persisting. */
  previewTheme: (id: string) => void;
  /** Revert any preview back to the committed theme. */
  clearPreview: () => void;
}

const ThemeCtx = createContext<ThemeCtxValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  previewTheme: () => {},
  clearPreview: () => {},
});

/** Apply a theme's tokens to <html> (no persistence). */
function applyTheme(id: string) {
  const def = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement;
  root.dataset.theme = def.id;
  // Our `[data-theme]` blocks are defined after `.dark`, so they win on ties;
  // keeping `.dark` in sync lets shadcn's `dark:` variants behave too.
  root.classList.toggle("dark", def.group === "Dark");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME,
  );

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const value: ThemeCtxValue = {
    theme,
    setTheme,
    previewTheme: applyTheme,
    clearPreview: () => applyTheme(theme),
  };

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
