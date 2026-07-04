// Theme toggle — persists to localStorage; initial theme is set inline in <head>.
const toggle = document.getElementById("theme-toggle");
toggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("bl.site.theme", next);
});

// Scroll-reveal: fade sections in as they enter the viewport. The hidden
// state is gated on this class so no-JS visitors see everything.
document.documentElement.classList.add("js");
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      }
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
);
document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
