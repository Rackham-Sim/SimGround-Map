// Ground map canvas - ported from PanelMap.cpp's ImDrawList rendering to
// Canvas 2D. Screen-space math (bounds/projection/ToScreen, click hit
// testing, parking clustering, rotated runway-end labels, zoom-dependent
// taxiway signage) mirrors that file line-for-line since both are y-down
// screen coordinate systems.
import { api } from "./api.js";
import { buildRunwayUsage } from "./atis.js";
import { t } from "./i18n.js";

const MARGIN_M = 80;
const MIN_ZOOM = 0.2;
// Raised from 8 - real-usage report: some parking stands stayed merged
// into one cluster marker even at max zoom. Matches PanelMap.cpp's own
// kMaxZoom/kParkingClusterGridPx bump for the same reason.
const MAX_ZOOM = 24;
const ZOOM_BUTTON_FACTOR = 1.25;
const CLICK_DRAG_THRESHOLD_PX = 6;
const EDGE_HIT_RADIUS_PX = 8;
const EDGE_HIT_RADIUS_TOUCH_PX = 16;
// Mirrors PanelMap.cpp's kNodeCaptureRadiusMeters - gates the active-segment
// truncation below on real proximity, not just distance-along-the-infinite-
// line clamping. Without this, an aircraft anywhere off to one side of a
// freshly-selected chain (e.g. right after a click, before any real
// progress has been made) still projects onto SOME point on the edge, most
// often clamped hard to whichever endpoint is nearer - if that's the edge's
// own end point, the whole edge silently draws as a zero-length, invisible
// line (real-usage report: a just-selected chain not highlighting at all).
const NODE_CAPTURE_RADIUS_M = 25;
const PARKING_CLUSTER_GRID_PX = 30;
// Mirrors PanelMap.cpp's kTaxiwaySegmentLabelZoomThreshold - below this,
// one label per taxiway NAME (taxiwayNameLabels); at/above it, one label
// per real junction-to-junction chain (taxiwayChainLabels). Both lists are
// server-computed via real chain-connectivity walks (AirportDatabase.cpp),
// not derived here from any one taxiway segment's own endpoints.
const TAXIWAY_SEGMENT_LABEL_ZOOM_THRESHOLD = 2;

const canvas = document.getElementById("map-canvas");
const wrap = document.getElementById("map-canvas-wrap");
const ctx = canvas.getContext("2d");
const placeholder = document.getElementById("map-placeholder");

// Cached once instead of re-queried by getElementById every render() call -
// real-usage report ("la version web n'est pas très fluide"): updateHeader()
// runs inside the 60fps requestAnimationFrame loop, and unlike canvas draws,
// writing to the DOM (even to an unchanged value) forces the browser to
// redo style recalculation - six lookups plus half a dozen writes every
// single frame was measurable jank, most of it for text that only actually
// changes a few times a minute (ICAO, name, badges, zoom%).
const headerEls = {
    icao: document.getElementById("map-icao"),
    name: document.getElementById("map-name"),
    status: document.getElementById("map-status"),
    noRouteBadge: document.getElementById("no-route-badge"),
    zoomPct: document.getElementById("zoom-pct"),
    clearRouteBtn: document.getElementById("clear-route-btn"),
};

let icao = "";
let mapData = null; // last GET /api/airport/{icao}/map body
let taxiEdges = null; // full indexed edge list from GET .../taxi-network, or null
let routeSelection = { edgeIndices: [], nodeSequence: [], edges: [], nextRequiredNodeIndex: 1 };
let liveAircraft = null; // {lat, lon, groundSpeedKt, headingDeg, headingMagDeg, onAirport, onGround, traffic} from SSE
let projectedAircraft = null; // {x, y} derived from liveAircraft + mapData.origin*
let atisForActiveAirport = null; // AtisResult for `icao`, or null if not fetched - drives the DEP/ARR/closed runway dots
// buildRunwayUsage() (regex split + array scans) result, recomputed only
// when the ATIS payload changes rather than every render frame.
let runwayUsageForActiveAirport = null;

// Smoothed aircraft ICON position/heading - ported from PanelMap.cpp's
// gSmoothedAircraftPos (native parity, same technique/tau). projectedAircraft
// only updates once per SSE event (~150ms), so drawing the icon straight at
// that raw value every animation frame (~16ms) reads as a stutter (holds
// still, then jumps) - real-usage report ("le mouvement de l'avion... est un
// peu saccadé"). Reset (snapped, not eased) on an ICAO change or whenever
// the icon reappears after being out of range - see their own reset sites.
let smoothedAircraftPos = { x: 0, y: 0 };
let smoothedAircraftHeadingDeg = 0;
let aircraftSmoothingValid = false;

let zoom = 1;
let panOffset = { x: 0, y: 0 };
// Rotation is always expressed as one angle, around the canvas center:
// user-driven directly (right-click-drag, see the pointer handlers below)
// while trackMode is "off", or smoothly chased toward -heading each frame
// while trackMode is "heading" (see render()). Persists across an "off"
// <-> track-mode transition rather than snapping to 0, so cancelling
// tracking mid-turn doesn't jump the view.
let rotationDeg = 0;
let lastIcaoForView = "";

// "off": free pan/zoom/rotate, no auto-centering. "north": re-centers on
// the aircraft every frame, forces rotationDeg back to 0. "heading":
// re-centers AND smoothly rotates rotationDeg toward -heading (real
// heading-up moving-map behavior). Cancelled by any manual drag/pinch/
// right-drag (see the pointer handlers below) so a user interaction isn't
// immediately fought by the next frame's auto-recenter.
let trackMode = "off";
const trackNorthBtn = document.getElementById("track-north-btn");
const trackHeadingBtn = document.getElementById("track-heading-btn");
function updateTrackButtons() {
    trackNorthBtn.classList.toggle("track-active", trackMode === "north");
    trackHeadingBtn.classList.toggle("track-active", trackMode === "heading");
}
function setTrackMode(mode) {
    trackMode = trackMode === mode ? "off" : mode;
    updateTrackButtons();
    requestRender();
}

// Camera smoothing while tracking - the underlying aircraft position/
// heading only update a few times a second (SSE ~300ms), so panning/
// rotating straight to that raw target every frame reads as a stutter
// (holds still, then teleports) rather than smooth motion - real-usage
// report ("fluidifier la carte"). Exponential damping instead, with a
// time constant so it stays consistent regardless of frame rate.
const TRACK_SMOOTHING_TAU_SEC = 0.35;
let lastRenderTimeMs = null;

// Shortest signed angular distance from `from` to `to` (handles the 0/360
// wrap - a naive lerp would spin the long way around near it). Floor-based
// wrap rather than a fixed "+540" offset - rotationDeg accumulates without
// ever being normalized (manual right-drag just keeps adding to it, see the
// pointermove handler below), so `from` can drift arbitrarily far from
// [-180, 180) over a long session of spinning the map around.
function angleLerpDeg(from, to, alpha) {
    let delta = to - from;
    delta -= 360 * Math.floor((delta + 180) / 360);
    return from + delta * alpha;
}

let onEdgeClicked = () => {};
let onClearRoute = () => {};
let onGateClicked = () => {};
let onGateSelected = () => {};

const PARKING_HIT_RADIUS_PX = 8;
const PARKING_HIT_RADIUS_TOUCH_PX = 16;

// measureText() cache for taxiway-sign labels - the font is fixed and each
// airport's label set is small and static, but drawTaxiwaySign runs per
// sign per frame. Cleared in setMapData (new airport) and once the webfont
// finishes loading (so any width measured against the fallback font is
// dropped).
const signWidthCache = new Map();
if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => signWidthCache.clear());
}

// getComputedStyle() forces a synchronous style recalculation - cheap to
// call once, expensive if called per-drawn-element (real-usage report: the
// web view visibly lagged at busy airports, where the parking-cluster loop
// below used to call it 1-2x per cluster, every animation frame). Read the
// CSS custom properties once per render() call instead and have every
// per-element draw call read from this cache.
const cssCache = { accent: "#00e5ff", border2: "", text: "" };
function refreshCssCache() {
    const s = getComputedStyle(document.documentElement);
    cssCache.accent = s.getPropertyValue("--accent").trim() || "#00e5ff";
    cssCache.border2 = s.getPropertyValue("--border2").trim();
    cssCache.text = s.getPropertyValue("--text").trim();
}

function accentColor() {
    return cssCache.accent;
}

function routeHighlightColor() {
    const accent = accentColor().toLowerCase();
    // Mirrors RouteHighlightColor()'s White->Cyan substitution (a white
    // route line would be indistinguishable from taxiway-sign/runway-label
    // near-white text) - compare against the White swatch's hex directly.
    return accent === "#ffffff" ? "#00e5ff" : accent;
}

// resizeCanvasToDisplaySize() reads wrap.clientWidth/Height AND
// getBoundingClientRect() - three synchronous layout reads, every frame of
// the 60fps render loop, for values that only change on a resize, a
// devicePixelRatio change (browser zoom) or an Interface-scale change. Cache
// the result and only recompute when one of those fires (see
// invalidateLayout / the listeners in initMapPanel).
let layoutDirty = true;
let sizeCache = { w: 1, h: 1, sx: 1, sy: 1 };
// getBoundingClientRect() of the canvas, cached for the same reasons -
// canvasRelativePos() runs on every pointermove during a pan/rotate drag.
let canvasRectCache = null;

function invalidateLayout() {
    layoutDirty = true;
    canvasRectCache = null;
}

function canvasRect() {
    if (!canvasRectCache) canvasRectCache = canvas.getBoundingClientRect();
    return canvasRectCache;
}

function resizeCanvasToDisplaySize() {
    if (!layoutDirty) return sizeCache;
    layoutDirty = false;
    const dpr = window.devicePixelRatio || 1;
    // Logical drawing size (CSS px, before any CSS `zoom` from the
    // "Interface scale" setting) - everything below draws in this space.
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    // Real on-screen size (after `zoom`): size the backing store from this
    // so the map stays crisp at Interface scale > 100% instead of a
    // zoom-blurred smaller buffer.
    const rect = wrap.getBoundingClientRect();
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }
    // Maps the logical (w,h) coordinate space onto the backing store.
    const sx = w > 0 ? bw / w : dpr;
    const sy = h > 0 ? bh / h : dpr;
    sizeCache = { w, h, sx, sy };
    return sizeCache;
}

// Bounding box of the airport's static geometry (runways + taxiways +
// parking) - constant for a given map payload, but computeBounds runs every
// frame. Cache it keyed on the payload object identity (setMapData swaps in
// a fresh object each poll), so the potentially-thousands-of-segments scan
// happens once per poll instead of ~60x/second.
let staticBoundsCache = null;
let staticBoundsFor = null;
function computeStaticBounds(map) {
    if (staticBoundsFor === map && staticBoundsCache) return staticBoundsCache;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const add = (x, y) => {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    for (const r of map.runways) { add(r.x1, r.y1); add(r.x2, r.y2); }
    for (const t of map.taxiways) { add(t.x1, t.y1); add(t.x2, t.y2); }
    for (const p of map.parking) { add(p.x, p.y); }
    staticBoundsCache = { minX, minY, maxX, maxY };
    staticBoundsFor = map;
    return staticBoundsCache;
}

function computeBounds(map, includeAircraft) {
    const s = computeStaticBounds(map);
    let minX = s.minX, minY = s.minY, maxX = s.maxX, maxY = s.maxY;
    if (includeAircraft && projectedAircraft) {
        minX = Math.min(minX, projectedAircraft.x); maxX = Math.max(maxX, projectedAircraft.x);
        minY = Math.min(minY, projectedAircraft.y); maxY = Math.max(maxY, projectedAircraft.y);
    }
    if (minX > maxX) { minX = -1; maxX = 1; minY = -1; maxY = 1; }
    return { minX: minX - MARGIN_M, minY: minY - MARGIN_M, maxX: maxX + MARGIN_M, maxY: maxY + MARGIN_M };
}

function makeProjection(b, canvasW, canvasH) {
    const worldW = Math.max(1, b.maxX - b.minX);
    const worldH = Math.max(1, b.maxY - b.minY);
    const scale = Math.min(canvasW / worldW, canvasH / worldH);
    const usedW = worldW * scale;
    const usedH = worldH * scale;
    const originX = (canvasW - usedW) * 0.5;
    const originY = (canvasH - usedH) * 0.5;
    return {
        scale,
        toScreen(x, y) {
            return { x: originX + (x - b.minX) * scale, y: originY + (b.maxY - y) * scale };
        },
    };
}

function clampZoom() {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// Equirectangular projection matching src/airport/GeoProjection.h exactly -
// lets the SSE-driven live position be plotted on the canvas without
// re-fetching the whole ground map on every tick.
function projectLatLon(lat, lon) {
    if (!mapData) return null;
    const originLat = mapData.originLat, originLon = mapData.originLon;
    const metersPerDegLat = 111320.0;
    const metersPerDegLon = 111320.0 * Math.cos((originLat * Math.PI) / 180);
    return { x: (lon - originLon) * metersPerDegLon, y: (lat - originLat) * metersPerDegLat };
}

function drawRotatedText(text, x, y, angleRad, color, font) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angleRad);
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, 0);
    ctx.restore();
}

// apt.dat runway-end identifiers carry a leading zero ("09L"); the ATIS
// runway parser's regex accepts both conventions and typically stores the
// unpadded one ("9L") - matches PanelMap.cpp's NormalizeRunwayDesignator.
function normalizeRunwayDesignator(s) {
    return s.length > 1 && s[0] === "0" ? s.slice(1) : s;
}

function findRunwayUsage(usage, label) {
    const normalized = normalizeRunwayDesignator(label);
    return usage.find((u) => normalizeRunwayDesignator(u.designator) === normalized) || null;
}

// Small role indicator drawn just past a runway-end number - green dot for
// DEP, amber for ARR (same colors as the airport-card runway chips, not an
// independent choice), both side by side if named for both, or a red dot
// (centered on the label's own outward axis, baseX/baseY below) if there's
// real ATIS data for this airport but this end isn't named at all (this
// plugin's stand-in for "closed" - apt.dat has no closure flag). `usage`
// null means no usable ATIS yet - draws nothing, since "no data" must never
// read as "closed."
function drawRunwayUsageIndicator(centerX, centerY, outUx, outUy, usage, label) {
    if (!usage) return;
    const OUTSET = 15, DOT_R = 4, SPACING = 6.5;
    const perpX = -outUy, perpY = outUx;
    const baseX = centerX + outUx * OUTSET, baseY = centerY + outUy * OUTSET;

    const u = findRunwayUsage(usage, label);
    if (!u) {
        ctx.fillStyle = "#ff4757";
        ctx.beginPath(); ctx.arc(baseX, baseY, DOT_R, 0, Math.PI * 2); ctx.fill();
        return;
    }
    if (u.dep) {
        const x = u.arr ? baseX - perpX * SPACING : baseX, y = u.arr ? baseY - perpY * SPACING : baseY;
        ctx.fillStyle = "#00e676";
        ctx.beginPath(); ctx.arc(x, y, DOT_R, 0, Math.PI * 2); ctx.fill();
    }
    if (u.arr) {
        const x = u.dep ? baseX + perpX * SPACING : baseX, y = u.dep ? baseY + perpY * SPACING : baseY;
        ctx.fillStyle = "#ffb300";
        ctx.beginPath(); ctx.arc(x, y, DOT_R, 0, Math.PI * 2); ctx.fill();
    }
}

// Closest point on segment [a, b] to (px, py), in local map meters (as
// opposed to distancePointToSegment below, screen pixels for click hit-
// testing) - mirrors PanelMap.cpp's ProjectOntoSegmentWorld exactly, used
// to truncate the taxi-route highlight's active segment back to the
// aircraft's own position. See map.js's route-drawing loop in render().
function projectOntoSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + t * dx, y: ay + t * dy };
}

function distancePointToSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    return Math.hypot(p.x - px, p.y - py);
}

// The real icon (assets/aircraft-icon.png) is the exact same silhouette
// the native build embeds in src/ui/AircraftIconTexture.h - decoded
// straight out of that file's baked RGBA8 byte array (a one-time Python/
// Pillow conversion, not redrawn by hand) so the two UIs show the
// identical shape instead of a lookalike approximation. It's a white fill
// with alpha (same as the native texture), tinted at draw time - here via
// a pre-rendered black copy (source-in composite, done once on load) drawn
// as 8 small offset copies behind the white original, mirroring
// DrawAircraftIcon's own halo technique in PanelMap.cpp exactly.
const aircraftIconImg = new Image();
let aircraftIconBlack = null;
// Baked orange copy for the ground-traffic layer (see drawTrafficIcon
// below) - same source-in composite technique as the black halo copy, just
// a different fillStyle. Matches PanelMap.cpp's theme::kOrange tint on the
// native side (DrawAircraftIcon's tint param), which needs no separate
// baked asset since ImDrawList::AddImageQuad tints at draw time - Canvas 2D
// has no equivalent, hence baking this copy once on load instead of a new
// PNG asset. Orange (not amber) deliberately - see DrawAircraftIcon's own
// comment on why: amber already means several other things on this map
// (ARR dots/tags, OFF AIRPORT/NO ROUTE badges) and reads close to the
// taxiway-sign yellow, both of which made traffic markers hard to pick out
// at a glance in real usage.
let aircraftIconOrange = null;
aircraftIconImg.onload = () => {
    const c = document.createElement("canvas");
    c.width = aircraftIconImg.naturalWidth;
    c.height = aircraftIconImg.naturalHeight;
    const cctx = c.getContext("2d");
    cctx.drawImage(aircraftIconImg, 0, 0);
    cctx.globalCompositeOperation = "source-in";
    cctx.fillStyle = "#000000";
    cctx.fillRect(0, 0, c.width, c.height);
    aircraftIconBlack = c;

    const c2 = document.createElement("canvas");
    c2.width = aircraftIconImg.naturalWidth;
    c2.height = aircraftIconImg.naturalHeight;
    const cctx2 = c2.getContext("2d");
    cctx2.drawImage(aircraftIconImg, 0, 0);
    cctx2.globalCompositeOperation = "source-in";
    cctx2.fillStyle = "#FF6D00"; // theme::kOrange's hex - keep native/web in sync
    cctx2.fillRect(0, 0, c2.width, c2.height);
    aircraftIconOrange = c2;
};
aircraftIconImg.src = "assets/aircraft-icon.png";

const AIRCRAFT_ICON_HALO_OFFSETS = [
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [1.4, 1.4], [-1.4, 1.4], [1.4, -1.4], [-1.4, -1.4],
];

// User-provided arrow (assets/wind-arrow-icon.png) for the compass rose's
// wind indicator - the exact same source PanelMap.cpp's WindArrowIconTexture.h
// embeds, already baked cyan (the wind arrow's fixed color, not the user's
// accent - see drawCompassRose's own comment) with alpha, so unlike the
// aircraft icon above this one needs no separate tint/halo step, just drawn
// as-is.
const windArrowIconImg = new Image();
let windArrowIconLoaded = false;
windArrowIconImg.onload = () => { windArrowIconLoaded = true; };
windArrowIconImg.src = "assets/wind-arrow-icon.png";

// Shared silhouette/halo draw, parameterized by fill image and alpha -
// mirrors PanelMap.cpp's DrawAircraftIcon's own tint+alpha parameterization
// (Canvas 2D has no per-draw tint like ImDrawList::AddImageQuad, hence a
// separate pre-baked fill image per color instead of one texture + a tint
// argument, but the "one shared drawing routine, parameterized" shape is
// otherwise identical, so the two can't silently drift apart).
function drawAircraftSilhouette(x, y, headingDeg, fillImage, alpha, sizeScale) {
    if (!aircraftIconBlack || !fillImage) {
        return; // image(s) still loading (first frame or two) - skip rather than draw a placeholder shape
    }
    const rad = (headingDeg * Math.PI) / 180;
    const size = 32 * sizeScale; // 32 matches PanelMap.cpp's DrawAircraftIcon fixed 32x32 screen footprint
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);
    if (alpha < 1) {
        ctx.globalAlpha = alpha;
    }
    for (const [ox, oy] of AIRCRAFT_ICON_HALO_OFFSETS) {
        ctx.drawImage(aircraftIconBlack, -size / 2 + ox * sizeScale, -size / 2 + oy * sizeScale, size, size);
    }
    ctx.drawImage(fillImage, -size / 2, -size / 2, size, size);
    ctx.restore();
}

function drawAircraftIcon(x, y, headingDeg) {
    drawAircraftSilhouette(x, y, headingDeg, aircraftIconImg, 1, 1);
}

// Other aircraft (X-Plane AI traffic, or online-network aircraft) - the
// pre-baked orange copy for the fill instead of the plain white original,
// slightly transparent and slightly smaller (matches PanelMap.cpp's
// kTrafficIconAlpha/kTrafficIconSizeScale), so it stays visually distinct
// from the user's own solid-white, full-size aircraft. No per-marker
// smoothing (mirrors PanelMap.cpp's DrawMapPanel traffic loop) - this data
// only refreshes at ~1Hz server-side and is a secondary situational-
// awareness layer, not the safety-critical own-ship position.
const TRAFFIC_ICON_ALPHA = 0.78; // ~200/255, matches native's kTrafficIconAlpha
const TRAFFIC_ICON_SIZE_SCALE = 0.8; // matches native's kTrafficIconSizeScale

function drawTrafficIcon(x, y, headingDeg) {
    drawAircraftSilhouette(x, y, headingDeg, aircraftIconOrange, TRAFFIC_ICON_ALPHA, TRAFFIC_ICON_SIZE_SCALE);
}

function pulseAlpha() {
    return 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(performance.now() / 1000 * 3));
}

// Idle-render gate. The rAF loop (see initMapPanel) skips render() entirely
// when nothing on screen is animating and no state has changed since the
// last frame - a static view (the map left open on a second monitor during
// cruise, say) then costs ~0 instead of a full canvas repaint 60x/second.
//   - requestRender() forces exactly one frame (called by every state
//     setter / input handler / layout or theme change).
//   - isAnimating() keeps the loop at full frame rate while anything is
//     actually moving (aircraft on the field, camera tracking, an active
//     gesture, the pulsing/spinning gate ring).
//   - a 500 ms heartbeat renders anyway, so a missed requestRender() can
//     never freeze the view for longer than that.
let renderRequested = true;
const IDLE_HEARTBEAT_MS = 500;
function requestRender() { renderRequested = true; }
function isAnimating() {
    if (!mapData) return false;
    const onAirport = !!(liveAircraft ? liveAircraft.onAirport : mapData.aircraftOnAirport);
    return onAirport                          // GPS-LIVE badge pulse + aircraft position/heading easing
        || trackMode !== "off"                // camera tracking ease
        || pointers.size > 0 || !!dragStart   // active pan / zoom / rotate gesture
        || !!(mapData.assignedGate && mapData.assignedGate.valid); // breathing / spinning gate ring
}

function render() {
    const { w, h, sx, sy } = resizeCanvasToDisplaySize();
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, w, h);

    updateHeader();

    const now = performance.now();
    // Capped so a dropped/backgrounded-tab frame (large dt) doesn't produce
    // a single huge smoothing jump - clamps the effective alpha to a
    // sensible worst case instead.
    const dtSec = lastRenderTimeMs != null ? Math.min(0.25, (now - lastRenderTimeMs) / 1000) : 0;
    lastRenderTimeMs = now;
    const smoothAlpha = dtSec > 0 ? 1 - Math.exp(-dtSec / TRACK_SMOOTHING_TAU_SEC) : 1;

    if (!mapData) {
        if (placeholder.style.display !== "flex") placeholder.style.display = "flex";
        return;
    }
    if (placeholder.style.display !== "none") placeholder.style.display = "none";

    if (icao !== lastIcaoForView) {
        lastIcaoForView = icao;
        zoom = 1;
        panOffset = { x: 0, y: 0 };
        rotationDeg = 0;
        trackMode = "off";
        aircraftSmoothingValid = false;
        updateTrackButtons();
    }

    const aircraftOnAirport = !!(liveAircraft ? liveAircraft.onAirport : mapData.aircraftOnAirport);
    const bounds = computeBounds(mapData, aircraftOnAirport);
    const proj = makeProjection(bounds, w, h);
    const centerX = w / 2, centerY = h / 2;
    const headingDegForRotation = liveAircraft ? liveAircraft.headingDeg : (mapData.aircraft ? mapData.aircraft.headingDeg : 0);

    // Track mode: re-centers on the aircraft every frame, optionally
    // chasing a target rotation (0 for north-up, -heading for heading-up -
    // see angleLerpDeg's derivation note below). Rotation always pivots
    // around the canvas center, which composes correctly with the
    // auto-centering translation regardless of pivot choice (a rotation
    // about any point followed by a translation that restores a chosen
    // world point to a fixed screen location is equivalent to a rotation
    // about that fixed location directly) - so this same pivot also works
    // unmodified for manual right-drag rotation while trackMode is "off".
    if (trackMode !== "off" && aircraftOnAirport) {
        const aircraftWorldPos = projectedAircraft || (mapData.aircraft ? { x: mapData.aircraft.x, y: mapData.aircraft.y } : null);
        if (aircraftWorldPos) {
            const targetRotationDeg = trackMode === "heading" ? -headingDegForRotation : 0;
            rotationDeg = angleLerpDeg(rotationDeg, targetRotationDeg, smoothAlpha);

            const rawBase = proj.toScreen(aircraftWorldPos.x, aircraftWorldPos.y);
            const rad = (rotationDeg * Math.PI) / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const dx = rawBase.x - centerX, dy = rawBase.y - centerY;
            const rotatedX = centerX + dx * cos - dy * sin;
            const rotatedY = centerY + dx * sin + dy * cos;
            const targetPanOffset = { x: -(rotatedX - centerX) * zoom, y: -(rotatedY - centerY) * zoom };
            panOffset.x += (targetPanOffset.x - panOffset.x) * smoothAlpha;
            panOffset.y += (targetPanOffset.y - panOffset.y) * smoothAlpha;
        }
    }
    // trackMode === "off": panOffset/rotationDeg are left as whatever they
    // currently are - directly mutated by left-drag (pan) / right-drag
    // (rotate), see the pointer handlers below.

    const rotRad = (rotationDeg * Math.PI) / 180;
    const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
    const toScreen = (x, y) => {
        const base = proj.toScreen(x, y);
        const dx = base.x - centerX, dy = base.y - centerY;
        const rx = centerX + dx * cosR - dy * sinR;
        const ry = centerY + dx * sinR + dy * cosR;
        return {
            x: centerX + (rx - centerX) * zoom + panOffset.x,
            y: centerY + (ry - centerY) * zoom + panOffset.y,
        };
    };
    // Pan/rotation-invariant projection used only to decide which parking
    // spots cluster together (see the parking-drawing block below) - scales
    // with zoom like toScreen does, but deliberately skips panOffset/
    // rotation so clustering doesn't flicker while the view pans or spins
    // during tracking (real-usage report - "les taxiways [stands] se
    // regroupent/dégroupent quand la carte bouge").
    const clusterProject = (x, y) => {
        const base = proj.toScreen(x, y);
        return { x: base.x * zoom, y: base.y * zoom };
    };
    const effectiveScale = proj.scale * zoom;
    lastToScreen = toScreen;
    lastClusterProject = clusterProject;
    lastEffectiveScale = effectiveScale;

    // Runway usage from the currently displayed airport's ATIS, if any real
    // data has been fetched - see setAtisForActiveAirport(). Drives the
    // DEP/ARR/closed dots drawn alongside each end's number, below.
    const runwayUsage = runwayUsageForActiveAirport;

    // Runway pavement only here - end-number labels (and their DEP/ARR/
    // closed dots) are deferred until after the taxiway lines/signs below
    // (see runwayLabels), so a taxiway connecting right at a threshold
    // never paints over a runway number.
    const runwayLabels = [];
    for (const r of mapData.runways) {
        const a = toScreen(r.x1, r.y1);
        const b = toScreen(r.x2, r.y2);
        ctx.strokeStyle = "rgb(200,205,215)";
        ctx.lineWidth = Math.max(2, r.widthMeters * effectiveScale);
        ctx.lineCap = "butt";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        const slash = r.label.indexOf("/");
        const end1Label = slash >= 0 ? r.label.slice(0, slash) : r.label;
        const end2Label = slash >= 0 ? r.label.slice(slash + 1) : "";
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const outset = 22;
        const end1X = a.x - ux * outset, end1Y = a.y - uy * outset;
        const end2X = b.x + ux * outset, end2Y = b.y + uy * outset;

        // Real runway markings: reading direction is *perpendicular* to the
        // runway axis (the two digits sit side by side across the
        // pavement), while the top of the text points *along* the axis,
        // into the runway, in that end's own landing direction - a pilot
        // on final for that end sees it upright. The two ends need
        // genuinely different (180deg-apart) angles, not one shared one -
        // end1's top points a->b, end2's points b->a. Matches
        // PanelMap.cpp's DrawMapPanel exactly (see its own comment for the
        // full derivation) - falls out of the geometry directly, no
        // separate "keep it upright" correction needed or wanted.
        const lineAngle = Math.atan2(dy, dx);
        const end1Angle = lineAngle + Math.PI / 2;
        const end2Angle = lineAngle - Math.PI / 2;

        runwayLabels.push({ x: end1X, y: end1Y, angle: end1Angle, outUx: -ux, outUy: -uy, label: end1Label });
        if (end2Label) {
            runwayLabels.push({ x: end2X, y: end2Y, angle: end2Angle, outUx: ux, outUy: uy, label: end2Label });
        }
    }

    // Taxiway lines
    ctx.strokeStyle = "rgb(120,130,150)";
    ctx.lineWidth = Math.max(1.5, 4 * effectiveScale);
    for (const t of mapData.taxiways) {
        const a = toScreen(t.x1, t.y1);
        const b = toScreen(t.x2, t.y2);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }

    // SayIntentions taxi route overlay (flight.json taxi_path, projected by
    // the plugin) - a reference layer, NOT the planner. Mirrors PanelMap.cpp:
    // same solid accent line as the manual route, drawn under it; progressive
    // erase from progressIdx with the active segment truncated to the
    // aircraft.
    const sr = mapData.siTaxiRoute;
    if (sr && sr.valid && Array.isArray(sr.points) && sr.points.length >= 2) {
        const start = Math.min(Math.max(sr.progressIdx | 0, 0), sr.points.length - 1);
        const acPos = aircraftOnAirport
            ? (projectedAircraft || (mapData.aircraft ? { x: mapData.aircraft.x, y: mapData.aircraft.y } : null))
            : null;
        let fx = sr.points[start].x, fy = sr.points[start].y;
        if (acPos && start + 1 < sr.points.length) {
            const p = projectOntoSegment(acPos.x, acPos.y, sr.points[start].x, sr.points[start].y,
                                          sr.points[start + 1].x, sr.points[start + 1].y);
            if (Math.hypot(acPos.x - p.x, acPos.y - p.y) < NODE_CAPTURE_RADIUS_M) { fx = p.x; fy = p.y; }
        }
        const pts = [toScreen(fx, fy)];
        for (let i = start + 1; i < sr.points.length; ++i) pts.push(toScreen(sr.points[i].x, sr.points[i].y));
        if (pts.length >= 2) {
            ctx.strokeStyle = routeHighlightColor();
            ctx.lineWidth = Math.max(3, 6 * effectiveScale);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; ++i) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
        }
    }

    // Selected taxi route highlight - drawn on top of plain taxiway lines,
    // using the oriented edge list from GET .../taxi-route (server already
    // resolved chain/gap-fill logic, see api.js). GPS-linked progressive
    // erase: the server is the sole source of truth for which node the
    // aircraft must reach next (nextRequiredNodeIndex, the "invisible
    // checkpoints" model - see PanelMap.cpp's UpdateRouteProgress for why).
    // This side only skips already-walked edges and truncates the one
    // active segment locally using whatever aircraft position it already
    // has (prefers the live SSE-projected one, more current than the
    // polled snapshot) - no independent progress computation here.
    // Hoisted above the route-highlight block below so the far-end
    // truncation it drives (farCutIndex) can be computed before that loop
    // runs - mirrors PanelMap.cpp.
    const gd = mapData.guidance;

    // Far-end route-highlight truncation anchor (HOLD SHORT / ARRIVE) -
    // declared here, at this function's own top scope, rather than local to
    // the route-drawing block below, so the aircraft-nose leash further down
    // can also see where the highlight was actually cut and re-target to
    // that point instead of dangling past the visible end of the line.
    // Mirrors PanelMap.cpp.
    let farCutIndex = -1, farCutX = 0, farCutY = 0;

    if (mapData.hasTaxiRouteNetwork && routeSelection.edges && routeSelection.edges.length > 0) {
        ctx.strokeStyle = routeHighlightColor();
        ctx.lineWidth = Math.max(3, 6 * effectiveScale);
        ctx.lineCap = "round";
        const nextRequiredNodeIndex = routeSelection.nextRequiredNodeIndex ?? 1;
        const routeAircraftPos = aircraftOnAirport
            ? (projectedAircraft || (mapData.aircraft ? { x: mapData.aircraft.x, y: mapData.aircraft.y } : null))
            : null;

        // Far-end truncation: when the route ends in a HOLD SHORT or an
        // ARRIVE, the guidance payload carries the real anchor point
        // (holdPoint / arrivePoint) - a point that lies exactly on one of
        // this route's own edges. Find which edge that is; anything drawn
        // past it isn't part of the route anymore per the guidance
        // computation - fixes the manual-gate overshoot case (and, as a
        // byproduct, the pre-existing HOLD SHORT overrun past the stop bar).
        if (gd && gd.valid && gd.source === 1) {
            let anchor = null;
            if (gd.endsVerb === "holdShort" && gd.holdPoint) anchor = gd.holdPoint;
            else if (gd.endsVerb === "arrive" && gd.arrivePoint) anchor = gd.arrivePoint;
            if (anchor) {
                let bestD = Infinity;
                for (let i = 0; i < routeSelection.edges.length; ++i) {
                    const e = routeSelection.edges[i];
                    const fromNodeId = routeSelection.nodeSequence[i];
                    let sx, sy, ex, ey;
                    if (e.node1Id === fromNodeId) { sx = e.x1; sy = e.y1; ex = e.x2; ey = e.y2; }
                    else { sx = e.x2; sy = e.y2; ex = e.x1; ey = e.y1; }
                    const proj = projectOntoSegment(anchor.x, anchor.y, sx, sy, ex, ey);
                    const d = Math.hypot(anchor.x - proj.x, anchor.y - proj.y);
                    if (d < bestD) { bestD = d; farCutIndex = i; farCutX = anchor.x; farCutY = anchor.y; }
                }
            }
        }

        for (let i = 0; i < routeSelection.edges.length; ++i) {
            if (i + 1 < nextRequiredNodeIndex) {
                continue; // walked - erased
            }
            if (farCutIndex >= 0 && i > farCutIndex) {
                continue; // past the HOLD SHORT / ARRIVE anchor - not drawn
            }
            const e = routeSelection.edges[i];
            const fromNodeId = routeSelection.nodeSequence[i];
            let sx, sy, ex, ey;
            if (e.node1Id === fromNodeId) { sx = e.x1; sy = e.y1; ex = e.x2; ey = e.y2; }
            else { sx = e.x2; sy = e.y2; ex = e.x1; ey = e.y1; }
            if (i + 1 === nextRequiredNodeIndex && routeAircraftPos) {
                // Only truncate if the aircraft is actually near THIS edge -
                // see NODE_CAPTURE_RADIUS_M's comment above.
                const proj = projectOntoSegment(routeAircraftPos.x, routeAircraftPos.y, sx, sy, ex, ey);
                if (Math.hypot(routeAircraftPos.x - proj.x, routeAircraftPos.y - proj.y) < NODE_CAPTURE_RADIUS_M) {
                    sx = proj.x; sy = proj.y;
                }
            }
            if (farCutIndex >= 0 && i === farCutIndex) {
                ex = farCutX; ey = farCutY; // clamp the far end at the anchor
            }
            const a = toScreen(sx, sy);
            const b = toScreen(ex, ey);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
        ctx.lineCap = "butt";
    }

    // Runway hold-short bar - a red double line across the route at the real
    // hold line (apt.dat row 1204's protected-zone boundary, else a geometric
    // standoff). Mirrors PanelMap.cpp; covers planned + SI routes.
    if (gd && gd.valid && gd.endsVerb === "holdShort" && gd.holdPoint) {
        let dx = gd.holdPoint.dx || 0, dy = gd.holdPoint.dy || 0;
        if (dx === 0 && dy === 0) dy = 1;
        const px = -dy, py = dx, halfW = 9, back = 2.6;
        const W = (ox, oy) => toScreen(gd.holdPoint.x + ox, gd.holdPoint.y + oy);
        const th = Math.max(2.5, 4 * effectiveScale);
        ctx.strokeStyle = "#ff4757";
        ctx.lineWidth = th;
        ctx.lineCap = "round";
        for (const b of [0, -back]) {
            const a1 = W(px * halfW + dx * b, py * halfW + dy * b);
            const a2 = W(-px * halfW + dx * b, -py * halfW + dy * b);
            ctx.beginPath();
            ctx.moveTo(a1.x, a1.y);
            ctx.lineTo(a2.x, a2.y);
            ctx.stroke();
        }
        ctx.lineCap = "butt";
    }

    // Taxiway signs - zoom-dependent, mirrors PanelMap.cpp: zoomed out shows
    // exactly one label per taxiway NAME so a long multi-chain taxiway
    // doesn't repeat its sign down its whole length; zoomed in past
    // TAXIWAY_SEGMENT_LABEL_ZOOM_THRESHOLD switches to one label per real
    // junction-to-junction chain instead, matching how much detail is
    // actually visible at that scale.
    ctx.font = "12px 'Cousine', monospace";
    const drawTaxiwaySign = (wx, wy, label) => {
        const p = toScreen(wx, wy);
        let textW = signWidthCache.get(label);
        if (textW === undefined) {
            textW = ctx.measureText(label).width;
            signWidthCache.set(label, textW);
        }
        const padX = 4, padY = 2;
        const textH = 12;
        ctx.fillStyle = "#000000";
        ctx.fillRect(p.x - textW / 2 - padX, p.y - textH / 2 - padY, textW + padX * 2, textH + padY * 2);
        ctx.fillStyle = "#ffdd00";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, p.x, p.y + 1);
    };
    const taxiwayLabelSource = zoom >= TAXIWAY_SEGMENT_LABEL_ZOOM_THRESHOLD
        ? mapData.taxiwayChainLabels
        : mapData.taxiwayNameLabels;
    for (const l of taxiwayLabelSource || []) {
        drawTaxiwaySign(l.x, l.y, l.label);
    }

    // Runway-end numbers (and their DEP/ARR/closed dots), drawn now rather
    // than back when the pavement itself was drawn - see runwayLabels'
    // own comment above. Deferred until after every taxiway line/sign so
    // the numbers always stay on top.
    for (const rl of runwayLabels) {
        drawRotatedText(rl.label, rl.x, rl.y, rl.angle, "#ffffff", "13px 'Cousine', monospace");
        drawRunwayUsageIndicator(rl.x, rl.y, rl.outUx, rl.outUy, runwayUsage, rl.label);
    }

    // Parking - clustered into a fixed screen-space grid, same as
    // DrawMapPanel's ParkingCluster block.
    {
        const clusters = new Map();
        for (let i = 0; i < mapData.parking.length; ++i) {
            const clusterPos = clusterProject(mapData.parking[i].x, mapData.parking[i].y);
            const cellX = Math.floor(clusterPos.x / PARKING_CLUSTER_GRID_PX);
            const cellY = Math.floor(clusterPos.y / PARKING_CLUSTER_GRID_PX);
            const key = cellX + "," + cellY;
            const c = toScreen(mapData.parking[i].x, mapData.parking[i].y);
            let cl = clusters.get(key);
            if (!cl) { cl = { sumX: 0, sumY: 0, count: 0, firstIndex: i }; clusters.set(key, cl); }
            cl.sumX += c.x; cl.sumY += c.y; cl.count += 1;
        }
        // While a SayIntentions gate is highlighted, fade EVERYTHING else
        // parking-related - dots + labels AND the zoomed-out cluster markers
        // (mirrors PanelMap.cpp).
        const agData = mapData.assignedGate;
        const fade = !!(agData && agData.valid);
        const dotAlpha = fade ? 0.34 : 1;
        const labelAlpha = fade ? 0.28 : 1;

        for (const cl of clusters.values()) {
            const cx = cl.sumX / cl.count, cy = cl.sumY / cl.count;
            if (cl.count === 1) {
                if (fade && cl.firstIndex === agData.matchedParkingIndex) {
                    continue; // the assigned stand - drawn in the highlight block
                }
                const p = mapData.parking[cl.firstIndex];
                ctx.globalAlpha = dotAlpha;
                ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
                ctx.fillStyle = cssCache.border2;
                ctx.fill();
                ctx.lineWidth = 1.5; ctx.strokeStyle = "#d500f9"; ctx.stroke();
                // --text (not --text-dim) - real-usage report: the dim tone
                // read as too dark/hard to make out against the busy map.
                ctx.fillStyle = cssCache.text;
                ctx.font = "11px 'Roboto Medium', sans-serif";
                ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
                ctx.globalAlpha = labelAlpha;
                ctx.fillText(p.label, cx + 7, cy - 7);
                ctx.globalAlpha = 1;
            } else {
                const r = 10;
                ctx.globalAlpha = dotAlpha;
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = cssCache.border2;
                ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = "#d500f9"; ctx.stroke();
                ctx.fillStyle = "#eef2ff";
                ctx.font = "bold 12px 'Roboto Medium', sans-serif";
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(String(cl.count), cx, cy);
                ctx.globalAlpha = 1;
            }
        }
    }

    // SayIntentions-assigned gate highlight - drawn over the parking clusters
    // so it stays visible even when its stand is inside a collapsed cluster,
    // same reasoning as the runway-usage dots. Mirrors PanelMap.cpp.
    const ag = mapData.assignedGate;
    if (ag && ag.valid) {
        const g = toScreen(ag.x, ag.y);
        const col = routeHighlightColor();
        const matched = ag.matchedParkingIndex >= 0;

        // Breathing ring - same sine pulse shape as PanelMap.cpp / the GPS
        // LIVE badge.
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 3.0);
        const ringR = 9 + 3.5 * pulse;
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.43 + 0.5 * pulse;
        if (matched) {
            ctx.beginPath(); ctx.arc(g.x, g.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = cssCache.border2; ctx.globalAlpha = 1; ctx.fill();
            ctx.strokeStyle = col; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(g.x, g.y, 5, 0, Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = 0.43 + 0.5 * pulse;
            ctx.lineWidth = 2.5;
            ctx.beginPath(); ctx.arc(g.x, g.y, ringR, 0, Math.PI * 2); ctx.stroke();
        } else {
            const spin = performance.now() / 1000 * 0.8;
            ctx.lineWidth = 2.5;
            ctx.setLineDash([ringR * 0.42, ringR * 0.42]);
            ctx.lineDashOffset = -spin * ringR;
            ctx.beginPath(); ctx.arc(g.x, g.y, ringR, 0, Math.PI * 2); ctx.stroke();
            ctx.setLineDash([]); ctx.lineDashOffset = 0;
        }
        ctx.globalAlpha = 1;

        // Compact pill - just the gate id (the pulsing ring says what it is).
        let tag = ag.displayLabel || ag.label || "?";
        if (!matched) tag += " ?";
        ctx.font = "11px 'Roboto Medium', sans-serif";
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(tag).width;
        const bx = g.x + 12, by = g.y - 9;
        ctx.fillStyle = "rgba(8,10,16,0.9)";
        ctx.fillRect(bx, by, tw + 8, 18);
        ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.strokeRect(bx, by, tw + 8, 18);
        ctx.fillStyle = col;
        ctx.fillText(tag, bx + 4, g.y + 1);
    }

    // Route-to-gate connector: for a MANUAL gate selection only (SI's own
    // flight.json taxi_path already runs to the real gate, so this doesn't
    // apply there - product decision). A straight line from the truncated/
    // real route end (arrivePoint) to the gate marker itself, closing the
    // visual gap the same "leash" reasoning the aircraft-nose connector below
    // uses. Mirrors PanelMap.cpp.
    if (ag && ag.valid && ag.manual && gd && gd.source === 1 && gd.arrivePointIsGate && gd.arrivePoint) {
        const a = toScreen(gd.arrivePoint.x, gd.arrivePoint.y);
        const b = toScreen(ag.x, ag.y);
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy > 16) { // skip a redundant near-zero-length stub when already touching
            ctx.strokeStyle = routeHighlightColor();
            ctx.lineWidth = Math.max(2, 4 * effectiveScale);
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.lineCap = "butt";
        }
    }

    // Aircraft - prefer live SSE-projected position, fall back to the map
    // snapshot's own aircraft field until the first SSE event arrives.
    if (aircraftOnAirport) {
        const pos = projectedAircraft || { x: mapData.aircraft.x, y: mapData.aircraft.y };
        // Ease toward the latest raw sample rather than snapping straight to
        // it - see smoothedAircraftPos's own comment. A fresh reappearance
        // (just came back into range) snaps instead of sliding in from a
        // stale position unrelated to where the aircraft actually is now.
        if (!aircraftSmoothingValid) {
            smoothedAircraftPos = { x: pos.x, y: pos.y };
            smoothedAircraftHeadingDeg = headingDegForRotation;
            aircraftSmoothingValid = true;
        } else {
            smoothedAircraftPos = {
                x: smoothedAircraftPos.x + (pos.x - smoothedAircraftPos.x) * smoothAlpha,
                y: smoothedAircraftPos.y + (pos.y - smoothedAircraftPos.y) * smoothAlpha,
            };
            smoothedAircraftHeadingDeg = angleLerpDeg(smoothedAircraftHeadingDeg, headingDegForRotation, smoothAlpha);
        }

        // The map itself is rotated by rotationDeg (0 in north-up/off
        // modes, chasing -heading in heading-up track mode, or whatever the
        // user dialed in via right-drag) - adding that same rotation to the
        // icon's own heading keeps it pointing the right way on screen in
        // every mode, including mid-transition while rotationDeg is still
        // catching up to its target.
        const heading = smoothedAircraftHeadingDeg + rotationDeg;
        const screenPos = toScreen(smoothedAircraftPos.x, smoothedAircraftPos.y);

        // "Leash": a short connector from the aircraft icon's own nose tip to
        // the nearest point on the currently-highlighted route, closing the
        // visual gap that opens up whenever the aircraft is further than
        // NODE_CAPTURE_RADIUS_M from the route (the route-highlight blocks
        // above only truncate the active edge back to the aircraft WITHIN
        // that radius). Mirrors PanelMap.cpp's DrawMapPanel - see its own
        // comment for the reasoning. Connects to whichever route is actually
        // driving guidance right now (mapData.guidance.source: 1 = the
        // interactive planned route, 2 = the SayIntentions overlay).
        let nearestWorld = null;
        const guidanceSource = mapData.guidance && mapData.guidance.source;
        if (guidanceSource === 1 && routeSelection.edges && routeSelection.edges.length > 0) {
            const nextRequiredNodeIndex = routeSelection.nextRequiredNodeIndex ?? 1;
            if (nextRequiredNodeIndex >= 1 && nextRequiredNodeIndex <= routeSelection.edges.length) {
                // Back to the original, single-"active"-edge projection - a
                // real-usage report confirmed the wider all-remaining-edges
                // search (tried in an earlier follow-up) actually regressed
                // things: at a busy junction with several close taxiways it
                // could snap onto the wrong nearby edge instead of the
                // active one. The real remaining gap was the route
                // highlight's far end being cut (see farCutIndex above)
                // while the leash still targeted a point past that cut -
                // handled below instead of by widening the search again.
                // Mirrors PanelMap.cpp.
                const activeAi = nextRequiredNodeIndex - 1;
                if (farCutIndex >= 0 && activeAi > farCutIndex) {
                    nearestWorld = { x: farCutX, y: farCutY };
                } else {
                    const activeEdge = routeSelection.edges[activeAi];
                    const activeFromNodeId = routeSelection.nodeSequence[activeAi];
                    let aasx, aasy, aaex, aaey;
                    if (activeEdge.node1Id === activeFromNodeId) { aasx = activeEdge.x1; aasy = activeEdge.y1; aaex = activeEdge.x2; aaey = activeEdge.y2; }
                    else { aasx = activeEdge.x2; aasy = activeEdge.y2; aaex = activeEdge.x1; aaey = activeEdge.y1; }
                    if (farCutIndex >= 0 && activeAi === farCutIndex) {
                        aaex = farCutX; aaey = farCutY; // same clamp the draw loop applies
                    }
                    nearestWorld = projectOntoSegment(mapData.aircraft.x, mapData.aircraft.y, aasx, aasy, aaex, aaey);
                }
            }
        } else if (guidanceSource === 2 && sr && sr.valid && Array.isArray(sr.points) && sr.points.length >= 2) {
            const start = Math.min(Math.max(sr.progressIdx | 0, 0), sr.points.length - 2);
            nearestWorld = projectOntoSegment(mapData.aircraft.x, mapData.aircraft.y,
                                               sr.points[start].x, sr.points[start].y,
                                               sr.points[start + 1].x, sr.points[start + 1].y);
        }
        if (nearestWorld) {
            // Nose tip: the same rotation drawAircraftSilhouette applies via
            // ctx.rotate(rad) to its own icon draw, applied to the icon's
            // local nose point (0,-16) - the image points "up" (toward -y)
            // at heading 0, and 16 is drawAircraftSilhouette's own fixed
            // screen-space half-extent (size 32) for the own-ship icon.
            const rad = (heading * Math.PI) / 180;
            const nose = { x: screenPos.x + 16 * Math.sin(rad), y: screenPos.y - 16 * Math.cos(rad) };
            const nearestScreen = toScreen(nearestWorld.x, nearestWorld.y);
            const dx = nearestScreen.x - nose.x, dy = nearestScreen.y - nose.y;
            if (dx * dx + dy * dy > 16) { // skip a redundant near-zero-length stub when already touching
                ctx.strokeStyle = routeHighlightColor();
                ctx.lineWidth = Math.max(2, 4 * effectiveScale);
                ctx.lineCap = "round";
                ctx.beginPath();
                ctx.moveTo(nose.x, nose.y);
                ctx.lineTo(nearestScreen.x, nearestScreen.y);
                ctx.stroke();
            }
        }

        drawAircraftIcon(screenPos.x, screenPos.y, heading);
    } else {
        aircraftSmoothingValid = false; // re-snap next time it comes back into range
    }

    // Other aircraft - x/y arrive already projected into the same local
    // meters space as mapData (see WebServer.cpp's TrafficToJson), so no
    // client-side GeoProjection re-derivation is needed, just the same
    // toScreen() every other map layer already uses. Falls back to
    // mapData.traffic (the initial GET .../map snapshot) until the first
    // SSE tick arrives, same pattern as aircraftOnAirport/headingDegForRotation
    // above.
    const trafficList = liveAircraft ? liveAircraft.traffic : mapData.traffic;
    if (trafficList) {
        for (const t of trafficList) {
            const screenPos = toScreen(t.x, t.y);
            drawTrafficIcon(screenPos.x, screenPos.y, t.headingDeg + rotationDeg);
        }
    }

    drawScaleBar(w, h, effectiveScale);
    drawPositionOverlay();
    drawCompassRose(w);

    // Turn-by-turn taxi guidance - ribbon (wedged between the position
    // overlay and compass rose, neither moves) or the frameless floating
    // HUD. Mirrors PanelMap.cpp; reads mapData.guidance + mapData.guidancePrefs.
    drawGuidance(w, h);
    const ribbonShown = mapData.guidance && mapData.guidance.valid && guidancePrefs().ribbon;

    // Transient result of the last assignGate attempt - the plugin clears it
    // server-side after a few seconds, so this toast disappears on its own
    // next poll. Centered near the top, mirrors PanelMap.cpp; nudged below
    // the guidance ribbon when that's present.
    const msg = mapData.siGate && mapData.siGate.actionMessage;
    if (msg) {
        ctx.font = "12px 'Roboto Medium', sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        const tw = ctx.measureText(msg).width;
        const toastY = ribbonShown ? 50 : 10;
        ctx.fillStyle = "rgba(0,0,0,0.8)";
        ctx.fillRect((w - tw) / 2 - 8, toastY, tw + 16, 22);
        ctx.fillStyle = mapData.siGate.actionError ? "#ff5252" : "#69f0ae";
        ctx.fillText(msg, w / 2, toastY + 5);
    }
}

// Compass rose: an N/S/E/W ring plus a wind arrow, top-right corner (mirrors
// drawPositionOverlay's top-left placement) - real-usage request, ported
// from PanelMap.cpp's DrawCompassRose (native parity, same layout/rotation
// math). Fixed screen-space size, independent of zoom/pan, but its ring
// ticks and the wind arrow both rotate together with `rotationDeg` (the
// same value the aircraft icon's own heading adds, above) so "N" always
// points at true north exactly the way the taxiway/runway geometry itself
// does. The arrow points toward where the wind is blowing FROM (weather-
// vane/METAR convention, e.g. "270 at 15" points at the west tick) - the
// same reading a pilot already gets from a windsock or an ATIS report.
// ac.windDirDeg/windSpeedKt/windDataAvailable are simulator weather at the
// *displayed airport's* location (see AirportWeather.h natively), not the
// aircraft's own position - stays correct while looking at an airport the
// aircraft isn't physically at.
function drawCompassRose(w) {
    const ac = liveAircraft || (mapData ? mapData.aircraft : null);
    if (!ac) return;

    // Bumped from 36/11px off #5a6478 (real-usage report: cardinal points
    // and the wind speed were both hard to make out at a glance) - matches
    // drawPositionOverlay's own readout size/weight now (ported from
    // PanelMap.cpp's DrawCompassRose, native parity), since this is primary
    // navigational info too, not secondary/dim text.
    const RADIUS = 40;
    // Clearance from the canvas edge to the ring's own center - must cover
    // not just RADIUS but the tick labels sitting just outside it too
    // (offset 10px past the ring + the label's own half-size, worst case
    // ~10px at a diagonal rotation), or a label pointing toward this
    // corner's own top/right edges gets clipped there as the rose rotates
    // with the map (real-usage report: bumping the label font size to 14px
    // without widening this margin left visible overflow past the canvas
    // edge). 20px covers that with a couple of px to spare. Mirrors
    // PanelMap.cpp's kMargin.
    const MARGIN = 20;
    const cx = w - MARGIN - RADIUS, cy = MARGIN + RADIUS;

    ctx.fillStyle = "rgba(13,15,20,0.75)";
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Any true bearing (0=N, 90=E, ...) rotates onto the screen exactly the
    // way the aircraft icon's heading does above - reused here for both the
    // N/S/E/W ticks and the wind arrow so everything on this rose stays
    // consistent with how the rest of the map is rotated.
    const bearingToScreenDir = (bearingDeg) => {
        const rad = ((bearingDeg + rotationDeg) * Math.PI) / 180;
        return { x: Math.sin(rad), y: -Math.cos(rad) };
    };

    ctx.font = "bold 14px 'Roboto Medium', sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const tick of [{ b: 0, l: "N" }, { b: 90, l: "E" }, { b: 180, l: "S" }, { b: 270, l: "W" }]) {
        const dir = bearingToScreenDir(tick.b);
        // N is drawn in the accent color (same convention as a real compass
        // rose emphasizing north) so it's identifiable at a glance without
        // reading the letter; E/S/W are bright rather than dim for the same
        // "must be readable at a glance" reason.
        const color = tick.l === "N" ? accentColor() : "#eef2ff";
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx + dir.x * (RADIUS - 9), cy + dir.y * (RADIUS - 9));
        ctx.lineTo(cx + dir.x * RADIUS, cy + dir.y * RADIUS);
        ctx.stroke();

        const lx = cx + dir.x * (RADIUS + 10), ly = cy + dir.y * (RADIUS + 10);
        // Dark outline behind each letter so it stays legible over whatever
        // taxiway/pavement/route color happens to be directly behind it,
        // not just the ring's own background - the labels sit just outside
        // the ring, over the live map.
        ctx.strokeStyle = "#0d0f14";
        ctx.lineWidth = 3;
        ctx.strokeText(tick.l, lx, ly);
        ctx.fillStyle = color;
        ctx.fillText(tick.l, lx, ly);
    }

    // No wind data at all (SSE hasn't connected yet / no dataref resolved
    // natively) - bare ring rather than a misleading calm arrow.
    if (!ac.windDataAvailable) return;

    if (!windArrowIconLoaded) return; // image still loading (first frame or two) - skip rather than draw a placeholder

    const dir = bearingToScreenDir(ac.windDirDeg);

    // The source art rests pointing right/east (bearing 90) rather than up/
    // north like the aircraft icon does - atan2(dir.y, dir.x) is exactly the
    // angle that rotates a right-pointing source onto the `dir` unit vector
    // directly (see PanelMap.cpp's DrawCompassRose for the full derivation).
    const rad = Math.atan2(dir.y, dir.x);
    // Offset a bit outward from the ring's own center (rather than centering
    // the icon exactly on it) so the arrow visually sweeps from near the
    // middle out toward the rim, same overall placement the old hand-drawn
    // shaft+head had. Mirrors PanelMap.cpp's kIconHalfExtent/kIconCenterOffset.
    const ICON_SIZE = 44, ICON_CENTER_OFFSET = 14;
    const iconCx = cx + dir.x * ICON_CENTER_OFFSET, iconCy = cy + dir.y * ICON_CENTER_OFFSET;
    ctx.save();
    ctx.translate(iconCx, iconCy);
    ctx.rotate(rad);
    ctx.drawImage(windArrowIconImg, -ICON_SIZE / 2, -ICON_SIZE / 2, ICON_SIZE, ICON_SIZE);
    ctx.restore();

    // Speed, printed near the arrow's own (wide) back end - not rotated with
    // it (a number only readable at certain wind headings would defeat the
    // point of a live readout), dark-on-cyan for strong, stable contrast
    // regardless of theme (this arrow is always cyan, not the user's chosen
    // accent).
    const numR = ICON_CENTER_OFFSET - 6;
    ctx.fillStyle = "#0d0f14";
    ctx.fillText(String(Math.round(ac.windSpeedKt)), cx + dir.x * numR, cy + dir.y * numR);
}

function drawScaleBar(w, h, scale) {
    const barMeters = 500;
    const barPx = barMeters * scale;
    const x1 = 16, y1 = h - 16;
    const x2 = x1 + barPx;
    ctx.strokeStyle = "#eef2ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y1);
    ctx.moveTo(x1, y1 - 4); ctx.lineTo(x1, y1 + 4);
    ctx.moveTo(x2, y1 - 4); ctx.lineTo(x2, y1 + 4);
    ctx.stroke();
    ctx.fillStyle = "#eef2ff";
    ctx.font = "12px 'Roboto Medium', sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.fillText("500 m", x1, y1 - 8);
}

// ---- Taxi guidance ribbon (the HUD is native-only, over the sim) --------

// Sharp turns reuse the plain turnLeft/turnRight text (only the arrow icon -
// see GUIDANCE_ICON_FILE below - changes for a sharp turn, not the wording).
const GUIDANCE_VERB_KEY = {
    continue: "guidance.continue", bearLeft: "guidance.bearLeft", bearRight: "guidance.bearRight",
    turnLeft: "guidance.turnLeft", turnRight: "guidance.turnRight",
    sharpLeft: "guidance.turnLeft", sharpRight: "guidance.turnRight",
    cross: "guidance.cross", holdShort: "guidance.holdShort", arrive: "guidance.arriveStand",
};
function formatDistanceParts(m, feet) {
    if (feet) {
        const ft = m * 3.28084;
        if (ft >= 1500) return { num: (ft / 5280).toFixed(1), unit: "mi" };
        return { num: String(Math.round(ft / 50) * 50), unit: "ft" };
    }
    if (m >= 1000) return { num: (m / 1000).toFixed(1), unit: "km" };
    return { num: String(Math.round(m / 10) * 10), unit: "m" };
}

// User-supplied direction glyphs (web/assets/guidance/*.png, white on
// transparent) - tinted at draw time, cached per colour. Fall back to the
// vector shapes until an image has loaded.
const GUIDANCE_ICON_FILE = {
    continue: "straight",
    bearLeft: "turn-left", turnLeft: "turn-left",
    bearRight: "turn-right", turnRight: "turn-right",
    sharpLeft: "sharp-left", sharpRight: "sharp-right",
    cross: "cross", holdShort: "hold-short",
};
const guidanceIconImg = {};
for (const f of new Set(Object.values(GUIDANCE_ICON_FILE))) {
    const im = new Image();
    im.onload = () => { im._ok = true; };
    im.src = "assets/guidance/" + f + ".png";
    guidanceIconImg[f] = im;
}
const guidanceTintCache = new Map();
function tintedGuidanceIcon(file, color) {
    const im = guidanceIconImg[file];
    if (!im || !im._ok) return null;
    const key = file + "|" + color;
    let cv = guidanceTintCache.get(key);
    if (!cv) {
        cv = document.createElement("canvas");
        cv.width = im.naturalWidth;
        cv.height = im.naturalHeight;
        const c2 = cv.getContext("2d");
        c2.drawImage(im, 0, 0);
        c2.globalCompositeOperation = "source-in";
        c2.fillStyle = color;
        c2.fillRect(0, 0, cv.width, cv.height);
        guidanceTintCache.set(key, cv);
    }
    return cv;
}

function guidancePrefs() {
    // Only `.ribbon` and `.unitsFeet` are actually read anywhere in this file
    // - the HUD is native-only and never rendered here.
    return (mapData && mapData.guidancePrefs) || { ribbon: true, unitsFeet: 0 };
}

function guidanceVerbColor(verb) {
    if (verb === "cross") return "#ffb300";
    if (verb === "holdShort") return "#ff4757";
    if (verb === "arrive") return "#00e676";
    return accentColor();
}

function guidanceText(verb, target) {
    if (!verb || verb === "none") return "";
    if (verb === "arrive" && !target) return t("guidance.arrive");
    return t(GUIDANCE_VERB_KEY[verb] || "guidance.continue", { id: target || "" }).trim();
}

// Raw template ("TURN LEFT {id}") so the id can be drawn in the map's yellow
// taxiway-sign colour, like the native ribbon.
const TWY_YELLOW = "#ffdd00";
function guidanceTemplate(verb) {
    if (!verb || verb === "none") return "";
    if (verb === "arrive") return t("guidance.arriveStand");
    return t(GUIDANCE_VERB_KEY[verb] || "guidance.continue");
}
// Draws `tmpl` with the "{id}" slot in idColor and the rest in baseColor,
// left-aligned from x at baseline y. Returns total advance width.
function drawTemplated(x, y, tmpl, id, baseColor, idColor) {
    const slot = tmpl.indexOf("{id}");
    if (slot < 0) { ctx.fillStyle = baseColor; ctx.fillText(tmpl, x, y); return ctx.measureText(tmpl).width; }
    const pre = tmpl.slice(0, slot), post = tmpl.slice(slot + 4);
    let cx = x;
    ctx.fillStyle = baseColor; ctx.fillText(pre, cx, y); cx += ctx.measureText(pre).width;
    ctx.fillStyle = idColor; ctx.fillText(id, cx, y); cx += ctx.measureText(id).width;
    ctx.fillStyle = baseColor; ctx.fillText(post, cx, y); cx += ctx.measureText(post).width;
    return cx - x;
}
function templatedWidth(tmpl, id) {
    const slot = tmpl.indexOf("{id}");
    if (slot < 0) return ctx.measureText(tmpl).width;
    return ctx.measureText(tmpl.slice(0, slot)).width + ctx.measureText(id).width + ctx.measureText(tmpl.slice(slot + 4)).width;
}

function formatGuidanceDistance(m, feet) {
    const p = formatDistanceParts(m, feet);
    return p.num + " " + p.unit;
}

// Bold vector direction glyph, box side `s` centred on (cx,cy), "ahead" = up.
// Swapped for user PNGs later; this is the fallback.
function drawGuidanceGlyph(cx, cy, s, verb, color) {
    const iconFile = GUIDANCE_ICON_FILE[verb];
    if (iconFile) {
        const tc = tintedGuidanceIcon(iconFile, color);
        if (tc) { ctx.drawImage(tc, cx - s / 2, cy - s / 2, s, s); return; }
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2.5, s * 0.155);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const head = (tipX, tipY, dx, dy, size) => {
        const l = Math.hypot(dx, dy) || 1;
        dx /= l; dy /= l;
        const px = -dy, py = dx;
        const bx = tipX - dx * size, by = tipY - dy * size;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(bx + px * size * 0.62, by + py * size * 0.62);
        ctx.lineTo(bx - px * size * 0.62, by - py * size * 0.62);
        ctx.closePath();
        ctx.fill();
    };
    const straight = () => {
        ctx.beginPath();
        ctx.moveTo(cx, cy + s * 0.46);
        ctx.lineTo(cx, cy - s * 0.14);
        ctx.stroke();
        head(cx, cy - s * 0.44, 0, -1, s * 0.34);
    };
    const arc = (left, sharp) => {
        const r = s * 0.4;
        const sweep = (sharp ? 150 : 92) * Math.PI / 180;
        const cxr = cx + (left ? -r : r), cyr = cy - s * 0.04;
        ctx.beginPath();
        ctx.moveTo(cx, cy + s * 0.52);
        ctx.lineTo(cx, cyr);
        ctx.stroke();
        const a0 = left ? 0 : Math.PI;
        const a1 = left ? -sweep : Math.PI + sweep;
        ctx.beginPath();
        ctx.arc(cxr, cyr, r, a0, a1, left); // anticlockwise for left
        ctx.stroke();
        const tipX = cxr + r * Math.cos(a1), tipY = cyr + r * Math.sin(a1);
        const dx = left ? Math.sin(a1) : -Math.sin(a1);
        const dy = left ? -Math.cos(a1) : Math.cos(a1);
        head(tipX + dx * s * 0.08, tipY + dy * s * 0.08, dx, dy, s * 0.32);
    };
    switch (verb) {
        case "continue": straight(); break;
        case "bearLeft": case "turnLeft": arc(true, false); break;
        case "bearRight": case "turnRight": arc(false, false); break;
        case "sharpLeft": arc(true, true); break;
        case "sharpRight": arc(false, true); break;
        case "cross": {
            const b = s * 0.46;
            ctx.beginPath();
            ctx.moveTo(cx - b, cy - s * 0.20); ctx.lineTo(cx + b, cy - s * 0.20);
            ctx.moveTo(cx - b, cy + s * 0.20); ctx.lineTo(cx + b, cy + s * 0.20);
            ctx.stroke();
            straight();
            break;
        }
        case "holdShort":
            ctx.beginPath();
            ctx.moveTo(cx, cy + s * 0.48); ctx.lineTo(cx, cy - s * 0.06);
            ctx.stroke();
            ctx.fillRect(cx - s * 0.48, cy - s * 0.30, s * 0.96, s * 0.18);
            break;
        case "arrive":
            ctx.beginPath(); ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(cx, cy, s * 0.16, 0, Math.PI * 2); ctx.fill();
            break;
        default: break;
    }
    ctx.restore();
}

// The one instruction to show, resolved to template + id + colours + glyph.
function resolveGuidance(g) {
    if (g.notStarted) return { tmpl: t("guidance.startTaxi"), id: "", base: accentColor(), idCol: accentColor(), glyph: "none" };
    if (g.offRoute) return { tmpl: t("guidance.offRoute"), id: "", base: "#ffb300", idCol: "#ffb300", glyph: "none" };
    if (g.complete) return { tmpl: t("guidance.complete"), id: "", base: "#00e676", idCol: "#00e676", glyph: "arrive" };
    if (g.verb === "arrive" && !g.target) return { tmpl: t("guidance.arrive"), id: "", base: "#00e676", idCol: "#00e676", glyph: "arrive" };
    const base = guidanceVerbColor(g.verb);
    const idCol = (g.verb === "cross" || g.verb === "holdShort") ? base : TWY_YELLOW;
    return { tmpl: guidanceTemplate(g.verb), id: g.target || "", base, idCol, glyph: g.verb };
}

const LABEL_COL = "#c8d0e0"; // brighter than the old dim grey (real-usage: too faint)

function drawGuidanceRibbon(w, h, pref) {
    const g = mapData.guidance;
    const ac = liveAircraft || (mapData ? mapData.aircraft : null);
    const gs = ac ? ac.groundSpeedKt : 0;

    const ins = resolveGuidance(g);
    if (!ins.tmpl) return;
    const showDist = !g.offRoute && !g.complete && !g.notStarted;
    const atHold = g.verb === "holdShort" && g.distanceMeters < 6;
    const distStr = !showDist ? ""
        : atHold ? t("guidance.hold")
        : g.distanceMeters < 16 ? "NOW"
        : formatGuidanceDistance(g.distanceMeters, pref.unitsFeet);
    let onLabel = g.onLeg ? t("guidance.on") : "";
    const showThen = showDist && g.thenVerb && g.thenVerb !== "none";
    let thenLabel = showThen ? t("guidance.then") : "";
    const thenTmpl = showThen ? guidanceTemplate(g.thenVerb) : "";

    const pad = 12, gap = 9, glyphBox = 19;
    const instrFont = "13px 'Roboto Medium', sans-serif";
    const monoFont = "15px 'Cousine', monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    ctx.font = instrFont;
    const wInstr = templatedWidth(ins.tmpl, ins.id);
    let wThen = thenTmpl ? gap + ctx.measureText(thenLabel + " ").width + templatedWidth(thenTmpl, g.thenTarget || "") : 0;
    ctx.font = monoFont;
    let wOn = onLabel ? ctx.measureText(onLabel + " " + g.onLeg).width + gap : 0;
    let wDist = distStr ? gap + ctx.measureText(distStr).width : 0;
    const wGlyph = glyphBox + gap;

    const leftLimit = 12 + 216 + 14;
    const rightLimit = w - 112 - 14;
    const availW = rightLimit - leftLimit;

    let contentW = wOn + wGlyph + wInstr + wDist + wThen;
    if (contentW > availW - 2 * pad && wThen) { thenLabel = ""; wThen = 0; contentW = wOn + wGlyph + wInstr + wDist; }
    if (contentW > availW - 2 * pad && wOn) { onLabel = ""; wOn = 0; contentW = wGlyph + wInstr + wDist; }

    const boxW = contentW + 2 * pad;
    const boxH = 30;
    let x0 = w / 2 - boxW / 2;
    if (availW > boxW) x0 = Math.max(leftLimit, Math.min(x0, rightLimit - boxW));
    const y0 = 12, midY = y0 + boxH / 2;

    ctx.save();

    roundRect(x0, y0, boxW, boxH, 6);
    ctx.fillStyle = "rgba(19,22,30,0.93)";
    ctx.fill();
    ctx.strokeStyle = ins.base;
    ctx.lineWidth = 1;
    ctx.stroke();
    const frac = Math.max(0, Math.min(1, g.routeProgressFrac || 0));
    ctx.strokeStyle = ins.base;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0 + 1, y0 + boxH - 1);
    ctx.lineTo(x0 + 1 + (boxW - 2) * frac, y0 + boxH - 1);
    ctx.stroke();

    let x = x0 + pad;
    if (onLabel) {
        ctx.font = monoFont;
        ctx.fillStyle = LABEL_COL;
        ctx.fillText(onLabel + " ", x, midY);
        x += ctx.measureText(onLabel + " ").width;
        ctx.fillStyle = TWY_YELLOW;
        ctx.fillText(g.onLeg, x, midY);
        x += ctx.measureText(g.onLeg).width + gap;
    }
    drawGuidanceGlyph(x + glyphBox / 2, midY, glyphBox, ins.glyph, ins.base);
    x += glyphBox + gap;
    ctx.font = instrFont;
    x += drawTemplated(x, midY, ins.tmpl, ins.id, ins.base, ins.idCol);
    if (distStr) {
        x += gap;
        ctx.font = monoFont;
        ctx.fillStyle = "#eef2ff";
        ctx.fillText(distStr, x, midY);
        x += ctx.measureText(distStr).width;
    }
    if (thenLabel) {
        x += gap;
        ctx.font = instrFont;
        ctx.fillStyle = LABEL_COL;
        ctx.fillText(thenLabel + " ", x, midY);
        x += ctx.measureText(thenLabel + " ").width;
        drawTemplated(x, midY, thenTmpl, g.thenTarget || "", LABEL_COL, TWY_YELLOW);
    }
    ctx.restore();
}

// The HUD is a native-only overlay drawn over the X-Plane sim (see
// src/ui/GuidanceRender.cpp / Window.cpp) - the web frontend never renders it,
// only the in-map ribbon. Its settings still sync via /api/settings so a
// browser on a tablet can configure the sim HUD.
function drawGuidance(w, h) {
    if (!mapData || !mapData.guidance || !mapData.guidance.valid) return;
    if (guidancePrefs().ribbon) drawGuidanceRibbon(w, h, guidancePrefs());
}

function drawPositionOverlay() {
    const ac = liveAircraft || (mapData ? mapData.aircraft : null);
    if (!ac) return;
    const x0 = 12, y0 = 12;
    const padX = 10, lineH = 21, padTop = 20, padBottom = 8;

    // Real-usage request: LAT/LON/GS/HDG mean nothing useful while airborne
    // (this box isn't a nav instrument, just ground-ops context), so show a
    // plain "IN FLIGHT" status instead of numbers that just look stale. See
    // PanelMap.cpp's DrawPositionOverlay (native parity).
    const lines = ac.onGround
        ? [
              `LAT ${ac.lat.toFixed(4)}  LON ${ac.lon.toFixed(4)}`,
              `GS  ${Math.round(ac.groundSpeedKt)} kt`,
              // Magnetic heading here, not true - matches the aircraft's own
              // heading indicator/compass, which is what a pilot is actually
              // comparing this readout against (real-usage report: true heading
              // read as "off by a few degrees" from the aircraft's instruments -
              // that's the local magnetic variation). The icon's own rotation,
              // above, intentionally keeps using true heading since the map is
              // projected true-north-up.
              `HDG ${Math.round(ac.headingMagDeg)} deg`,
          ]
        : [t("map.inFlight")];

    // Sized to fit the actual rendered text (measured, not a fixed guess) -
    // real-usage report: a fixed-width box (ported from the native
    // version's own hardcoded 216px) clipped its own content on the web
    // build, whose font metrics don't exactly match ImGui's baked glyphs.
    ctx.font = "14px 'Cousine', monospace";
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = textW + padX * 2;
    const h = padTop + lineH * (lines.length - 1) + padBottom;

    ctx.fillStyle = "rgba(13,15,20,0.75)";
    ctx.strokeStyle = accentColor();
    ctx.lineWidth = 1;
    roundRect(x0, y0, w, h, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#c8d0e0";
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    lines.forEach((line, i) => {
        ctx.fillText(line, x0 + padX, y0 + padTop + i * lineH);
    });
}

function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

// Last-written value per field, so updateHeader() (called every render()
// frame) only touches the DOM when something actually changed - see
// headerEls's own comment for why that matters here specifically.
let lastHeader = { icao: null, name: null, statusText: null, statusClass: null,
                    noRouteDisplay: null, zoomPct: null, clearRouteDisplay: null };

function updateHeader() {
    const icaoText = mapData ? mapData.icao : "-";
    if (icaoText !== lastHeader.icao) { headerEls.icao.textContent = icaoText; lastHeader.icao = icaoText; }

    const nameText = mapData ? mapData.name : "";
    if (nameText !== lastHeader.name) { headerEls.name.textContent = nameText; lastHeader.name = nameText; }

    const aircraftOnAirport = !!(liveAircraft ? liveAircraft.onAirport : mapData?.aircraftOnAirport);
    if (mapData) {
        if (aircraftOnAirport) {
            const statusText = t("map.gpsLive");
            if (statusText !== lastHeader.statusText || lastHeader.statusClass !== "live") {
                headerEls.status.textContent = statusText;
                headerEls.status.className = "live";
                lastHeader.statusText = statusText;
                lastHeader.statusClass = "live";
            }
            // Genuinely needs a per-frame write while pulsing - this is the
            // one field real-time animation actually requires.
            headerEls.status.style.opacity = String(pulseAlpha());
        } else {
            const statusText = t("map.offAirport");
            if (statusText !== lastHeader.statusText || lastHeader.statusClass !== "off") {
                headerEls.status.textContent = statusText;
                headerEls.status.className = "off";
                headerEls.status.style.opacity = "1";
                lastHeader.statusText = statusText;
                lastHeader.statusClass = "off";
            }
        }
    } else if (lastHeader.statusText !== "") {
        headerEls.status.textContent = "";
        lastHeader.statusText = "";
        lastHeader.statusClass = null;
    }

    const noRouteDisplay = mapData && !mapData.hasTaxiRouteNetwork ? "block" : "none";
    if (noRouteDisplay !== lastHeader.noRouteDisplay) {
        headerEls.noRouteBadge.style.display = noRouteDisplay;
        lastHeader.noRouteDisplay = noRouteDisplay;
    }

    const zoomPct = Math.round(zoom * 100) + "%";
    if (zoomPct !== lastHeader.zoomPct) { headerEls.zoomPct.textContent = zoomPct; lastHeader.zoomPct = zoomPct; }

    const clearRouteDisplay =
        mapData && mapData.hasTaxiRouteNetwork && routeSelection.edgeIndices.length > 0 ? "inline-block" : "none";
    if (clearRouteDisplay !== lastHeader.clearRouteDisplay) {
        headerEls.clearRouteBtn.style.display = clearRouteDisplay;
        lastHeader.clearRouteDisplay = clearRouteDisplay;
    }
}

let lastToScreen = null;
let lastClusterProject = null;
let lastEffectiveScale = 1;

// ---- Interaction: pan/zoom/click, mouse + touch --------------------------

let pointers = new Map(); // pointerId -> {x, y}
let dragStart = null; // {x, y, time}
// Which mouse button started the current single-pointer drag (0 = left, or
// a touch/pen contact; 2 = right) - decides pan vs. manual-rotate in
// pointermove below. Meaningless for a 2-pointer pinch.
let dragButton = 0;
let pinchStartDist = null;
let pinchStartZoom = 1;
// Degrees of rotation per horizontal pixel of right-drag - tuned by feel,
// same order of magnitude as a typical map app's rotate gesture.
const RIGHT_DRAG_ROTATE_DEG_PER_PX = 0.4;

function canvasRelativePos(clientX, clientY) {
    const rect = canvasRect();
    // rect is the on-screen box (after any CSS `zoom` from "Interface
    // scale"); the pointer event is in the same screen space, but the
    // drawing / hit-test space is the pre-zoom logical size. Scale the
    // offset so a click lands on the taxiway it appears over at any
    // Interface scale (and under browser zoom too).
    const sx = rect.width ? canvas.clientWidth / rect.width : 1;
    const sy = rect.height ? canvas.clientHeight / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
}

// Suppresses the browser's own right-click context menu over the canvas -
// without this, releasing a right-drag (see pointerdown/pointermove below)
// would pop up "Back/Reload/Inspect" on top of the map.
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    // Refresh the cached canvas rect at the start of a gesture; pointermove
    // then reuses it instead of forcing a layout read per event.
    canvasRectCache = null;
    requestRender();
    pointers.set(ev.pointerId, canvasRelativePos(ev.clientX, ev.clientY));
    if (pointers.size === 1) {
        dragButton = ev.button;
        dragStart = { ...canvasRelativePos(ev.clientX, ev.clientY), time: performance.now(), pointerType: ev.pointerType };
    } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchStartZoom = zoom;
        dragStart = null; // two-finger gesture is zoom/pan, not a click
    }
});

canvas.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    requestRender();
    const prev = pointers.get(ev.pointerId);
    const cur = canvasRelativePos(ev.clientX, ev.clientY);
    pointers.set(ev.pointerId, cur);

    if (pointers.size === 1 && dragStart && dragButton === 2) {
        // Right-drag: manual rotation around the canvas center (see
        // render()'s toScreen - the same pivot the auto heading-up
        // rotation uses, so this composes correctly with active north
        // tracking too, only "heading" tracking directly conflicts).
        rotationDeg += (cur.x - prev.x) * RIGHT_DRAG_ROTATE_DEG_PER_PX;
        if (trackMode === "heading") setTrackMode("off");
    } else if (pointers.size === 1 && dragStart) {
        panOffset.x += cur.x - prev.x;
        panOffset.y += cur.y - prev.y;
        // A manual pan means the user wants to look elsewhere - stop
        // fighting them with the next frame's auto-recenter.
        if (trackMode !== "off") setTrackMode("off");
    } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchStartDist && pinchStartDist > 0) {
            zoom = pinchStartZoom * (dist / pinchStartDist);
            clampZoom();
        }
        const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
        // Pan follows the pinch midpoint too, so a two-finger drag+zoom
        // together feels natural on tablet.
        if (ev.pointerType !== "mouse") {
            panOffset.x += cur.x - prev.x - (cur.x - midX - (prev.x - midX));
        }
        if (trackMode !== "off") setTrackMode("off");
    }
});

function endPointer(ev) {
    if (!pointers.has(ev.pointerId)) return;
    requestRender();
    const wasSingle = pointers.size === 1;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStartDist = null;

    if (wasSingle && dragStart) {
        const pos = canvasRelativePos(ev.clientX, ev.clientY);
        const moved = Math.hypot(pos.x - dragStart.x, pos.y - dragStart.y);
        // A right-button release is a rotate gesture, not a route-edge click,
        // even if it moved less than the drag threshold.
        if (moved < CLICK_DRAG_THRESHOLD_PX && dragButton !== 2) {
            handleMapClick(pos, dragStart.pointerType);
        }
        dragStart = null;
    }
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    // Zoom-to-cursor (see PanelMap.cpp's own wheel handler, ported here -
    // #SG06 real-usage request: zooming used to always anchor on the
    // airport/canvas center, so zooming in on a spot near the canvas edge
    // required an extra pan to bring it back into view). Solving toScreen()'s
    // own transform for the pan offset that keeps the point currently under
    // the cursor fixed on screen across the zoom change: with k =
    // newZoom/oldZoom, panOffset' = (mouse - center) * (1 - k) + k * panOffset.
    const oldZoom = zoom;
    zoom *= Math.pow(1.1, -ev.deltaY / 100);
    clampZoom();
    const k = zoom / oldZoom;
    const mouse = canvasRelativePos(ev.clientX, ev.clientY);
    const centerX = sizeCache.w / 2, centerY = sizeCache.h / 2;
    panOffset.x = (mouse.x - centerX) * (1 - k) + k * panOffset.x;
    panOffset.y = (mouse.y - centerY) * (1 - k) + k * panOffset.y;
    requestRender();
}, { passive: false });

// Nearest solo-rendered (one-per-cluster-cell) parking stand to a click
// position, or -1. Shared by the SayIntentions assign-gate hit-test and the
// manual select/deselect hit-test in handleMapClick - identical clustering
// rule as the parking-drawing block's own grouping; mirrors PanelMap.cpp's
// FindSoloParkingHit.
function findSoloParkingHit(pos, pointerType) {
    if (!mapData || !Array.isArray(mapData.parking) || !lastClusterProject || !lastToScreen) return -1;
    const cellCount = new Map();
    const cellKey = (p) => {
        const cp = lastClusterProject(p.x, p.y);
        return Math.floor(cp.x / PARKING_CLUSTER_GRID_PX) + "," + Math.floor(cp.y / PARKING_CLUSTER_GRID_PX);
    };
    for (const p of mapData.parking) { const k = cellKey(p); cellCount.set(k, (cellCount.get(k) || 0) + 1); }

    const hitRadius = pointerType === "touch" ? PARKING_HIT_RADIUS_TOUCH_PX : PARKING_HIT_RADIUS_PX;
    let bestIndex = -1, bestScore = hitRadius;
    ctx.font = "11px 'Roboto Medium', sans-serif";
    for (let i = 0; i < mapData.parking.length; ++i) {
        const p = mapData.parking[i];
        if (!p.label || cellCount.get(cellKey(p)) !== 1) continue;
        const c = lastToScreen(p.x, p.y);
        let score = Math.hypot(pos.x - c.x, pos.y - c.y);
        // Label box - matches the fillText in render() (offset +7,-7,
        // left-aligned, alphabetic baseline), with slack.
        const tw = ctx.measureText(p.label).width;
        const lx = c.x + 7, ly = c.y - 7;
        if (pos.x >= lx - 2 && pos.x <= lx + tw + 2 && pos.y >= ly - 12 && pos.y <= ly + 4) {
            score = 0;
        }
        if (score < bestScore) { bestScore = score; bestIndex = i; }
    }
    return bestIndex;
}

function handleMapClick(pos, pointerType) {
    if (!mapData || !lastToScreen) return;

    // SayIntentions gate assignment: a click on a labelled parking stand
    // (feature enabled) is a request to assign that gate, and is consumed
    // here before any taxi-route pick. The dot AND its label text are both
    // click targets, and only stands that render solo (one per cluster grid
    // cell) count - mirrors PanelMap.cpp.
    if (mapData.siGate && mapData.siGate.enabled && Array.isArray(mapData.parking) && lastClusterProject) {
        const idx = findSoloParkingHit(pos, pointerType);
        if (idx >= 0) {
            onGateClicked(mapData.parking[idx].label);
            return;
        }
    } else if (mapData.siGate && !mapData.siGate.enabled && Array.isArray(mapData.parking) && lastClusterProject) {
        // MANUAL gate selection (SayIntentions inactive): the exact same
        // solo-stand hit-test as the SI branch above, but no confirmation -
        // straight to the toggle endpoint (select/deselect decided server-
        // side, see Window.cpp's ToggleManualGateSelect).
        const idx = findSoloParkingHit(pos, pointerType);
        if (idx >= 0) {
            onGateSelected(idx);
            return;
        }
    }

    if (!mapData.hasTaxiRouteNetwork || !taxiEdges) return;
    const radius = pointerType === "touch" ? EDGE_HIT_RADIUS_TOUCH_PX : EDGE_HIT_RADIUS_PX;
    let bestIdx = -1, bestDist = radius;
    for (const e of taxiEdges) {
        if (e.isRunwayCrossing) continue;
        if (!e.isVisible) continue; // a dedup loser isn't drawn anywhere - never a click target
        const a = lastToScreen(e.x1, e.y1);
        const b = lastToScreen(e.x2, e.y2);
        const d = distancePointToSegment(pos, a, b);
        if (d < bestDist) { bestDist = d; bestIdx = e.index; }
    }
    if (bestIdx >= 0) {
        onEdgeClicked(bestIdx);
    }
}

// ---- Public API ------------------------------------------------------

export function initMapPanel({ onEdgeClicked: edgeCb, onClearRoute: clearCb, onGateClicked: gateCb, onGateSelected: gateSelectCb }) {
    onEdgeClicked = edgeCb;
    onClearRoute = clearCb;
    onGateClicked = gateCb || (() => {});
    onGateSelected = gateSelectCb || (() => {});

    document.getElementById("zoom-out-btn").addEventListener("click", () => { zoom /= ZOOM_BUTTON_FACTOR; clampZoom(); requestRender(); });
    document.getElementById("zoom-reset-btn").addEventListener("click", () => { zoom = 1; panOffset = { x: 0, y: 0 }; rotationDeg = 0; requestRender(); });
    document.getElementById("zoom-in-btn").addEventListener("click", () => { zoom *= ZOOM_BUTTON_FACTOR; clampZoom(); requestRender(); });
    document.getElementById("clear-route-btn").addEventListener("click", () => onClearRoute());
    trackNorthBtn.addEventListener("click", () => setTrackMode("north"));
    trackHeadingBtn.addEventListener("click", () => setTrackMode("heading"));

    // Only invalidate the cached layout metrics - the rAF loop below renders
    // every frame anyway and will pick the new size up. Calling render()
    // straight from the observer forced an extra synchronous full render
    // (and layout read) per resize notification.
    new ResizeObserver(() => { invalidateLayout(); requestRender(); }).observe(wrap);
    window.addEventListener("resize", () => { invalidateLayout(); requestRender(); });
    window.addEventListener("scroll", () => { invalidateLayout(); requestRender(); }, { passive: true, capture: true });
    // Interface-scale (CSS `zoom`) changes - dispatched by js/uiscale.js.
    window.addEventListener("sgm-uiscale-changed", () => { invalidateLayout(); requestRender(); });
    // Accent colour change (--accent) - dispatched by js/settings.js.
    window.addEventListener("sgm-cssvars-changed", () => { refreshCssCache(); requestRender(); });
    // Language change - the map draws translated guidance / status strings.
    window.addEventListener("sgm-langchange", requestRender);
    refreshCssCache();

    function loop() {
        if (renderRequested || isAnimating() ||
            lastRenderTimeMs == null ||
            (performance.now() - lastRenderTimeMs) >= IDLE_HEARTBEAT_MS) {
            renderRequested = false;
            render();
        }
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

export function setActiveIcao(newIcao) {
    if (newIcao !== icao) {
        icao = newIcao;
        mapData = null;
        taxiEdges = null;
        routeSelection = { edgeIndices: [], nodeSequence: [], edges: [], nextRequiredNodeIndex: 1 };
        atisForActiveAirport = null;
        runwayUsageForActiveAirport = null;
        placeholder.textContent = t("map.loadingAirportData");
        requestRender();
    }
}

// ATIS for whichever airport is currently active - drives the runway-end
// DEP/ARR/closed dots. Pass null/undefined if nothing's been fetched yet
// for this airport (never draws "closed" without real data - see
// drawRunwayUsageIndicator).
export function setAtisForActiveAirport(atis) {
    atisForActiveAirport = atis || null;
    runwayUsageForActiveAirport =
        (atisForActiveAirport && atisForActiveAirport.success && atisForActiveAirport.available)
            ? buildRunwayUsage(atisForActiveAirport)
            : null;
    requestRender();
}

// Text shown in place of the canvas while mapData is null (loading/error/no
// selection yet) - see app.js's polling loop.
export function setMapLoadStatus(text) {
    placeholder.textContent = text;
    requestRender();
}

export function getActiveIcao() {
    return icao;
}

export function setMapData(data) {
    mapData = data;
    signWidthCache.clear();
    if (!data.hasTaxiRouteNetwork) {
        taxiEdges = null;
    }
    requestRender();
}

export function setTaxiNetwork(data) {
    taxiEdges = data.available ? data.edges : null;
    requestRender();
}

export function setRouteSelection(sel) {
    routeSelection = sel;
    requestRender();
}

export function setLiveAircraft(ac) {
    liveAircraft = ac;
    projectedAircraft = projectLatLon(ac.lat, ac.lon);
    requestRender();
}
