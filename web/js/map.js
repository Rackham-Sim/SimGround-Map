// Ground map canvas - ported from PanelMap.cpp's ImDrawList rendering to
// Canvas 2D. Screen-space math (bounds/projection/ToScreen, click hit
// testing, parking clustering, rotated runway-end labels) mirrors that file
// line-for-line since both are y-down screen coordinate systems. See
// NOTES.md (section 27) for the one intentional gap (taxiwayChainLabels
// isn't in the API, so zoomed-in per-chain signage isn't replicated - every
// taxiway always shows one label at its own midpoint).
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
let liveAircraft = null; // {lat, lon, groundSpeedKt, headingDeg, headingMagDeg, onAirport, onGround} from SSE
let projectedAircraft = null; // {x, y} derived from liveAircraft + mapData.origin*
let atisForActiveAirport = null; // AtisResult for `icao`, or null if not fetched - drives the DEP/ARR/closed runway dots

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

function resizeCanvasToDisplaySize() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    return { w, h, dpr };
}

function computeBounds(map, includeAircraft) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    const add = (x, y) => {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    };
    for (const r of map.runways) { add(r.x1, r.y1); add(r.x2, r.y2); }
    for (const t of map.taxiways) { add(t.x1, t.y1); add(t.x2, t.y2); }
    for (const p of map.parking) { add(p.x, p.y); }
    if (includeAircraft && projectedAircraft) {
        add(projectedAircraft.x, projectedAircraft.y);
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

function drawAircraftIcon(x, y, headingDeg) {
    if (!aircraftIconBlack) {
        return; // image still loading (first frame or two) - skip rather than draw a placeholder shape
    }
    const rad = (headingDeg * Math.PI) / 180;
    const size = 32; // matches PanelMap.cpp's DrawAircraftIcon fixed 32x32 screen footprint
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);
    for (const [ox, oy] of AIRCRAFT_ICON_HALO_OFFSETS) {
        ctx.drawImage(aircraftIconBlack, -size / 2 + ox, -size / 2 + oy, size, size);
    }
    ctx.drawImage(aircraftIconImg, -size / 2, -size / 2, size, size);
    ctx.restore();
}

function pulseAlpha() {
    return 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(performance.now() / 1000 * 3));
}

function render() {
    const { w, h, dpr } = resizeCanvasToDisplaySize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    refreshCssCache();

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
    lastEffectiveScale = effectiveScale;

    // Runway usage from the currently displayed airport's ATIS, if any real
    // data has been fetched - see setAtisForActiveAirport(). Drives the
    // DEP/ARR/closed dots drawn alongside each end's number, below.
    const runwayUsage = (atisForActiveAirport && atisForActiveAirport.success && atisForActiveAirport.available)
        ? buildRunwayUsage(atisForActiveAirport)
        : null;

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
    if (mapData.hasTaxiRouteNetwork && routeSelection.edges && routeSelection.edges.length > 0) {
        ctx.strokeStyle = routeHighlightColor();
        ctx.lineWidth = Math.max(3, 6 * effectiveScale);
        ctx.lineCap = "round";
        const nextRequiredNodeIndex = routeSelection.nextRequiredNodeIndex ?? 1;
        const routeAircraftPos = aircraftOnAirport
            ? (projectedAircraft || (mapData.aircraft ? { x: mapData.aircraft.x, y: mapData.aircraft.y } : null))
            : null;
        for (let i = 0; i < routeSelection.edges.length; ++i) {
            if (i + 1 < nextRequiredNodeIndex) {
                continue; // walked - erased
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
            const a = toScreen(sx, sy);
            const b = toScreen(ex, ey);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
        ctx.lineCap = "butt";
    }

    // Taxiway signs - one per taxiway name at that segment's own midpoint
    // (see the file header comment re: taxiwayChainLabels not being
    // available over the API).
    ctx.font = "12px 'Cousine', monospace";
    for (const t of mapData.taxiways) {
        if (!t.label) continue;
        const a = toScreen(t.x1, t.y1);
        const b = toScreen(t.x2, t.y2);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const textW = ctx.measureText(t.label).width;
        const padX = 4, padY = 2;
        const textH = 12;
        ctx.fillStyle = "#000000";
        ctx.fillRect(mx - textW / 2 - padX, my - textH / 2 - padY, textW + padX * 2, textH + padY * 2);
        ctx.fillStyle = "#ffdd00";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(t.label, mx, my + 1);
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
        for (const cl of clusters.values()) {
            const cx = cl.sumX / cl.count, cy = cl.sumY / cl.count;
            if (cl.count === 1) {
                const p = mapData.parking[cl.firstIndex];
                ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2);
                ctx.fillStyle = cssCache.border2;
                ctx.fill();
                ctx.lineWidth = 1.5; ctx.strokeStyle = "#d500f9"; ctx.stroke();
                // --text (not --text-dim) - real-usage report: the dim tone
                // read as too dark/hard to make out against the busy map.
                ctx.fillStyle = cssCache.text;
                ctx.font = "11px 'Roboto Medium', sans-serif";
                ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
                ctx.fillText(p.label, cx + 7, cy - 7);
            } else {
                const r = 10;
                ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fillStyle = cssCache.border2;
                ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = "#d500f9"; ctx.stroke();
                ctx.fillStyle = "#eef2ff";
                ctx.font = "bold 12px 'Roboto Medium', sans-serif";
                ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.fillText(String(cl.count), cx, cy);
            }
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
        drawAircraftIcon(screenPos.x, screenPos.y, heading);
    } else {
        aircraftSmoothingValid = false; // re-snap next time it comes back into range
    }

    drawScaleBar(w, h, effectiveScale);
    drawPositionOverlay();
    drawCompassRose(w);
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
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
}

// Suppresses the browser's own right-click context menu over the canvas -
// without this, releasing a right-drag (see pointerdown/pointermove below)
// would pop up "Back/Reload/Inspect" on top of the map.
canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
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
    const wasSingle = pointers.size === 1;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchStartDist = null;

    if (wasSingle && dragStart) {
        const pos = canvasRelativePos(ev.clientX, ev.clientY);
        const moved = Math.hypot(pos.x - dragStart.x, pos.y - dragStart.y);
        // A right-button release is a rotate gesture, not a route-edge
        // click, even if it happened to move less than the drag threshold.
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
    zoom *= Math.pow(1.1, -ev.deltaY / 100);
    clampZoom();
}, { passive: false });

function handleMapClick(pos, pointerType) {
    if (!mapData || !mapData.hasTaxiRouteNetwork || !taxiEdges || !lastToScreen) return;
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

export function initMapPanel({ onEdgeClicked: edgeCb, onClearRoute: clearCb }) {
    onEdgeClicked = edgeCb;
    onClearRoute = clearCb;

    document.getElementById("zoom-out-btn").addEventListener("click", () => { zoom /= ZOOM_BUTTON_FACTOR; clampZoom(); });
    document.getElementById("zoom-reset-btn").addEventListener("click", () => { zoom = 1; panOffset = { x: 0, y: 0 }; rotationDeg = 0; });
    document.getElementById("zoom-in-btn").addEventListener("click", () => { zoom *= ZOOM_BUTTON_FACTOR; clampZoom(); });
    document.getElementById("clear-route-btn").addEventListener("click", () => onClearRoute());
    trackNorthBtn.addEventListener("click", () => setTrackMode("north"));
    trackHeadingBtn.addEventListener("click", () => setTrackMode("heading"));

    new ResizeObserver(() => render()).observe(wrap);

    function loop() {
        render();
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
        placeholder.textContent = t("map.loadingAirportData");
    }
}

// ATIS for whichever airport is currently active - drives the runway-end
// DEP/ARR/closed dots. Pass null/undefined if nothing's been fetched yet
// for this airport (never draws "closed" without real data - see
// drawRunwayUsageIndicator).
export function setAtisForActiveAirport(atis) {
    atisForActiveAirport = atis || null;
}

// Text shown in place of the canvas while mapData is null (loading/error/no
// selection yet) - see app.js's polling loop.
export function setMapLoadStatus(text) {
    placeholder.textContent = text;
}

export function getActiveIcao() {
    return icao;
}

export function setMapData(data) {
    mapData = data;
    if (!data.hasTaxiRouteNetwork) {
        taxiEdges = null;
    }
}

export function setTaxiNetwork(data) {
    taxiEdges = data.available ? data.edges : null;
}

export function setRouteSelection(sel) {
    routeSelection = sel;
}

export function setLiveAircraft(ac) {
    liveAircraft = ac;
    projectedAircraft = projectLatLon(ac.lat, ac.lon);
}
