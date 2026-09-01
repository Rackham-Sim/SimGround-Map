// Per-browser "Interface scale" preference - the web-side mirror of the
// native panel's settings::UiSettings::uiScale slider (src/ui/Settings.h,
// ui::DrawWindowCallback). Same reasoning as i18n.js's language pref for
// keeping it in localStorage rather than the shared /api/settings: the
// browser and the in-sim panel are potentially different physical screens,
// so there is no single "the" scale to sync between them.
//
// Applied as a CSS `zoom` on <body> (see style.css). `zoom` scales layout,
// text and the <canvas> together and keeps pointer coordinates consistent,
// which a `transform: scale()` would not. #app compensates its width/height
// with calc(100% / var(--ui-zoom)) so the shell still fits the viewport
// exactly and the airport list / map keep their own internal scrolling.

const KEY = "sgm-ui-scale";

// Fixed presets, not a continuous range: dragging a slider re-ran the
// `zoom` reflow on every input event, so the whole window jumped around
// under the cursor mid-drag (real-usage report). Mirrors the native
// panel's preset buttons (ui::DrawSettingsButton).
export const UI_SCALE_PRESETS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
const UI_SCALE_MIN = UI_SCALE_PRESETS[0];
const UI_SCALE_MAX = UI_SCALE_PRESETS[UI_SCALE_PRESETS.length - 1];

function clamp(v) {
    if (!Number.isFinite(v)) return 1;
    return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, v));
}

let current = clamp(parseFloat(localStorage.getItem(KEY)) || 1);

export function getUiScale() {
    return current;
}

export function applyUiScale() {
    document.documentElement.style.setProperty("--ui-zoom", String(current));
}

export function setUiScale(v) {
    current = clamp(v);
    localStorage.setItem(KEY, String(current));
    applyUiScale();
}

// Called once at boot (app.js), before the first poll, so the page paints
// at the stored scale straight away.
export function initUiScale() {
    applyUiScale();
}
