// Airports list panel - DEP/DEST/ALT cards, add/delete/clear, ATIS badges -
// ported from PanelAirports.cpp's DrawAirportCard/DrawAtisBadge/
// DrawRunwayChipsAt. See NOTES.md (section 27).
import { api } from "./api.js";
import { atisBadgeState, renderAtisPopup, renderRunwayChips } from "./atis.js";
import { getLang, t } from "./i18n.js";

let onSelectIcao = () => {};
let onToggleSource = () => {};

// Small upright airplane silhouette - the same white PNG the map's own-ship
// icon uses (assets/aircraft-icon.png), mirroring theme::DrawAircraftGlyph
// in Theme.cpp.
function makeAircraftIcon(sizePx) {
    const img = document.createElement("img");
    img.src = "assets/aircraft-icon.png";
    img.width = sizePx;
    img.height = sizePx;
    img.alt = "";
    img.className = "aircraft-glyph";
    return img;
}

function makeEmptyCard() {
    const card = document.createElement("div");
    card.className = "airport-card empty";
    card.textContent = t("panel.noData");
    return card;
}

function makeCard(entry, { selected, atis, networkIndex, deletable, onDelete, gate }) {
    const card = document.createElement("div");
    card.className = "airport-card" + (selected ? " selected" : "");

    // Two-line header (#SG11): ICAO on its own line, city name below it -
    // replaces the old single side-by-side row (PanelAirports.cpp's
    // DrawAirportCard mirrors this same layout change).
    const header = document.createElement("div");
    header.className = "header-row";
    const headerLeft = document.createElement("div");
    headerLeft.className = "header-left";
    const icaoLine = document.createElement("div");
    icaoLine.className = "icao-line";
    const icao = document.createElement("span");
    icao.className = "icao mono";
    icao.textContent = entry.icao;
    icaoLine.appendChild(icao);
    // Small aircraft-position marker (#SG11) - fixed white, never the accent
    // (see map.js's drawAircraftIcon comment for why the aircraft stays a
    // dedicated non-accent color everywhere it appears), shown on whichever
    // card's real GPS position the aircraft is at right now (WebServer.cpp's
    // "aircraftHere" field) - not necessarily the card whose diagram is
    // currently selected.
    if (entry.aircraftHere) {
        icaoLine.appendChild(makeAircraftIcon(14));
    }
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = entry.name || t("panel.namePending");
    if (!entry.name) name.classList.add("dim");
    headerLeft.append(icaoLine, name);

    const badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";

    // Fixed-width ATIS/status columns (#SG11) - so the ATIS chip's own
    // position never shifts depending on whether the status column shows
    // "AUTO" or "MANUAL" (PanelAirports.cpp's kStatusColW/kAtisColGap).
    const atisCol = document.createElement("div");
    atisCol.className = "atis-col";
    const state = atisBadgeState(atis, networkIndex);
    const atisChip = document.createElement("span");
    atisChip.className = "atis-chip " + state.cls;
    atisChip.textContent = state.label;
    if (state.clickable) {
        atisChip.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openAtisPopup(entry.icao, atis, networkIndex);
        });
    }
    atisCol.appendChild(atisChip);
    badgeRow.appendChild(atisCol);

    const statusCol = document.createElement("div");
    statusCol.className = "status-col";
    const statusBadge = document.createElement("span");
    statusBadge.className = "badge " + (entry.isAuto ? "auto" : "manual");
    statusBadge.textContent = entry.isAuto ? t("panel.auto") : t("panel.manual");
    statusCol.appendChild(statusBadge);
    badgeRow.appendChild(statusCol);

    header.append(headerLeft, badgeRow);
    card.appendChild(header);

    if (atis && atis.success) {
        const chips = document.createElement("div");
        chips.className = "runway-chips";
        card.appendChild(chips);
        renderRunwayChips(chips, atis);
    }

    // SayIntentions-assigned gate chip. Accent when it's also pinned on the
    // map; amber "?" when SI named a gate the map couldn't locate (this chip
    // is then the only place it shows).
    if (gate && gate.label) {
        const gc = document.createElement("span");
        gc.className = "gate-chip" + (gate.resolved ? "" : " unresolved");
        gc.textContent = "GATE " + gate.label + (gate.showQuestion ? " ?" : "");
        card.appendChild(gc);
    }

    card.addEventListener("click", () => onSelectIcao(entry.icao));

    // Custom scenery <-> global apt.dat source toggle - only shown when this
    // ICAO genuinely exists in both (see WebServer.cpp's AirportEntryToJson).
    // CUSTOM/GLOBAL are left untranslated in every language, same as the
    // native panel (see Translations.h's SourceCustom/SourceGlobal comment)
    // - they're X-Plane's own folder names ("Custom Scenery"/"Global
    // Airports"), not ordinary UI text.
    //
    // Both buttons sit in a normal-flow row right after the runway chips
    // (or the header, if there aren't any) instead of being position:
    // absolute and pinned to the card's bottom-right corner - real-usage
    // feedback that pinning them to the corner left them looking stranded
    // below the runway chips instead of belonging with them, once the
    // native panel's equivalent fix (PanelAirports.cpp's kButtonRowTopOffset)
    // showed what "next to the ARR chips" should actually look like.
    if (entry.sourceChoice || deletable) {
        const actions = document.createElement("div");
        actions.className = "card-actions-row";

        // Global/Custom 2-segment control (#SG11) - both options always
        // visible, replacing the old single button whose label alternated
        // between the current and the "other" source (PanelAirports.cpp's
        // drawSegment mirrors this exactly, including reusing the same
        // accent-tinted-when-active look as every other segmented control
        // in this app rather than a special amber-for-override style).
        if (entry.sourceChoice) {
            const seg = document.createElement("div");
            seg.className = "source-toggle-seg";
            const makeSeg = (label, active) => {
                const btn = document.createElement("button");
                btn.className = "source-seg-btn" + (active ? " active" : "");
                btn.textContent = label;
                if (!active) {
                    btn.title = t("panel.sourceToggleTooltip", { source: label });
                    btn.addEventListener("click", (ev) => {
                        ev.stopPropagation();
                        onToggleSource(entry.icao);
                    });
                }
                return btn;
            };
            seg.append(makeSeg("GLOBAL", !!entry.usingGlobal), makeSeg("CUSTOM", !entry.usingGlobal));
            actions.appendChild(seg);
        }

        if (deletable) {
            const del = document.createElement("button");
            del.className = "delete-btn";
            del.textContent = "×";
            del.addEventListener("click", (ev) => {
                ev.stopPropagation();
                onDelete(entry.icao);
            });
            actions.appendChild(del);
        }

        card.appendChild(actions);
    }

    return card;
}

let atisModalIcao = null;

function openAtisPopup(icao, atis, networkIndex) {
    atisModalIcao = icao;
    const content = document.getElementById("atis-modal-content");
    renderAtisPopup(content, atis, networkIndex);
    document.getElementById("atis-modal").classList.remove("hidden");
}

export function initAirportsPanel({ onSelectIcao: selectCb, onToggleSource: toggleSourceCb }) {
    onSelectIcao = selectCb;
    onToggleSource = toggleSourceCb;

    document.getElementById("refresh-btn").addEventListener("click", async () => {
        refreshInFlight = true;
        updateRefreshButton();
        const res = await api.refreshSimbrief();
        if (!res.ok) {
            document.getElementById("fetch-error").textContent = res.body?.error || t("panel.refreshFailed");
        }
        refreshInFlight = false;
        updateRefreshButton();
    });
    window.addEventListener("sgm-langchange", updateRefreshButton);
    updateRefreshButton();

    document.getElementById("atis-modal").addEventListener("click", (ev) => {
        if (ev.target.id === "atis-modal") {
            document.getElementById("atis-modal").classList.add("hidden");
        }
    });

    // Add-airport modal
    const addModal = document.getElementById("add-airport-modal");
    const addInput = document.getElementById("add-airport-input");
    const addError = document.getElementById("add-airport-error");
    document.getElementById("add-airport-btn").addEventListener("click", () => {
        addInput.value = "";
        addError.textContent = "";
        addModal.classList.remove("hidden");
        addInput.focus();
    });
    document.getElementById("add-airport-cancel").addEventListener("click", () => {
        addModal.classList.add("hidden");
    });
    async function confirmAdd() {
        const icao = addInput.value.trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(icao)) {
            addError.textContent = t("panel.invalidIcaoFormat");
            return;
        }
        const res = await api.addManualAirport(icao);
        if (!res.ok) {
            addError.textContent = res.body?.error || t("panel.addAirportFailed");
            return;
        }
        addModal.classList.add("hidden");
    }
    document.getElementById("add-airport-confirm").addEventListener("click", confirmAdd);
    addInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") confirmAdd();
    });

    // Clear-list modal
    const clearModal = document.getElementById("clear-list-modal");
    document.getElementById("clear-list-btn").addEventListener("click", () => {
        clearModal.classList.remove("hidden");
    });
    document.getElementById("clear-list-cancel").addEventListener("click", () => {
        clearModal.classList.add("hidden");
    });
    document.getElementById("clear-list-confirm").addEventListener("click", async () => {
        clearModal.classList.add("hidden");
        await api.clearAirports();
    });
}

// Renders the whole panel from the latest /api/airports response + an
// icao->AtisResult|null map (null/undefined = not fetched yet, see atis.js).
// Signature of everything the panel renders from - lets the 1.5s poll skip
// the full innerHTML="" teardown + rebuild of all three card containers
// (a whole-panel layout each time) when nothing actually changed, which is
// the common case in cruise. JSON.stringify of a handful of small objects
// is far cheaper than the DOM rebuild it guards.
let lastPanelSig = null;
// Refresh button label/tooltip - mirrors PanelAirports.cpp's DrawStatusRow:
// "Reload SimBrief plan" with a SimBrief ID, "Use nearest airport" without
// one (the #SG10 fallback the server runs), "Loading SimBrief..." while a
// fetch is in flight.
let lastHasSimbriefId = true;
let lastFetchLoading = false; // server-side fetch in progress (could be started natively)
let refreshInFlight = false;  // this tab's own POST in progress
function updateRefreshButton() {
    const btn = document.getElementById("refresh-btn");
    const loading = refreshInFlight || lastFetchLoading;
    document.getElementById("refresh-label").textContent =
        t(loading ? "panel.refreshing" : lastHasSimbriefId ? "panel.refresh" : "panel.useNearestAirport");
    btn.title = t(lastHasSimbriefId ? "panel.refreshTitleSimbrief" : "panel.refreshTitleNearest");
    btn.disabled = loading;
}

export function renderAirportsPanel(flight, atisByIcao, networkIndex, selectedIcao) {
    document.getElementById("fetch-error").textContent = flight.fetchError || "";
    if (typeof flight.hasSimbriefId === "boolean") lastHasSimbriefId = flight.hasSimbriefId;
    lastFetchLoading = !!flight.fetchLoading;
    updateRefreshButton();

    const planIcaos = icaosInPlan(flight);
    const atisSlice = {};
    for (const ic of planIcaos) atisSlice[ic] = atisByIcao[ic] || null;
    const sig = JSON.stringify({
        lang: getLang(),
        fetchError: flight.fetchError || "",
        assignedGate: flight.assignedGate || null,
        networkIndex,
        selectedIcao,
        dep: flight.dep || null,
        dest: flight.dest || null,
        alternates: flight.alternates || [],
        atis: atisSlice,
    });
    const atisModal = document.getElementById("atis-modal");
    if (sig === lastPanelSig) {
        // Contents are unchanged, but still keep an open ATIS popup fresh.
        if (atisModalIcao && atisByIcao[atisModalIcao] && !atisModal.classList.contains("hidden")) {
            renderAtisPopup(document.getElementById("atis-modal-content"), atisByIcao[atisModalIcao], networkIndex);
        }
        return;
    }
    lastPanelSig = sig;

    // SayIntentions-assigned gate, tied to one airport (see WebServer.cpp).
    // The "?" is only added on that airport's own card when it's the one on
    // the map (amber elsewhere just means "open this airport to see it").
    const ag = flight.assignedGate;
    const gateFor = (icao) =>
        ag && ag.icao === icao
            ? { label: ag.label, resolved: ag.resolved, showQuestion: !ag.resolved && ag.icao === selectedIcao }
            : null;

    const depContainer = document.getElementById("dep-card");
    depContainer.innerHTML = "";
    depContainer.appendChild(
        flight.dep && flight.dep.icao
            ? makeCard(flight.dep, { selected: flight.dep.icao === selectedIcao, atis: atisByIcao[flight.dep.icao], networkIndex, deletable: false, gate: gateFor(flight.dep.icao) })
            : makeEmptyCard()
    );

    const destContainer = document.getElementById("dest-card");
    destContainer.innerHTML = "";
    destContainer.appendChild(
        flight.dest && flight.dest.icao
            ? makeCard(flight.dest, { selected: flight.dest.icao === selectedIcao, atis: atisByIcao[flight.dest.icao], networkIndex, deletable: false, gate: gateFor(flight.dest.icao) })
            : makeEmptyCard()
    );

    const altContainer = document.getElementById("alt-cards");
    altContainer.innerHTML = "";
    const alternates = flight.alternates || [];
    if (alternates.length === 0) {
        altContainer.appendChild(makeEmptyCard());
    } else {
        for (const alt of alternates) {
            altContainer.appendChild(
                makeCard(alt, {
                    selected: alt.icao === selectedIcao,
                    atis: atisByIcao[alt.icao],
                    networkIndex,
                    deletable: !alt.isAuto,
                    onDelete: (icao) => api.deleteManualAirport(icao),
                    gate: gateFor(alt.icao),
                })
            );
        }
    }

    // Keep an open ATIS popup's contents fresh as new fetches land.
    if (atisModalIcao && atisByIcao[atisModalIcao] && !document.getElementById("atis-modal").classList.contains("hidden")) {
        renderAtisPopup(document.getElementById("atis-modal-content"), atisByIcao[atisModalIcao], networkIndex);
    }
}

// Every ICAO currently shown in the flight plan - used by app.js to know
// which airports to poll GET /api/atis/{icao} for.
export function icaosInPlan(flight) {
    const out = [];
    if (flight.dep?.icao) out.push(flight.dep.icao);
    if (flight.dest?.icao) out.push(flight.dest.icao);
    for (const a of flight.alternates || []) {
        if (a.icao) out.push(a.icao);
    }
    return out;
}
