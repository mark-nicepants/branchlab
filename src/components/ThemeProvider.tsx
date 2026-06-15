import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES } from "@/lib/themes";

const STORAGE_KEY = "openscope.theme";

interface ThemeCtxValue {
  theme: string;
  setTheme: (id: string) => void;
}

const ThemeCtx = createContext<ThemeCtxValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME,
  );

  useEffect(() => {
    const def = THEMES.find((t) => t.id === theme) ?? THEMES[0];
    const root = document.documentElement;
    root.dataset.theme = def.id;
    // Keep `.dark` in sync so shadcn's `dark:` variants behave; our
    // `[data-theme]` blocks are defined after `.dark`, so they win on ties.
    root.classList.toggle("dark", def.group === "Dark");
    localStorage.setItem(STORAGE_KEY, def.id);
  }, [theme]);

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
