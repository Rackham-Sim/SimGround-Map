// Web-frontend translations (EN default, FR/DE/IT/ES selectable from the
// Settings popover - see js/settings.js). Per-browser preference stored in
// localStorage, same pattern as app.js's list-collapsed state - this is a
// browser-side display preference, not something the shared /api/settings
// (and therefore the native ImGui panel) needs to know about. Aviation
// terms/abbreviations that pilots learn in English internationally (ATIS,
// ICAO/DEP/ARR, GS/HDG/LAT/LON, VATSIM/IVAO/SayIntentions AI) are left
// untranslated on purpose, matching real-world phraseology.
export const LANGUAGES = [
    { code: "en", name: "English" },
    { code: "fr", name: "Français" },
    { code: "de", name: "Deutsch" },
    { code: "it", name: "Italiano" },
    { code: "es", name: "Español" },
];

const DICTS = {
    en: {
        "common.connecting": "connecting...",
        "common.connected": "connected",
        "common.apiUnreachable": "API unreachable",
        "common.live": "live",
        "common.gpsDisconnected": "GPS stream disconnected",

        "titlebar.hideList": "Hide list",
        "titlebar.showList": "Show list",
        "titlebar.hideListTitle": "Hide the airport list",
        "titlebar.showListTitle": "Show the airport list",
        "titlebar.settingsTitle": "Settings",

        "panel.refresh": "Refresh",
        "panel.addAirport": "+ Add airport",
        "panel.clearList": "Clear list",
        "panel.noData": "No data",
        "panel.namePending": "Name pending",
        "panel.auto": "AUTO",
        "panel.manual": "MANUAL",
        "panel.refreshFailed": "Refresh failed",
        "panel.invalidIcaoFormat": "Invalid format (4 alphanumeric characters)",
        "panel.addAirportFailed": "Failed to add airport",

        "map.selectAirportPlaceholder": "Select an airport from the list to load its ground map.",
        "map.loadingAirportData": "Loading airport data...",
        "map.airportNotFound": "Airport not found in apt.dat.",
        "map.gpsLive": "GPS LIVE",
        "map.offAirport": "OFF AIRPORT",
        "map.noRouteBadge": "NO TAXI ROUTE DATA",
        "map.zoomReset": "Reset",
        "map.clearRoute": "Clear Route",
        "map.trackNorth": "Track",
        "map.trackNorthTitle": "Track aircraft (keep north up)",
        "map.trackHeading": "Track+Hdg",
        "map.trackHeadingTitle": "Track aircraft (rotate with heading up)",

        "modal.manualDiversion": "Manual diversion",
        "modal.icaoCodeLabel": "ICAO code (4 characters)",
        "modal.add": "Add",
        "modal.cancel": "Cancel",
        "modal.clearListConfirmTitle": "Clear the entire airport list?",
        "modal.clearListConfirmBody": "This removes DEP/DEST/ALT entries.",
        "modal.confirm": "Confirm",
        "modal.atisFetchFailed": "ATIS fetch failed.",

        "atis.loading": "ATIS...",
        "atis.error": "ATIS error",
        "atis.noAtis": "No ATIS ({network})",
        "atis.readyWithCode": "ATIS {code}",
        "atis.readyPlain": "ATIS",

        "settings.display": "Display",
        "settings.opacity": "Opacity",
        "settings.simbrief": "SimBrief",
        "settings.userId": "User ID",
        "settings.atisSection": "ATIS",
        "settings.network": "Network",
        "settings.apiKey": "API key",
        "settings.webInterface": "Web Interface",
        "settings.enabled": "Enabled",
        "settings.port": "Port",
        "settings.connectedVia": "Connected via {host}",
        "settings.close": "Close",
        "settings.language": "Language",

        "footer.supportKofi": "Support on Ko-fi",
        "footer.newVersionAvailable": "New version available",
    },
    fr: {
        "common.connecting": "connexion...",
        "common.connected": "connecté",
        "common.apiUnreachable": "API injoignable",
        "common.live": "en direct",
        "common.gpsDisconnected": "Flux GPS déconnecté",

        "titlebar.hideList": "Masquer la liste",
        "titlebar.showList": "Afficher la liste",
        "titlebar.hideListTitle": "Masquer la liste des aéroports",
        "titlebar.showListTitle": "Afficher la liste des aéroports",
        "titlebar.settingsTitle": "Paramètres",

        "panel.refresh": "Actualiser",
        "panel.addAirport": "+ Ajouter un aéroport",
        "panel.clearList": "Vider la liste",
        "panel.noData": "Aucune donnée",
        "panel.namePending": "Nom en attente",
        "panel.auto": "AUTO",
        "panel.manual": "MANUEL",
        "panel.refreshFailed": "Échec de l'actualisation",
        "panel.invalidIcaoFormat": "Format invalide (4 caractères alphanumériques)",
        "panel.addAirportFailed": "Échec de l'ajout de l'aéroport",

        "map.selectAirportPlaceholder": "Sélectionnez un aéroport dans la liste pour charger sa carte au sol.",
        "map.loadingAirportData": "Chargement des données de l'aéroport...",
        "map.airportNotFound": "Aéroport introuvable dans apt.dat.",
        "map.gpsLive": "GPS EN DIRECT",
        "map.offAirport": "HORS AÉROPORT",
        "map.noRouteBadge": "PAS DE DONNÉES DE ROULAGE",
        "map.zoomReset": "Réinit.",
        "map.clearRoute": "Effacer l'itinéraire",
        "map.trackNorth": "Suivre",
        "map.trackNorthTitle": "Suivre l'avion (nord en haut)",
        "map.trackHeading": "Suivre+Cap",
        "map.trackHeadingTitle": "Suivre l'avion (rotation selon le cap)",

        "modal.manualDiversion": "Déroutement manuel",
        "modal.icaoCodeLabel": "Code OACI (4 caractères)",
        "modal.add": "Ajouter",
        "modal.cancel": "Annuler",
        "modal.clearListConfirmTitle": "Vider toute la liste des aéroports ?",
        "modal.clearListConfirmBody": "Ceci supprime les entrées DEP/DEST/ALT.",
        "modal.confirm": "Confirmer",
        "modal.atisFetchFailed": "Échec de récupération de l'ATIS.",

        "atis.loading": "ATIS...",
        "atis.error": "Erreur ATIS",
        "atis.noAtis": "Pas d'ATIS ({network})",
        "atis.readyWithCode": "ATIS {code}",
        "atis.readyPlain": "ATIS",

        "settings.display": "Affichage",
        "settings.opacity": "Opacité",
        "settings.simbrief": "SimBrief",
        "settings.userId": "Identifiant utilisateur",
        "settings.atisSection": "ATIS",
        "settings.network": "Réseau",
        "settings.apiKey": "Clé API",
        "settings.webInterface": "Interface web",
        "settings.enabled": "Activée",
        "settings.port": "Port",
        "settings.connectedVia": "Connecté via {host}",
        "settings.close": "Fermer",
        "settings.language": "Langue",

        "footer.supportKofi": "Soutenir sur Ko-fi",
        "footer.newVersionAvailable": "Nouvelle version disponible",
    },
    de: {
        "common.connecting": "Verbindung wird hergestellt...",
        "common.connected": "verbunden",
        "common.apiUnreachable": "API nicht erreichbar",
        "common.live": "live",
        "common.gpsDisconnected": "GPS-Stream getrennt",

        "titlebar.hideList": "Liste ausblenden",
        "titlebar.showList": "Liste einblenden",
        "titlebar.hideListTitle": "Flughafenliste ausblenden",
        "titlebar.showListTitle": "Flughafenliste einblenden",
        "titlebar.settingsTitle": "Einstellungen",

        "panel.refresh": "Aktualisieren",
        "panel.addAirport": "+ Flughafen hinzufügen",
        "panel.clearList": "Liste leeren",
        "panel.noData": "Keine Daten",
        "panel.namePending": "Name folgt",
        "panel.auto": "AUTO",
        "panel.manual": "MANUELL",
        "panel.refreshFailed": "Aktualisierung fehlgeschlagen",
        "panel.invalidIcaoFormat": "Ungültiges Format (4 alphanumerische Zeichen)",
        "panel.addAirportFailed": "Flughafen konnte nicht hinzugefügt werden",

        "map.selectAirportPlaceholder": "Wählen Sie einen Flughafen aus der Liste, um seine Bodenkarte zu laden.",
        "map.loadingAirportData": "Flughafendaten werden geladen...",
        "map.airportNotFound": "Flughafen nicht in apt.dat gefunden.",
        "map.gpsLive": "GPS LIVE",
        "map.offAirport": "AUSSERHALB DES FLUGHAFENS",
        "map.noRouteBadge": "KEINE ROLLWEGDATEN",
        "map.zoomReset": "Zurücks.",
        "map.clearRoute": "Route löschen",
        "map.trackNorth": "Verfolgen",
        "map.trackNorthTitle": "Flugzeug verfolgen (Norden oben)",
        "map.trackHeading": "Verfolgen+Kurs",
        "map.trackHeadingTitle": "Flugzeug verfolgen (mit Kurs drehen)",

        "modal.manualDiversion": "Manuelle Ausweichlandung",
        "modal.icaoCodeLabel": "ICAO-Code (4 Zeichen)",
        "modal.add": "Hinzufügen",
        "modal.cancel": "Abbrechen",
        "modal.clearListConfirmTitle": "Gesamte Flughafenliste leeren?",
        "modal.clearListConfirmBody": "Dies entfernt die DEP-/DEST-/ALT-Einträge.",
        "modal.confirm": "Bestätigen",
        "modal.atisFetchFailed": "Abruf des ATIS fehlgeschlagen.",

        "atis.loading": "ATIS...",
        "atis.error": "ATIS-Fehler",
        "atis.noAtis": "Kein ATIS ({network})",
        "atis.readyWithCode": "ATIS {code}",
        "atis.readyPlain": "ATIS",

        "settings.display": "Anzeige",
        "settings.opacity": "Deckkraft",
        "settings.simbrief": "SimBrief",
        "settings.userId": "Benutzer-ID",
        "settings.atisSection": "ATIS",
        "settings.network": "Netzwerk",
        "settings.apiKey": "API-Schlüssel",
        "settings.webInterface": "Weboberfläche",
        "settings.enabled": "Aktiviert",
        "settings.port": "Port",
        "settings.connectedVia": "Verbunden über {host}",
        "settings.close": "Schließen",
        "settings.language": "Sprache",

        "footer.supportKofi": "Auf Ko-fi unterstützen",
        "footer.newVersionAvailable": "Neue Version verfügbar",
    },
    it: {
        "common.connecting": "connessione...",
        "common.connected": "connesso",
        "common.apiUnreachable": "API non raggiungibile",
        "common.live": "in diretta",
        "common.gpsDisconnected": "Flusso GPS disconnesso",

        "titlebar.hideList": "Nascondi elenco",
        "titlebar.showList": "Mostra elenco",
        "titlebar.hideListTitle": "Nascondi l'elenco degli aeroporti",
        "titlebar.showListTitle": "Mostra l'elenco degli aeroporti",
        "titlebar.settingsTitle": "Impostazioni",

        "panel.refresh": "Aggiorna",
        "panel.addAirport": "+ Aggiungi aeroporto",
        "panel.clearList": "Svuota elenco",
        "panel.noData": "Nessun dato",
        "panel.namePending": "Nome in attesa",
        "panel.auto": "AUTO",
        "panel.manual": "MANUALE",
        "panel.refreshFailed": "Aggiornamento non riuscito",
        "panel.invalidIcaoFormat": "Formato non valido (4 caratteri alfanumerici)",
        "panel.addAirportFailed": "Impossibile aggiungere l'aeroporto",

        "map.selectAirportPlaceholder": "Seleziona un aeroporto dall'elenco per caricarne la mappa a terra.",
        "map.loadingAirportData": "Caricamento dati aeroporto...",
        "map.airportNotFound": "Aeroporto non trovato in apt.dat.",
        "map.gpsLive": "GPS IN DIRETTA",
        "map.offAirport": "FUORI AEROPORTO",
        "map.noRouteBadge": "NESSUN DATO DI RULLAGGIO",
        "map.zoomReset": "Reimp.",
        "map.clearRoute": "Cancella percorso",
        "map.trackNorth": "Segui",
        "map.trackNorthTitle": "Segui l'aereo (nord in alto)",
        "map.trackHeading": "Segui+Rotta",
        "map.trackHeadingTitle": "Segui l'aereo (ruota secondo la rotta)",

        "modal.manualDiversion": "Dirottamento manuale",
        "modal.icaoCodeLabel": "Codice ICAO (4 caratteri)",
        "modal.add": "Aggiungi",
        "modal.cancel": "Annulla",
        "modal.clearListConfirmTitle": "Svuotare l'intero elenco degli aeroporti?",
        "modal.clearListConfirmBody": "Questo rimuove le voci DEP/DEST/ALT.",
        "modal.confirm": "Conferma",
        "modal.atisFetchFailed": "Recupero dell'ATIS non riuscito.",

        "atis.loading": "ATIS...",
        "atis.error": "Errore ATIS",
        "atis.noAtis": "Nessun ATIS ({network})",
        "atis.readyWithCode": "ATIS {code}",
        "atis.readyPlain": "ATIS",

        "settings.display": "Visualizzazione",
        "settings.opacity": "Opacità",
        "settings.simbrief": "SimBrief",
        "settings.userId": "ID utente",
        "settings.atisSection": "ATIS",
        "settings.network": "Rete",
        "settings.apiKey": "Chiave API",
        "settings.webInterface": "Interfaccia web",
        "settings.enabled": "Abilitata",
        "settings.port": "Porta",
        "settings.connectedVia": "Connesso tramite {host}",
        "settings.close": "Chiudi",
        "settings.language": "Lingua",

        "footer.supportKofi": "Sostieni su Ko-fi",
        "footer.newVersionAvailable": "Nuova versione disponibile",
    },
    es: {
        "common.connecting": "conectando...",
        "common.connected": "conectado",
        "common.apiUnreachable": "API inaccesible",
        "common.live": "en directo",
        "common.gpsDisconnected": "Flujo GPS desconectado",

        "titlebar.hideList": "Ocultar lista",
        "titlebar.showList": "Mostrar lista",
        "titlebar.hideListTitle": "Ocultar la lista de aeropuertos",
        "titlebar.showListTitle": "Mostrar la lista de aeropuertos",
        "titlebar.settingsTitle": "Ajustes",

        "panel.refresh": "Actualizar",
        "panel.addAirport": "+ Añadir aeropuerto",
        "panel.clearList": "Vaciar lista",
        "panel.noData": "Sin datos",
        "panel.namePending": "Nombre pendiente",
        "panel.auto": "AUTO",
        "panel.manual": "MANUAL",
        "panel.refreshFailed": "Error al actualizar",
        "panel.invalidIcaoFormat": "Formato no válido (4 caracteres alfanuméricos)",
        "panel.addAirportFailed": "No se pudo añadir el aeropuerto",

        "map.selectAirportPlaceholder": "Seleccione un aeropuerto de la lista para cargar su mapa de tierra.",
        "map.loadingAirportData": "Cargando datos del aeropuerto...",
        "map.airportNotFound": "Aeropuerto no encontrado en apt.dat.",
        "map.gpsLive": "GPS EN DIRECTO",
        "map.offAirport": "FUERA DEL AEROPUERTO",
        "map.noRouteBadge": "SIN DATOS DE RODAJE",
        "map.zoomReset": "Restabl.",
        "map.clearRoute": "Borrar ruta",
        "map.trackNorth": "Seguir",
        "map.trackNorthTitle": "Seguir al avión (norte arriba)",
        "map.trackHeading": "Seguir+Rumbo",
        "map.trackHeadingTitle": "Seguir al avión (girar según el rumbo)",

        "modal.manualDiversion": "Desvío manual",
        "modal.icaoCodeLabel": "Código OACI (4 caracteres)",
        "modal.add": "Añadir",
        "modal.cancel": "Cancelar",
        "modal.clearListConfirmTitle": "¿Vaciar toda la lista de aeropuertos?",
        "modal.clearListConfirmBody": "Esto elimina las entradas DEP/DEST/ALT.",
        "modal.confirm": "Confirmar",
        "modal.atisFetchFailed": "Error al obtener el ATIS.",

        "atis.loading": "ATIS...",
        "atis.error": "Error de ATIS",
        "atis.noAtis": "Sin ATIS ({network})",
        "atis.readyWithCode": "ATIS {code}",
        "atis.readyPlain": "ATIS",

        "settings.display": "Pantalla",
        "settings.opacity": "Opacidad",
        "settings.simbrief": "SimBrief",
        "settings.userId": "ID de usuario",
        "settings.atisSection": "ATIS",
        "settings.network": "Red",
        "settings.apiKey": "Clave API",
        "settings.webInterface": "Interfaz web",
        "settings.enabled": "Habilitada",
        "settings.port": "Puerto",
        "settings.connectedVia": "Conectado vía {host}",
        "settings.close": "Cerrar",
        "settings.language": "Idioma",

        "footer.supportKofi": "Apoyar en Ko-fi",
        "footer.newVersionAvailable": "Nueva versión disponible",
    },
};

const LANG_KEY = "sgm-lang";
let currentLang = localStorage.getItem(LANG_KEY) || "en";
if (!DICTS[currentLang]) currentLang = "en";

export function getLang() {
    return currentLang;
}

export function t(key, vars) {
    let s = (DICTS[currentLang] && DICTS[currentLang][key]) ?? DICTS.en[key] ?? key;
    if (vars) {
        for (const k of Object.keys(vars)) {
            s = s.replace(`{${k}}`, vars[k]);
        }
    }
    return s;
}

// Applies every static [data-i18n]/[data-i18n-title] element in the current
// document - covers everything that isn't rebuilt by JS on every poll tick
// (headings, button labels, modal copy). JS-generated content (airport
// cards, ATIS badges, map header/status) calls t() directly instead, and
// naturally picks up the new language on its own next render/poll.
export function applyStaticTranslations() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.title = t(el.getAttribute("data-i18n-title"));
    });
    document.documentElement.lang = currentLang;
}

export function setLang(lang) {
    if (!DICTS[lang] || lang === currentLang) return;
    currentLang = lang;
    localStorage.setItem(LANG_KEY, lang);
    applyStaticTranslations();
    window.dispatchEvent(new Event("sgm-langchange"));
}

export function initI18n() {
    applyStaticTranslations();
}
