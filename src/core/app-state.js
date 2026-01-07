// AppState Module - Centralized state machine for the application
const AppState = (function() {
    // Possible states
    const STATES = {
        IDLE: 'idle',
        CONNECTING: 'connecting',
        CONNECTED: 'connected',
        LISTENING: 'listening',
        PROCESSING: 'processing',
        SPEAKING: 'speaking',
        RECONNECTING: 'reconnecting',
        ERROR: 'error'
    };

    // Valid state transitions
    // Note: Transitions are intentionally permissive for kiosk reliability
    // It's better to allow a transition and recover than to block and get stuck
    const TRANSITIONS = {
        [STATES.IDLE]: [STATES.CONNECTING],
        [STATES.CONNECTING]: [STATES.CONNECTED, STATES.ERROR, STATES.RECONNECTING, STATES.IDLE],
        [STATES.CONNECTED]: [STATES.LISTENING, STATES.IDLE, STATES.RECONNECTING, STATES.ERROR, STATES.CONNECTING],
        [STATES.LISTENING]: [STATES.PROCESSING, STATES.SPEAKING, STATES.CONNECTED, STATES.IDLE, STATES.RECONNECTING, STATES.ERROR],
        [STATES.PROCESSING]: [STATES.SPEAKING, STATES.LISTENING, STATES.CONNECTED, STATES.IDLE, STATES.RECONNECTING, STATES.ERROR],
        [STATES.SPEAKING]: [STATES.LISTENING, STATES.CONNECTED, STATES.IDLE, STATES.RECONNECTING, STATES.ERROR],
        [STATES.RECONNECTING]: [STATES.CONNECTING, STATES.CONNECTED, STATES.IDLE, STATES.ERROR],
        [STATES.ERROR]: [STATES.IDLE, STATES.CONNECTING, STATES.RECONNECTING]
    };

    let currentState = STATES.IDLE;
    let previousState = null;

    // Flags for sub-states (these persist across some state changes)
    let flags = {
        shouldBeConnected: false,      // User wants to maintain connection
        shouldBeListening: false,      // User wants speech recognition active
        assistantSpeaking: false,      // Assistant is currently speaking
        recognitionActive: false,      // Speech recognition is currently running
    };

    // Attempt to transition to a new state
    const transition = (newState, reason) => {
        if (currentState === newState) {
            return true; // Already in this state
        }

        const allowedTransitions = TRANSITIONS[currentState] || [];
        if (!allowedTransitions.includes(newState)) {
            console.warn("[state] Invalid transition from " + currentState + " to " + newState);
            UI.log("[state] blocked: " + currentState + " -> " + newState);
            return false;
        }

        previousState = currentState;
        currentState = newState;

        UI.log("[state] " + previousState + " -> " + currentState + (reason ? " (" + reason + ")" : ""));

        // Emit state change event
        Events.emit(Events.EVENTS.STATE_CHANGED, {
            from: previousState,
            to: currentState,
            reason: reason
        });

        return true;
    };

    // Force a state (bypass transition rules - use sparingly, mainly for recovery)
    const forceState = (newState, reason) => {
        previousState = currentState;
        currentState = newState;
        UI.log("[state] FORCED: " + previousState + " -> " + currentState + (reason ? " (" + reason + ")" : ""));
        Events.emit(Events.EVENTS.STATE_CHANGED, {
            from: previousState,
            to: currentState,
            reason: reason,
            forced: true
        });
    };

    // Getters
    const getState = () => currentState;
    const getPreviousState = () => previousState;
    const is = (state) => currentState === state;
    const isOneOf = (...states) => states.includes(currentState);

    // Flag management
    const setFlag = (flag, value) => {
        if (flags.hasOwnProperty(flag)) {
            const oldValue = flags[flag];
            flags[flag] = value;
            if (oldValue !== value) {
                UI.log("[state] flag " + flag + ": " + oldValue + " -> " + value);
            }
        }
    };

    const getFlag = (flag) => flags[flag];

    // Convenience methods for common checks
    const isConnected = () => isOneOf(STATES.CONNECTED, STATES.LISTENING, STATES.PROCESSING, STATES.SPEAKING);
    const canListen = () => isOneOf(STATES.CONNECTED, STATES.LISTENING) && !flags.assistantSpeaking;
    const canSendMessage = () => isConnected() && !flags.assistantSpeaking;

    // Debug: get full state snapshot
    const getSnapshot = () => ({
        state: currentState,
        previousState: previousState,
        flags: { ...flags }
    });

    return {
        STATES,
        transition,
        forceState,
        getState,
        getPreviousState,
        is,
        isOneOf,
        setFlag,
        getFlag,
        isConnected,
        canListen,
        canSendMessage,
        getSnapshot
    };
})();
