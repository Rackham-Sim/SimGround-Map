# Web frontend

Vanilla HTML/CSS/JS (ES modules, no build step) served at `/` by the
plugin's embedded HTTP server (`net::WebServer`) whenever the web interface
is enabled in settings. Reproduces the native ImGui panel's full
functionality - airport list, ground map with live GPS, ATIS, interactive
taxi-route selection, settings - against the REST/SSE API documented in
`NOTES.md (section 26)`. See `NOTES.md (section 27)` for the technical
choices behind this implementation (Canvas 2D map rendering, client-side
GPS reprojection, deviations from the native UI, test results).

- `index.html` - page shell, all panels/modals as static markup
- `css/style.css` - palette lifted from `src/ui/Theme.h`/`Theme.cpp`
- `js/api.js` - fetch/SSE wrappers for every `/api/...` route
- `js/airports.js`, `js/map.js`, `js/atis.js`, `js/settings.js`, `js/gps.js`
  - one module per panel/concern
- `js/app.js` - bootstrap + polling loops, wires the modules together
- `fonts/` - Roboto Medium + Cousine Regular, copied from the already-
  vendored `third_party/imgui/misc/fonts/` (same Apache-2.0 files the
  native UI embeds, reused here for visual consistency)
