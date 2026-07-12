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

const AIRPORTS_POLL_MS = 2000;
const MAP_POLL_MS = 1500;
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

function selectIcao(icao) {
    if (icao === getActiveIcao()) return;
    setActiveIcao(icao);
    taxiNetworkFetchedFor = null;
    setAtisForActiveAirport(atisByIcao[icao]); // don't wait for the next ATIS poll tick if already fetched
}

initAirportsPanel({ onSelectIcao: selectIcao });
initMapPanel({
    onEdgeClicked: (edgeIndex) => {
        const icao = getActiveIcao();
        if (icao) api.clickTaxiRouteEdge(icao, edgeIndex);
    },
    onClearRoute: () => {
        const icao = getActiveIcao();
        if (icao) api.clearTaxiRoute(icao);
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

let airportsPollBusy = false;
async function pollAirports() {
    if (airportsPollBusy) return;
    airportsPollBusy = true;
    try {
        const res = await api.getAirports();
        if (!res.ok) {
            setConnStatus(false, t("common.apiUnreachable"));
            return;
        }
        setConnStatus(true, t("common.connected"));
        lastAirportsBody = res.body;
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
    } finally {
        airportsPollBusy = false;
    }
}

let mapPollBusy = false;
async function pollMap() {
    const icao = getActiveIcao();
    if (!icao || mapPollBusy) return;
    mapPollBusy = true;
    try {
        const res = await api.getAirportMap(icao);
        if (res.status === 202) {
            setMapLoadStatus(t("map.loadingAirportData"));
        } else if (res.status === 404) {
            setMapLoadStatus(res.body?.error || t("map.airportNotFound"));
        } else if (res.ok) {
            setMapData(res.body);
            if (res.body.hasTaxiRouteNetwork && taxiNetworkFetchedFor !== icao) {
                taxiNetworkFetchedFor = icao;
                const net = await api.getTaxiNetwork(icao);
                if (net.ok) setTaxiNetwork(net.body);
            }
            if (res.body.hasTaxiRouteNetwork) {
                const route = await api.getTaxiRoute(icao);
                if (route.ok) setRouteSelection(route.body);
            }
        }
    } finally {
        mapPollBusy = false;
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
    pollAirports();
    setInterval(pollAirports, AIRPORTS_POLL_MS);
    setInterval(pollMap, MAP_POLL_MS);
}

init();
