// Live GPS position via Server-Sent Events (/api/gps/stream) - EventSource
// is a native browser API (no library needed) that auto-reconnects on its
// own after a network hiccup, so this file only needs to forward events and
// surface connectivity for the titlebar indicator. See NOTES.md (section 26)
// for the exact event shape (pushed ~every 300ms).
import { api } from "./api.js";

export function initGpsStream(onUpdate, onConnectionChange) {
    let connected = false;
    const es = api.openGpsStream(
        (data) => {
            if (!connected) {
                connected = true;
                onConnectionChange(true);
            }
            onUpdate(data);
        },
        () => {
            connected = false;
            onConnectionChange(false);
        }
    );
    return es;
}
