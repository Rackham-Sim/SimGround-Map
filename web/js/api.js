// REST/SSE client for the plugin's embedded HTTP API - see
// NOTES.md (section 26) for the exact route list and JSON shapes this file
// is written against. All calls are same-origin (this page is served by the
// same httplib server that exposes /api/...), so no base URL/CORS handling
// is needed even though the server also sends permissive CORS headers.

async function req(method, path, body) {
    const opts = { method };
    if (body !== undefined) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let json = null;
    try {
        json = await res.json();
    } catch {
        // Empty body on some responses is fine - callers only look at .ok.
    }
    return { ok: res.ok, status: res.status, body: json };
}

export const api = {
    getAirports: () => req("GET", "/api/airports"),
    refreshSimbrief: () => req("POST", "/api/airports/refresh"),
    addManualAirport: (icao) => req("POST", "/api/airports/manual", { icao }),
    deleteManualAirport: (icao) => req("DELETE", `/api/airports/manual/${icao}`),
    clearAirports: () => req("POST", "/api/airports/clear"),

    getAirportMap: (icao) => req("GET", `/api/airport/${icao}/map`),
    getTaxiNetwork: (icao) => req("GET", `/api/airport/${icao}/taxi-network`),
    getTaxiRoute: (icao) => req("GET", `/api/airport/${icao}/taxi-route`),
    clickTaxiRouteEdge: (icao, edgeIndex) => req("POST", `/api/airport/${icao}/taxi-route`, { edgeIndex }),
    clearTaxiRoute: (icao) => req("POST", `/api/airport/${icao}/taxi-route`, { clear: true }),

    getAtis: (icao) => req("GET", `/api/atis/${icao}`),

    getSettings: () => req("GET", "/api/settings"),
    postSettings: (fields) => req("POST", "/api/settings", fields),

    // GPS stream - EventSource manages its own reconnect; caller supplies
    // onMessage(data) and onError(). Returns the EventSource so the caller
    // can .close() it if ever needed (not currently done - one stream lives
    // for the page's lifetime).
    openGpsStream(onMessage, onError) {
        const es = new EventSource("/api/gps/stream");
        es.onmessage = (ev) => {
            try {
                onMessage(JSON.parse(ev.data));
            } catch {
                // malformed event - skip, next one will arrive in ~300ms
            }
        };
        es.onerror = () => onError && onError();
        return es;
    },
};
