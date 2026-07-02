// Theme registry. Each id has a matching `[data-theme="id"]` block in index.css.

export interface ThemeDef {
  id: string;
  label: string;
  group: "Dark" | "Light";
}

export const THEMES: ThemeDef[] = [
  { id: "github-copilot-dark", label: "Github Co-pilot Dark", group: "Dark" },
  { id: "default-dark", label: "Default Dark", group: "Dark" },
  { id: "one-dark", label: "One Dark", group: "Dark" },
  { id: "tokyo-night", label: "Tokyo Night", group: "Dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", group: "Dark" },
  { id: "dracula", label: "Dracula", group: "Dark" },
  { id: "nord", label: "Nord", group: "Dark" },
  { id: "github-dark", label: "GitHub Dark", group: "Dark" },
  { id: "gruvbox-dark", label: "Gruvbox Dark", group: "Dark" },
  { id: "rose-pine", label: "Rosé Pine", group: "Dark" },
  { id: "light", label: "Light", group: "Light" },
  { id: "github-light", label: "GitHub Light", group: "Light" },
  { id: "solarized-light", label: "Solarized Light", group: "Light" },
  { id: "catppuccin-latte", label: "Catppuccin Latte", group: "Light" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn", group: "Light" },
];

export const DEFAULT_THEME = "github-copilot-dark";
