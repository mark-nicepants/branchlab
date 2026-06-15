// Theme registry. Each id has a matching `[data-theme="id"]` block in index.css.

export interface ThemeDef {
  id: string;
  label: string;
  group: "Dark" | "Light";
}

export const THEMES: ThemeDef[] = [
  { id: "default-dark", label: "Default Dark", group: "Dark" },
  { id: "one-dark", label: "One Dark", group: "Dark" },
  { id: "tokyo-night", label: "Tokyo Night", group: "Dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", group: "Dark" },
  { id: "light", label: "Light", group: "Light" },
];

export const DEFAULT_THEME = "default-dark";
