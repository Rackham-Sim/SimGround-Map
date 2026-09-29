// Settings popover - accent, SimBrief user ID, ATIS network/key. Mirrors
// Window.cpp's DrawSettingsButton popover field-for-field (theme::
// kAccentPalette for swatches, the same VATSIM/IVAO/SayIntentions AI network
// list) MINUS the fields that make no sense from inside a browser tab (#SG04):
// opacity (nothing behind a browser tab to reveal), and the web-interface
// enable/port controls themselves (changing the port of the very server
// serving this page from this page risks cutting your own connection, and
// disabling it would too - both stay native-only, set from the X-Plane PC).
import { api } from "./api.js";
import { LANGUAGES, getLang, setLang, t } from "./i18n.js";
import { getUiScale, setUiScale, UI_SCALE_PRESETS } from "./uiscale.js";

// theme::kAccentPalette, src/ui/Theme.h - kept in the same order so swatch
// position matches the native popover. White is deliberately absent (see
// Theme.h's kWhite comment: it reads as a plain highlight/selection color on
// the ground map, not a usable accent) - was still offered here (#SG05)
// after being removed natively.
const ACCENT_SWATCHES = [
    { name: "Cyan", hex: "#00e5ff" },
    { name: "Amber", hex: "#ffb300" },
    { name: "Green", hex: "#00e676" },
    { name: "Orange", hex: "#ff6d00" },
    { name: "Violet", hex: "#d500f9" },
];

function hexToRgbFloat(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function rgbFloatToHex(r, g, b) {
    const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
}

// Text color for something drawn on a solid `hex` fill - mirrors
// theme::TextOn (Theme.cpp): white (--text-bright) while it keeps WCAG
// contrast >= 3:1 against the fill, anthracite otherwise. Real-usage
// report: white on a selected green/cyan/amber segment read poorly.
function relativeLuminance(hex) {
    const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
export function textOn(hex) {
    const TEXT_BRIGHT = "#eef2ff", TEXT_ON_LIGHT = "#12161c";
    const lb = relativeLuminance(hex), lw = relativeLuminance(TEXT_BRIGHT);
    const contrast = (Math.max(lb, lw) + 0.05) / (Math.min(lb, lw) + 0.05);
    return contrast >= 3 ? TEXT_BRIGHT : TEXT_ON_LIGHT;
}

// Sets the --accent CSS custom property every panel/card/modal reads.
// Opacity is deliberately NOT ported here (#SG04) - style.css's --opacity
// default (1, fully opaque) is left untouched, so panel/card backgrounds
// stay solid regardless of the native panel's own opacity setting: a
// browser tab has no desktop behind it to reveal, unlike the in-sim overlay
// window that setting was designed for.
export function applyAccent(settings) {
    const hex = rgbFloatToHex(settings.accentR, settings.accentG, settings.accentB);
    document.documentElement.style.setProperty("--accent", hex);
    document.documentElement.style.setProperty("--on-accent", textOn(hex));
    // Let the map canvas refresh its cached CSS custom properties instead of
    // re-reading them via getComputedStyle() every render frame.
    window.dispatchEvent(new CustomEvent("sgm-cssvars-changed"));
}

export function initSettingsPanel({ onSettingsChanged }) {
    const modal = document.getElementById("settings-modal");
    const swatchRow = document.getElementById("accent-swatches");
    let current = null;

    for (const swatch of ACCENT_SWATCHES) {
        const btn = document.createElement("button");
        btn.className = "swatch";
        btn.style.background = swatch.hex;
        btn.style.setProperty("--check-color", textOn(swatch.hex));
        btn.title = swatch.name;
        btn.addEventListener("click", async () => {
            const rgb = hexToRgbFloat(swatch.hex);
            // Apply locally right away (#SG08 - previously only took effect
            // after closing and reopening the settings popover, since
            // applyAccent was only ever called from populate() on open).
            // The native panel doesn't need this: it re-applies its own
            // theme from gSettings every frame, so a change is visible
            // instantly there without an explicit call.
            applyAccent({ accentR: rgb.r, accentG: rgb.g, accentB: rgb.b });
            highlightSwatch(swatch.hex);
            await api.postSettings({ accentR: rgb.r, accentG: rgb.g, accentB: rgb.b });
        });
        swatchRow.appendChild(btn);
    }

    function highlightSwatch(hex) {
        [...swatchRow.children].forEach((el, i) => {
            el.classList.toggle("selected", ACCENT_SWATCHES[i].hex === hex);
        });
    }

    const languageSelect = document.getElementById("language-select");
    for (const lang of LANGUAGES) {
        const opt = document.createElement("option");
        opt.value = lang.code;
        opt.textContent = lang.name;
        languageSelect.appendChild(opt);
    }
    languageSelect.value = getLang();
    languageSelect.addEventListener("change", () => setLang(languageSelect.value));

    const showTraffic = document.getElementById("show-traffic");
    showTraffic.addEventListener("change", () => {
        api.postSettings({ showGroundTraffic: showTraffic.checked });
    });

    // Taxi guidance ribbon. The HUD is a native-only sim overlay - its
    // settings live in the in-sim panel, not here.
    const guidanceToggle = document.getElementById("taxi-guidance");
    const guidanceUnits = document.getElementById("guidance-units");
    const guidanceUnitsRow = document.getElementById("guidance-units-row");
    const setGuidanceRows = () => {
        guidanceUnitsRow.style.display = guidanceToggle.checked ? "flex" : "none";
    };
    guidanceToggle.addEventListener("change", () => {
        api.postSettings({ showTaxiGuidance: guidanceToggle.checked });
        setGuidanceRows();
    });
    guidanceUnits.addEventListener("change", () => {
        api.postSettings({ taxiGuidanceUnitsFeet: Number(guidanceUnits.value) });
    });

    // Per-browser, not sent to /api/settings - see js/uiscale.js. Fixed
    // preset buttons rather than a slider: a slider re-ran the `zoom`
    // reflow on every drag tick and the whole window jumped around under
    // the cursor. Mirrors the native panel's preset buttons.
    const uiScaleBtns = document.getElementById("ui-scale-buttons");
    const fmtScale = (v) => (v === 1 ? "1x" : String(v).replace(/\.0$/, "") + "x");
    function highlightScale() {
        const cur = getUiScale();
        [...uiScaleBtns.children].forEach((b) => {
            b.classList.toggle("selected", Math.abs(Number(b.dataset.scale) - cur) < 0.001);
        });
    }
    for (const preset of UI_SCALE_PRESETS) {
        const b = document.createElement("button");
        b.className = "scale-btn";
        b.dataset.scale = String(preset);
        b.textContent = fmtScale(preset);
        b.addEventListener("click", () => { setUiScale(preset); highlightScale(); });
        uiScaleBtns.appendChild(b);
    }
    highlightScale();

    const userIdInput = document.getElementById("simbrief-userid");
    userIdInput.addEventListener("change", () => {
        api.postSettings({ simbriefUserId: userIdInput.value.trim() });
    });

    const networkSelect = document.getElementById("atis-network");
    const sayIntentionsRow = document.getElementById("sayintentions-row");
    const sayIntentionsGateRow = document.getElementById("sayintentions-gate-row");
    const sayIntentionsTaxiRow = document.getElementById("sayintentions-taxi-row");
    const setSayIntentionsRows = (idx) => {
        const shown = idx === 2 ? "flex" : "none";
        sayIntentionsRow.style.display = shown;
        sayIntentionsGateRow.style.display = shown;
        sayIntentionsTaxiRow.style.display = shown;
    };
    networkSelect.addEventListener("change", () => {
        const idx = Number(networkSelect.value);
        api.postSettings({ atisNetwork: idx });
        setSayIntentionsRows(idx);
    });

    const apiKeyInput = document.getElementById("sayintentions-key");
    // Reveal/hide eye next to the key (mirrors Window.cpp's hand-drawn eye):
    // slashed while masked. Local only, never persisted.
    const apiKeyEye = document.getElementById("sayintentions-key-eye");
    apiKeyEye.addEventListener("click", () => {
        const reveal = apiKeyInput.type === "password";
        apiKeyInput.type = reveal ? "text" : "password";
        apiKeyEye.setAttribute("aria-pressed", String(reveal));
        apiKeyEye.title = t(reveal ? "settings.hideApiKey" : "settings.showApiKey");
    });
    apiKeyInput.addEventListener("change", () => {
        api.postSettings({ sayIntentionsApiKey: apiKeyInput.value });
    });

    const siGateInput = document.getElementById("sayintentions-gate");
    siGateInput.addEventListener("change", () => {
        api.postSettings({ showSayIntentionsGate: siGateInput.checked });
    });

    const siTaxiInput = document.getElementById("sayintentions-taxi");
    siTaxiInput.addEventListener("change", () => {
        api.postSettings({ showSayIntentionsTaxiRoute: siTaxiInput.checked });
    });

    document.getElementById("gear-btn").addEventListener("click", async () => {
        const res = await api.getSettings();
        if (res.ok) {
            populate(res.body);
        }
        modal.classList.remove("hidden");
    });
    document.getElementById("settings-close").addEventListener("click", () => {
        modal.classList.add("hidden");
    });
    modal.addEventListener("click", (ev) => {
        if (ev.target === modal) modal.classList.add("hidden");
    });

    function populate(settings) {
        current = settings;
        highlightScale();
        highlightSwatch(rgbFloatToHex(settings.accentR, settings.accentG, settings.accentB));
        userIdInput.value = settings.simbriefUserId || "";
        networkSelect.value = String(settings.atisNetwork);
        setSayIntentionsRows(settings.atisNetwork);
        apiKeyInput.value = settings.sayIntentionsApiKey || "";
        siGateInput.checked = settings.showSayIntentionsGate !== false;
        siTaxiInput.checked = settings.showSayIntentionsTaxiRoute !== false;
        showTraffic.checked = !!settings.showGroundTraffic;
        guidanceToggle.checked = settings.showTaxiGuidance !== false;
        guidanceUnits.value = String(settings.taxiGuidanceUnitsFeet || 0);
        setGuidanceRows();
        applyAccent(settings);
        onSettingsChanged(settings);
    }

    return { populate };
}
