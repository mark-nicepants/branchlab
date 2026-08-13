// Apply the persisted theme + background before the bundle loads to avoid a
// flash. Loaded as a classic blocking <script> in <head> of both index.html
// and index.browser.html.
(function () {
  var bg = {
    "github-copilot-dark": "#0a0c10",
    "default-dark": "#0d0e11",
    "one-dark": "#282c34",
    "tokyo-night": "#1a1b26",
    "catppuccin-mocha": "#1e1e2e",
    light: "#ffffff",
  };
  var t = localStorage.getItem("branchlab.theme") || "github-copilot-dark";
  var d = document.documentElement;
  d.dataset.theme = t;
  d.classList.toggle("dark", t !== "light");
  d.style.background = bg[t] || "#0d0e11";
})();
