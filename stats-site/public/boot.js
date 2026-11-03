// Classic (non-module) script loaded in <head> on purpose, for two jobs that
// cannot wait for the deferred stats.js module:
//
// 1. Restore the visitor's stored theme before the first paint, so a stored
//    choice does not flash the other theme.
// 2. Notice when the module never runs at all (a blocked script, a copy opened
//    from file://, a broken deploy): after ten seconds without the module's
//    `data-state` stamp, the page says so instead of showing "loading…" forever.
(function boot() {
  try {
    var stored = window.localStorage.getItem("patch-stats.theme");
    if (stored === "dark" || stored === "light") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (error) {
    // Storage can be blocked or absent; the prefers-color-scheme CSS applies.
  }

  window.setTimeout(function markScriptMissing() {
    if (document.documentElement.hasAttribute("data-state")) {
      return;
    }
    var banner = document.getElementById("page-banner");
    if (banner) {
      banner.className = "banner banner--danger";
      banner.textContent = "Stats are temporarily unavailable. The page script did not load.";
      banner.hidden = false;
    }
    var metas = document.querySelectorAll(".kpi-meta-text");
    for (var index = 0; index < metas.length; index += 1) {
      metas[index].textContent = "unavailable";
    }
    var state = document.getElementById("charts-state");
    if (state) {
      state.querySelector("p").textContent = "Stats are temporarily unavailable.";
      state.hidden = false;
    }
    var sections = ["updates", "velocity"];
    for (var position = 0; position < sections.length; position += 1) {
      var section = document.getElementById(sections[position]);
      if (section) {
        section.hidden = true;
      }
    }
  }, 10000);
})();
