// Settings popover - accent/opacity, SimBrief user ID, ATIS network/key,
// web interface enable/port. Mirrors Window.cpp's DrawSettingsButton popover
// field-for-field (theme::kAccentPalette for swatches, the same
// VATSIM/IVAO/SayIntentions AI network list). See NOTES.md (section 27)
// for why this panel shows "connected via <host>" instead of the native
// panel's detected-local-IP list (that feature exists so someone standing at
// the X-Plane PC can find a URL to open elsewhere - a browser already on
// this page has no use for it, it's already using a working URL).
import { api } from "./api.js";
import { LANGUAGES, getLang, setLang, t } from "./i18n.js";

// theme::kAccentPalette, src/ui/Theme.h - kept in the same order so swatch
// position matches the native popover.
const ACCENT_SWATCHES = [
    { name: "Cyan", hex: "#00e5ff" },
    { name: "Amber", hex: "#ffb300" },
    { name: "Green", hex: "#00e676" },
    { name: "Orange", hex: "#ff6d00" },
    { name: "Violet", hex: "#d500f9" },
    { name: "White", hex: "#ffffff" },
];

function hexToRgbFloat(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function rgbFloatToHex(r, g, b) {
    const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
}

// Sets the two CSS custom properties every panel/card/modal background reads
// (rgba(var(--panel-rgb), var(--opacity)) in style.css) - mirrors
// Theme::Apply's WindowBg/ChildBg alpha without making the whole page
// transparent (a browser tab has no desktop behind it to reveal, unlike the
// in-sim overlay window this setting was designed for).
export function applyAccentAndOpacity(settings) {
    const hex = rgbFloatToHex(settings.accentR, settings.accentG, settings.accentB);
    document.documentElement.style.setProperty("--accent", hex);
    document.documentElement.style.setProperty("--opacity", settings.opacity);
}

export function initSettingsPanel({ onSettingsChanged }) {
    const modal = document.getElementById("settings-modal");
    const swatchRow = document.getElementById("accent-swatches");
    let current = null;

    for (const swatch of ACCENT_SWATCHES) {
        const btn = document.createElement("button");
        btn.className = "swatch";
        btn.style.background = swatch.hex;
        btn.title = swatch.name;
        btn.addEventListener("click", async () => {
            const rgb = hexToRgbFloat(swatch.hex);
            await api.postSettings({ accentR: rgb.r, accentG: rgb.g, accentB: rgb.b });
            highlightSwatch(swatch.hex);
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

    const opacitySlider = document.getElementById("opacity-slider");
    const opacityVal = document.getElementById("opacity-val");
    opacitySlider.addEventListener("input", () => {
        opacityVal.textContent = Number(opacitySlider.value).toFixed(2);
        document.documentElement.style.setProperty("--opacity", opacitySlider.value);
    });
    opacitySlider.addEventListener("change", () => {
        api.postSettings({ opacity: Number(opacitySlider.value) });
    });

    const userIdInput = document.getElementById("simbrief-userid");
    userIdInput.addEventListener("change", () => {
        api.postSettings({ simbriefUserId: userIdInput.value.trim() });
    });

    const networkSelect = document.getElementById("atis-network");
    const sayIntentionsRow = document.getElementById("sayintentions-row");
    networkSelect.addEventListener("change", () => {
        const idx = Number(networkSelect.value);
        api.postSettings({ atisNetwork: idx });
        sayIntentionsRow.style.display = idx === 2 ? "flex" : "none";
    });

    const apiKeyInput = document.getElementById("sayintentions-key");
    apiKeyInput.addEventListener("change", () => {
        api.postSettings({ sayIntentionsApiKey: apiKeyInput.value });
    });

    const webEnabled = document.getElementById("web-enabled");
    webEnabled.addEventListener("change", () => {
        api.postSettings({ webInterfaceEnabled: webEnabled.checked });
    });

    const webPort = document.getElementById("web-port");
    webPort.addEventListener("change", () => {
        const port = Number(webPort.value);
        if (port >= 1 && port <= 65535) {
            api.postSettings({ webInterfacePort: port });
        }
    });

    function renderDetectedIps() {
        document.getElementById("detected-ips").innerHTML =
            t("settings.connectedVia", { host: "" }).replace(/\s*$/, "") +
            ` <span class="mono">${location.protocol}//${location.host}</span>`;
    }
    renderDetectedIps();
    window.addEventListener("sgm-langchange", renderDetectedIps);

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
        opacitySlider.value = settings.opacity;
        opacityVal.textContent = Number(settings.opacity).toFixed(2);
        highlightSwatch(rgbFloatToHex(settings.accentR, settings.accentG, settings.accentB));
        userIdInput.value = settings.simbriefUserId || "";
        networkSelect.value = String(settings.atisNetwork);
        sayIntentionsRow.style.display = settings.atisNetwork === 2 ? "flex" : "none";
        apiKeyInput.value = settings.sayIntentionsApiKey || "";
        webEnabled.checked = !!settings.webInterfaceEnabled;
        webPort.value = settings.webInterfacePort;
        applyAccentAndOpacity(settings);
        onSettingsChanged(settings);
    }

    return { populate };
}
