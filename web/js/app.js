// Bootstrap + polling orchestration - ties api.js/airports.js/map.js/gps.js/
// settings.js together. No framework/build step (see NOTES.md (section 27)):
// this file just owns a handful of setInterval loops, each guarded against
// overlapping itself if a request is slow.
import { api } from "./api.js";
import { initAirportsPanel, renderAirportsPanel, icaosInPlan } from "./airports.js";
import { initMapPanel, setActiveIcao, getActiveIcao, setMapData, setTaxiNetwork, setRouteSelection, setLiveAircraft, setMapLoadStatus, setAtisForActiveAirport } from "./map.js";
import { initGpsStream } from "./gps.js";
import { initSettingsPanel } from "./settings.js";
import { initI18n, t } from "./i18n.js";

initI18n();

// Was two independent setInterval loops (2000ms airports, 1500ms map) -
// merged into one sequential tick (see pollAll below) because that gap let
// pollMap() fire, on its own schedule, a GET for this tab's own possibly-
// stale local ICAO after some *other* party (native UI, another web tab,
// the auto-switch-on-touchdown feature) had already changed the server's
// active airport - and that GET has a switch-back side effect (see
// WebServer.cpp's /map handler), fighting the change that just happened.
// Real-usage report: a native click briefly showed the new airport, then
// reverted to whatever the web tab had last shown. Sequencing pollMap
// immediately after pollAirports within the same tick means it always sees
// a freshly-reconciled getActiveIcao(), closing that window entirely rather
// than just narrowing it.
const POLL_MS = 1500;
const ATIS_POLL_MS = 8000;

let atisNetwork = 0;
let atisByIcao = {}; // icao -> AtisResult | undefined (undefined = never fetched)
let atisLastFetch = {}; // icao -> timestamp
let taxiNetworkFetchedFor = null;

const connStatus = document.getElementById("conn-status");
function setConnStatus(ok, text) {
    connStatus.textContent = text;
    connStatus.className = "conn-status " + (ok ? "ok" : "bad");
}

// Collapses the DEP/DEST/ALT list to give the map the full width - real-
// usage request, see NOTES.md. Per-browser (localStorage), not synced via
// /api/settings - see style.css's #main.list-collapsed comment for why.
const LIST_COLLAPSED_KEY = "sgm-list-collapsed";
const mainEl = document.getElementById("main");
const collapseBtn = document.getElementById("collapse-btn");
let listCollapsed = false;
function setListCollapsed(collapsed) {
    listCollapsed = collapsed;
    mainEl.classList.toggle("list-collapsed", collapsed);
    collapseBtn.innerHTML = (collapsed ? "&raquo; " : "&laquo; ") + t(collapsed ? "titlebar.showList" : "titlebar.hideList");
    collapseBtn.title = t(collapsed ? "titlebar.showListTitle" : "titlebar.hideListTitle");
    localStorage.setItem(LIST_COLLAPSED_KEY, collapsed ? "1" : "0");
}
collapseBtn.addEventListener("click", () => setListCollapsed(!mainEl.classList.contains("list-collapsed")));
setListCollapsed(localStorage.getItem(LIST_COLLAPSED_KEY) === "1");
window.addEventListener("sgm-langchange", () => setListCollapsed(listCollapsed));

// Common "switch to this ICAO locally" reset, shared by a user click
// (selectIcao) and by silently following the server's own active airport
// (pollAirports below) - see localSelectionPendingSince's comment for why
// those two cases are NOT the same thing despite both calling this.
function adoptActiveIcao(icao) {
    setActiveIcao(icao);
    taxiNetworkFetchedFor = null;
    setAtisForActiveAirport(atisByIcao[icao]); // don't wait for the next ATIS poll tick if already fetched
    // Real-usage report: clicking a card felt slow - nothing fetched the
    // new airport's map at all until the next scheduled pollMap() tick (up
    // to POLL_MS away), same gap the taxi-route click had (see
    // refreshRouteSelectionNow above). loadMapNow (below) fires immediately
    // instead and fast-retries while still loading.
    loadMapNow(icao);
}

// Timestamp (Date.now()) of this browser's own most recent airport click,
// or 0 if none is in flight - real-usage report: the web's active ICAO used
// to be pure local state that never listened to the server's own
// `selectedIcao` at all. That meant a native click, another web client's
// click, or the plugin's own auto-switch-on-touchdown never propagated
// here - this tab just kept re-requesting its stale choice every pollMap()
// tick, which (see WebServer.cpp's /map handler) makes the *server* switch
// back to it every time, fighting whatever just changed it and leaving the
// display stuck flapping between two airports. pollAirports below now
// follows the server's selectedIcao whenever it differs from ours - but
// only when we're not ourselves mid-click, or it would instead undo this
// tab's own just-made selection during the brief window before the
// server catches up (see adoptActiveIcao's own two call sites). Expires on
// its own after LOCAL_SELECTION_PENDING_TIMEOUT_MS as a safety net, in case
// this tab's own request lost a race to a concurrent change elsewhere and
// the server's selectedIcao never ends up matching what we asked for.
let localSelectionPendingSince = 0;
const LOCAL_SELECTION_PENDING_TIMEOUT_MS = 5000;

function selectIcao(icao) {
    if (icao === getActiveIcao()) return;
    adoptActiveIcao(icao);
    localSelectionPendingSince = Date.now();
}

initAirportsPanel({ onSelectIcao: selectIcao });
// Re-fetches the route selection right after a click/clear POST resolves,
// instead of waiting for the next pollMap() tick (up to POLL_MS away) -
// the native panel reflects a click the same frame, so leaving the web one
// to lag by up to 1.5s read as "the selection doesn't register"/"nothing
// gets highlighted" (real-usage report), especially since a second click
// fired before the first's effect was visible just toggles the same chain
// back off server-side (HandleEdgeClick's own remove-if-already-selected
// rule), compounding the perceived flakiness.
//
// A click POST only enqueues the action (see WebServer.cpp) - the plugin
// applies it on its own next frame, which used to be throttled to the same
// 100ms as the state snapshot (fixed natively, see DrainWebActions's
// comment in Window.cpp), but even at native-frame speed there's no hard
// guarantee this first fetch lands after that frame has run. One extra
// fetch a little later, always applied, costs nothing on a local API and
// closes that remaining window instead of silently falling back to the
// slow poll (real-usage report: still "about a second" of lag on the web
// build with only the immediate fetch).
async function refreshRouteSelectionNow() {
    const icao = getActiveIcao();
    if (!icao) return;
    const apply = async () => {
        const route = await api.getTaxiRoute(icao);
        if (route.ok && icao === getActiveIcao()) setRouteSelection(route.body);
    };
    await apply();
    setTimeout(apply, 150);
}

initMapPanel({
    onEdgeClicked: async (edgeIndex) => {
        const icao = getActiveIcao();
        if (!icao) return;
        await api.clickTaxiRouteEdge(icao, edgeIndex);
        refreshRouteSelectionNow();
    },
    onClearRoute: async () => {
        const icao = getActiveIcao();
        if (!icao) return;
        await api.clearTaxiRoute(icao);
        refreshRouteSelectionNow();
    },
});
const settingsPanel = initSettingsPanel({
    onSettingsChanged: (settings) => {
        atisNetwork = settings.atisNetwork;
    },
});
initGpsStream(
    (data) => setLiveAircraft(data),
    (ok) => setConnStatus(ok, ok ? t("common.live") : t("common.gpsDisconnected"))
);

let lastAirportsBody = null; // re-rendered immediately on a language change, see below - no need to wait for the next poll tick
function renderAirports() {
    if (lastAirportsBody) renderAirportsPanel(lastAirportsBody, atisByIcao, atisNetwork, getActiveIcao());
}
window.addEventListener("sgm-langchange", renderAirports);

async function pollAirports() {
    try {
        const res = await api.getAirports();
        if (!res.ok) {
            setConnStatus(false, t("common.apiUnreachable"));
            return;
        }
        setConnStatus(true, t("common.connected"));
        lastAirportsBody = res.body;

        // Reconcile against the server's own active airport - see
        // localSelectionPendingSince's comment for why this is the fix for
        // the web/native selection fighting each other. If it matches what
        // we're currently showing, any pending click of ours (or nobody
        // else's change) has been confirmed. If it doesn't, and we're not
        // ourselves waiting on a just-made click, someone else changed it -
        // follow along instead of re-asserting our stale choice next tick.
        if (res.body.selectedIcao) {
            const stillPending = localSelectionPendingSince &&
                (Date.now() - localSelectionPendingSince) < LOCAL_SELECTION_PENDING_TIMEOUT_MS;
            if (res.body.selectedIcao === getActiveIcao()) {
                localSelectionPendingSince = 0;
            } else if (!stillPending) {
                adoptActiveIcao(res.body.selectedIcao);
            }
        }

        renderAirportsPanel(res.body, atisByIcao, atisNetwork, getActiveIcao());

        const icaos = icaosInPlan(res.body);
        const now = Date.now();
        for (const icao of icaos) {
            const last = atisLastFetch[icao] || 0;
            if (now - last >= ATIS_POLL_MS) {
                atisLastFetch[icao] = now;
                api.getAtis(icao).then((r) => {
                    atisByIcao[icao] = r.ok ? r.body : undefined; // 404 = not fetched yet server-side
                    if (icao === getActiveIcao()) {
                        setAtisForActiveAirport(atisByIcao[icao]);
                    }
                });
            }
        }
    } catch {
        setConnStatus(false, t("common.apiUnreachable"));
    }
}

// Fetches one round of map (+ taxi-network/-route, if applicable) data for
// `icao` and applies it. Returns "loading" (202 - the plugin is still
// resolving/parsing this airport's apt.dat), "ok", "error" (404), or
// "stale" (the active airport changed while this was in flight - see the
// re-check comment below). Shared by the periodic pollMap() and the
// immediate/fast-retrying loadMapNow() (both below) so there's exactly one
// place that knows how to load a map.
async function fetchMapOnce(icao) {
    const res = await api.getAirportMap(icao);
    // Re-check the active airport after every await below - the user may
    // have switched to a different one while this request was in flight,
    // and applying a slow response for the old ICAO on top of the new
    // one's already-loaded map would silently mix one airport's taxiways/
    // route into another's display (real-usage report).
    if (icao !== getActiveIcao()) return "stale";
    if (res.status === 202) {
        setMapLoadStatus(t("map.loadingAirportData"));
        return "loading";
    }
    if (res.status === 404) {
        setMapLoadStatus(res.body?.error || t("map.airportNotFound"));
        return "error";
    }
    if (!res.ok) {
        return "error";
    }
    setMapData(res.body);
    if (res.body.hasTaxiRouteNetwork) {
        // Independent of each other (both only need `icao`) - fetched in
        // parallel rather than one-after-the-other, shaving a round trip
        // off how long a first load takes to finish (real-usage report).
        const netPromise = taxiNetworkFetchedFor !== icao
            ? api.getTaxiNetwork(icao).then((net) => {
                  if (net.ok && icao === getActiveIcao()) setTaxiNetwork(net.body);
              })
            : Promise.resolve();
        taxiNetworkFetchedFor = icao;
        const routePromise = api.getTaxiRoute(icao).then((route) => {
            if (route.ok && icao === getActiveIcao()) setRouteSelection(route.body);
        });
        await Promise.all([netPromise, routePromise]);
    }
    return "ok";
}

let mapPollBusy = false;
async function pollMap() {
    const icao = getActiveIcao();
    if (!icao || mapPollBusy) return;
    mapPollBusy = true;
    try {
        await fetchMapOnce(icao);
    } finally {
        mapPollBusy = false;
    }
}

// Fires right after adoptActiveIcao instead of waiting out POLL_MS for
// the next scheduled pollMap() tick, then keeps re-checking quickly
// (FAST_RETRY_MS, not the full POLL_MS) while the plugin is still
// loading this airport's apt.dat (a 202, typically only on a first-ever
// lookup this session - see AirportDatabase.cpp's own caching comment) -
// real-usage report: clicking a card felt slow for exactly these two
// stacked reasons. Shares mapPollBusy with pollMap so the two never issue
// overlapping requests for the same airport; a periodic pollMap() tick that
// lands while this is running just no-ops, same as it already did against
// itself.
const FAST_RETRY_MS = 200;
const FAST_RETRY_MAX_ATTEMPTS = 15; // ~3s of fast retries before yielding to the slow periodic poll
async function loadMapNow(icao) {
    if (mapPollBusy) return;
    mapPollBusy = true;
    try {
        for (let attempt = 0; attempt < FAST_RETRY_MAX_ATTEMPTS; attempt++) {
            const status = await fetchMapOnce(icao);
            if (status !== "loading" || icao !== getActiveIcao()) return;
            await new Promise((resolve) => setTimeout(resolve, FAST_RETRY_MS));
        }
    } finally {
        mapPollBusy = false;
    }
}

// Single combined poll tick - see POLL_MS's own comment for why pollAirports
// (reconcile against the server's selectedIcao) must run to completion
// before pollMap (fetch the map for whatever getActiveIcao() now is) rather
// than the two running on independent timers.
let pollAllBusy = false;
async function pollAll() {
    if (pollAllBusy) return;
    pollAllBusy = true;
    try {
        await pollAirports();
        await pollMap();
    } finally {
        pollAllBusy = false;
    }
}

// GitHub raw-content mirror of src/Version.h's kString - see NOTES.md.
// Fetched directly by the browser (raw.githubusercontent.com sends
// Access-Control-Allow-Origin: *, no server-side proxy needed), once per
// page load, not on any timer - this is a "let the user know" nicety, not
// something that needs to notice a brand new release mid-session.
const UPDATE_CHECK_URL = "https://raw.githubusercontent.com/Rackham-Sim/SimGround-Map/main/Version.txt";

// Extracts the first "N.N" token found anywhere in the text (tolerant of
// Version.txt holding a whole descriptive line like "SimGround Map V1.0"
// rather than a bare number). Mirrors Window.cpp's ParseVersionToken.
function parseVersionToken(s) {
    const m = /(\d+)\.(\d+)/.exec(s || "");
    if (!m) return null;
    return { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) };
}

// Numeric, not lexicographic - "1.12" must beat "1.9" (12 > 9), which a
// plain string compare would get backwards.
function isNewerVersion(remote, local) {
    if (remote.major !== local.major) return remote.major > local.major;
    return remote.minor > local.minor;
}

async function checkForUpdate(localVersionStr) {
    const local = parseVersionToken(localVersionStr);
    if (!local) return;
    try {
        const res = await fetch(UPDATE_CHECK_URL, { cache: "no-store" });
        if (!res.ok) return;
        const remote = parseVersionToken(await res.text());
        if (remote && isNewerVersion(remote, local)) {
            document.getElementById("update-sep").style.display = "";
            document.getElementById("update-link").style.display = "";
        }
    } catch {
        // Offline / GitHub unreachable - not worth surfacing as an error,
        // same reasoning as the native side's silent failure.
    }
}

async function init() {
    const res = await api.getSettings();
    if (res.ok) {
        atisNetwork = res.body.atisNetwork;
        settingsPanel.populate(res.body); // also applies accent/opacity, see settings.js
        if (res.body.version) {
            document.getElementById("app-version").textContent = "v" + res.body.version;
            checkForUpdate(res.body.version);
        }
    }
    pollAll();
    setInterval(pollAll, POLL_MS);
}

init();
