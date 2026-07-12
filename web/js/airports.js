// Airports list panel - DEP/DEST/ALT cards, add/delete/clear, ATIS badges -
// ported from PanelAirports.cpp's DrawAirportCard/DrawAtisBadge/
// DrawRunwayChipsAt. See NOTES.md (section 27).
import { api } from "./api.js";
import { atisBadgeState, renderAtisPopup, renderRunwayChips } from "./atis.js";
import { t } from "./i18n.js";

let onSelectIcao = () => {};

function makeEmptyCard() {
    const card = document.createElement("div");
    card.className = "airport-card empty";
    card.textContent = t("panel.noData");
    return card;
}

function makeCard(entry, { selected, atis, networkIndex, deletable, onDelete }) {
    const card = document.createElement("div");
    card.className = "airport-card" + (selected ? " selected" : "");

    const header = document.createElement("div");
    header.className = "header-row";
    const icao = document.createElement("span");
    icao.className = "icao mono";
    icao.textContent = entry.icao;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.name || t("panel.namePending");
    if (!entry.name) name.classList.add("dim");
    const badgeRow = document.createElement("div");
    badgeRow.className = "badge-row";

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
    badgeRow.appendChild(atisChip);

    const statusBadge = document.createElement("span");
    statusBadge.className = "badge " + (entry.isAuto ? "auto" : "manual");
    statusBadge.textContent = entry.isAuto ? t("panel.auto") : t("panel.manual");
    badgeRow.appendChild(statusBadge);

    header.append(icao, name, badgeRow);
    card.appendChild(header);

    if (atis && atis.success) {
        const chips = document.createElement("div");
        chips.className = "runway-chips";
        card.appendChild(chips);
        renderRunwayChips(chips, atis);
    }

    card.addEventListener("click", () => onSelectIcao(entry.icao));

    if (deletable) {
        const del = document.createElement("button");
        del.className = "delete-btn";
        del.textContent = "x";
        del.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onDelete(entry.icao);
        });
        card.appendChild(del);
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

export function initAirportsPanel({ onSelectIcao: selectCb }) {
    onSelectIcao = selectCb;

    document.getElementById("refresh-btn").addEventListener("click", async (ev) => {
        ev.target.disabled = true;
        const res = await api.refreshSimbrief();
        if (!res.ok) {
            document.getElementById("fetch-error").textContent = res.body?.error || t("panel.refreshFailed");
        }
        ev.target.disabled = false;
    });

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
export function renderAirportsPanel(flight, atisByIcao, networkIndex, selectedIcao) {
    document.getElementById("fetch-error").textContent = flight.fetchError || "";

    const depContainer = document.getElementById("dep-card");
    depContainer.innerHTML = "";
    depContainer.appendChild(
        flight.dep && flight.dep.icao
            ? makeCard(flight.dep, { selected: flight.dep.icao === selectedIcao, atis: atisByIcao[flight.dep.icao], networkIndex, deletable: false })
            : makeEmptyCard()
    );

    const destContainer = document.getElementById("dest-card");
    destContainer.innerHTML = "";
    destContainer.appendChild(
        flight.dest && flight.dest.icao
            ? makeCard(flight.dest, { selected: flight.dest.icao === selectedIcao, atis: atisByIcao[flight.dest.icao], networkIndex, deletable: false })
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
