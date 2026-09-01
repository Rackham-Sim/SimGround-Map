// ATIS presentation helpers - ported line-for-line from PanelAirports.cpp's
// JoinAtisCodes/SplitRunwayList/BuildRunwayUsage/DrawAtisBadge/
// DrawRunwayChipsAt/DrawAtisPopupContent so the web card/popup reads
// identically to the native ImGui one. See NOTES.md (section 27).
import { t } from "./i18n.js";

const NETWORK_NAMES = ["VATSIM", "IVAO", "SayIntentions AI"];

export function networkLabel(networkIndex) {
    return NETWORK_NAMES[networkIndex] ?? "?";
}

export function joinAtisCodes(atis) {
    return (atis.editions || [])
        .map((ed) => ed.atisCode)
        .filter((c) => c)
        .join("/");
}

function splitRunwayList(raw) {
    if (!raw) return [];
    const normalized = raw.replace(/\s+AND\s+/g, ",");
    return normalized
        .split(",")
        .map((s) => s.replace(/\s+/g, ""))
        .filter((s) => s.length > 0);
}

// One entry per distinct runway designator, flagged dep/arr - first-seen
// order (departure list first, then arrival), matching BuildRunwayUsage.
export function buildRunwayUsage(atis) {
    const out = [];
    const addAll = (list, isDep) => {
        for (const designator of splitRunwayList(list)) {
            let entry = out.find((u) => u.designator === designator);
            if (!entry) {
                entry = { designator, dep: false, arr: false };
                out.push(entry);
            }
            if (isDep) entry.dep = true;
            else entry.arr = true;
        }
    };
    addAll(atis.departureRunway, true);
    addAll(atis.arrivalRunway, false);
    return out;
}

// Renders the stacked DEP/box/ARR chip row (DrawRunwayChipsAt's web
// equivalent) into `container` (cleared first).
export function renderRunwayChips(container, atis) {
    container.innerHTML = "";
    const usage = buildRunwayUsage(atis);
    for (const u of usage) {
        const chip = document.createElement("div");
        chip.className = "runway-chip";

        const dep = document.createElement("div");
        dep.className = "tag dep" + (u.dep ? " show" : "");
        dep.textContent = "DEP";

        const box = document.createElement("div");
        box.className = "box";
        box.textContent = u.designator;

        const arr = document.createElement("div");
        arr.className = "tag arr" + (u.arr ? " show" : "");
        arr.textContent = "ARR";

        chip.append(dep, box, arr);
        container.appendChild(chip);
    }
    return usage.length > 0;
}

// ATIS chip badge state for an airport card - mirrors DrawAtisBadge exactly:
// atis === null means "not fetched yet" (native: atis pointer is nullptr).
export function atisBadgeState(atis, networkIndex) {
    if (!atis) {
        return { label: t("atis.loading"), cls: "dim", clickable: false };
    }
    if (!atis.success) {
        return { label: t("atis.error"), cls: "error", clickable: true };
    }
    if (!atis.available) {
        return { label: t("atis.noAtis", { network: networkLabel(networkIndex) }), cls: "dim", clickable: false };
    }
    const code = joinAtisCodes(atis);
    return { label: code ? t("atis.readyWithCode", { code }) : t("atis.readyPlain"), cls: "ready", clickable: true };
}

// Full popup content (DrawAtisPopupContent's web equivalent), appended to
// `container` (cleared first).
export function renderAtisPopup(container, atis, networkIndex) {
    container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "dim";
    header.textContent = `${atis.icao} - ${networkLabel(networkIndex)}`;
    container.appendChild(header);
    container.appendChild(document.createElement("hr"));

    if (!atis.success) {
        const err = document.createElement("div");
        err.style.color = "var(--red)";
        err.textContent = atis.errorMessage || t("modal.atisFetchFailed");
        container.appendChild(err);
        return;
    }

    // No runway-in-service chips here anymore (real-usage feedback: it
    // duplicated both the airport card's own chips and the runway mention
    // already in the ATIS text below) - see NOTES.md. Still shown on the
    // card (airports.js's own renderRunwayChips call) and drives the map's
    // DEP/ARR/closed indicators; only the popup's now-redundant copy was
    // removed.

    for (const ed of atis.editions || []) {
        if (ed.label || ed.atisCode) {
            const h = document.createElement("div");
            h.style.color = "var(--accent)";
            h.style.fontWeight = "700";
            h.style.marginTop = "8px";
            let text = ed.label || "";
            if (ed.atisCode) {
                text += (text ? " - " : "") + "Info " + ed.atisCode;
            }
            h.textContent = text;
            container.appendChild(h);
        }
        for (const line of ed.lines || []) {
            const p = document.createElement("div");
            p.style.whiteSpace = "pre-wrap";
            p.style.marginTop = "4px";
            p.textContent = line;
            container.appendChild(p);
        }
    }
}
