// Events Module - Simple event bus for decoupled communication
const Events = (function() {
    const listeners = {};
    const MAX_LISTENERS_PER_EVENT = 10;  // Warn if exceeded (likely a leak)

    // Subscribe to an event
    const on = (event, callback) => {
        if (!listeners[event]) {
            listeners[event] = [];
        }
        listeners[event].push(callback);

        // Warn on potential listener leak (e.g. forgetting to unsubscribe on reconnect)
        if (listeners[event].length > MAX_LISTENERS_PER_EVENT) {
            console.warn("[events] possible listener leak: " + event + " has " + listeners[event].length + " listeners (max expected " + MAX_LISTENERS_PER_EVENT + ")");
        }

        // Return unsubscribe function
        return () => {
            if (listeners[event]) {
                listeners[event] = listeners[event].filter(cb => cb !== callback);
            }
        };
    };

    // Emit an event with optional data
    const emit = (event, data) => {
        if (listeners[event]) {
            listeners[event].forEach(callback => {
                try {
                    callback(data);
                } catch (e) {
                    console.error("[events] Error in " + event + " listener:", e.message || e);
                }
            });
        }
    };

    // Remove all listeners for an event (or all events if no event specified)
    const off = (event) => {
        if (event) {
            delete listeners[event];
        } else {
            Object.keys(listeners).forEach(key => delete listeners[key]);
        }
    };

    // Event names as constants to avoid typos
    const EVENTS = {
        // Connection events
        CONNECTION_REQUESTED: 'connection:requested',
        CONNECTION_ESTABLISHED: 'connection:established',
        CONNECTION_LOST: 'connection:lost',
        CONNECTION_FAILED: 'connection:failed',
        RECONNECT_SCHEDULED: 'connection:reconnect-scheduled',
        DISCONNECTED: 'connection:disconnected',

        // Speech recognition events
        LISTENING_STARTED: 'speech:listening-started',
        LISTENING_STOPPED: 'speech:listening-stopped',
        LISTENING_ERROR: 'speech:listening-error',
        TRANSCRIPT_UPDATE: 'speech:transcript-update',
        USER_SPEECH_FINAL: 'speech:user-final',
        USER_INTERRUPTED: 'speech:user-interrupted',

        // Assistant events
        ASSISTANT_SPEAKING_STARTED: 'assistant:speaking-started',
        ASSISTANT_SPEAKING_STOPPED: 'assistant:speaking-stopped',
        ASSISTANT_RESPONSE: 'assistant:response',

        // TTS events
        TTS_STARTED: 'tts:started',
        TTS_ENDED: 'tts:ended',
        TTS_ERROR: 'tts:error',

        // State changes
        STATE_CHANGED: 'state:changed',

        // Noise monitoring
        NOISE_CALIBRATED: 'noise:calibrated',

        // Errors
        ERROR: 'error',
    };

    return {
        on,
        emit,
        off,
        EVENTS
    };
})();
