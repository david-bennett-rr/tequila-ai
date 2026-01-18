// Storage Module - LocalStorage abstraction with error handling for kiosk reliability
const Storage = (function() {
    // In-memory fallback cache if localStorage fails
    const memoryCache = {};

    // Safe localStorage getter with fallback
    const safeGet = (key, defaultValue) => {
        try {
            const value = localStorage.getItem(key);
            return value !== null ? value : defaultValue;
        } catch (e) {
            console.error("[storage] read error for " + key + ":", e.message);
            return memoryCache[key] !== undefined ? memoryCache[key] : defaultValue;
        }
    };

    // Safe localStorage setter with fallback
    const safeSet = (key, value) => {
        // Always update memory cache
        memoryCache[key] = value;
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            console.error("[storage] write error for " + key + ":", e.message);
            // Value is still in memoryCache, so the app continues working
        }
    };

    const store = {
        get apiKey() {
            return safeGet("OPENAI_API_KEY", "");
        },
        set apiKey(v) {
            safeSet("OPENAI_API_KEY", v);
        },
        get model() {
            return safeGet("REALTIME_MODEL", "gpt-4o-realtime-preview-2024-12-17");
        },
        set model(v) {
            safeSet("REALTIME_MODEL", v);
        },
        get voice() {
            return safeGet("REALTIME_VOICE", "alloy");
        },
        set voice(v) {
            safeSet("REALTIME_VOICE", v);
        },
        get elevenLabsKey() {
            return safeGet("ELEVENLABS_API_KEY", "");
        },
        set elevenLabsKey(v) {
            safeSet("ELEVENLABS_API_KEY", v);
        },
        get elevenLabsVoice() {
            return safeGet("ELEVENLABS_VOICE", "21m00Tcm4TlvDq8ikWAM");
        },
        set elevenLabsVoice(v) {
            safeSet("ELEVENLABS_VOICE", v);
        },
        get ttsProvider() {
            return safeGet("TTS_PROVIDER", "openai");
        },
        set ttsProvider(v) {
            safeSet("TTS_PROVIDER", v);
        },
        get localTtsEndpoint() {
            return safeGet("LOCAL_TTS_ENDPOINT", "");
        },
        set localTtsEndpoint(v) {
            safeSet("LOCAL_TTS_ENDPOINT", v);
        },
        get llmProvider() {
            return safeGet("LLM_PROVIDER", "openai");
        },
        set llmProvider(v) {
            safeSet("LLM_PROVIDER", v);
        },
        get localLlmEndpoint() {
            return safeGet("LOCAL_LLM_ENDPOINT", "");
        },
        set localLlmEndpoint(v) {
            safeSet("LOCAL_LLM_ENDPOINT", v);
        },
        get localLlmModel() {
            return safeGet("LOCAL_LLM_MODEL", "llama2");
        },
        set localLlmModel(v) {
            safeSet("LOCAL_LLM_MODEL", v);
        },
        get useDirectAudio() {
            return safeGet("USE_DIRECT_AUDIO", "false") === "true";
        },
        set useDirectAudio(v) {
            safeSet("USE_DIRECT_AUDIO", v ? "true" : "false");
        },
        get listenWhileSpeaking() {
            return safeGet("LISTEN_WHILE_SPEAKING", "false") === "true";
        },
        set listenWhileSpeaking(v) {
            safeSet("LISTEN_WHILE_SPEAKING", v ? "true" : "false");
        },
        get elevenLabsVoiceHistory() {
            try {
                const raw = safeGet("ELEVENLABS_VOICE_HISTORY", "[]");
                return JSON.parse(raw);
            } catch (e) {
                return [];
            }
        },
        set elevenLabsVoiceHistory(v) {
            safeSet("ELEVENLABS_VOICE_HISTORY", JSON.stringify(v || []));
        },
        // Add a voice ID to history (deduplicates and limits to 20 entries)
        addVoiceToHistory(voiceId) {
            if (!voiceId || typeof voiceId !== 'string') return;
            const trimmed = voiceId.trim();
            if (!trimmed) return;

            let history = this.elevenLabsVoiceHistory;
            // Remove if already exists (will re-add at front)
            history = history.filter(v => v !== trimmed);
            // Add to front
            history.unshift(trimmed);
            // Limit to 20 entries
            if (history.length > 20) {
                history = history.slice(0, 20);
            }
            this.elevenLabsVoiceHistory = history;
        },

        // ============= Persona Storage =============
        // Default Fermenter persona
        _defaultPersona: {
            name: "Fermenter",
            role: "a tequila fermenter living in La Rojena, the oldest distillery in N. America"
        },

        get currentPersonaName() {
            return safeGet("CURRENT_PERSONA_NAME", "Fermenter");
        },
        set currentPersonaName(v) {
            safeSet("CURRENT_PERSONA_NAME", v || "Fermenter");
        },

        get personaLibrary() {
            try {
                const raw = safeGet("PERSONA_LIBRARY", "{}");
                const library = JSON.parse(raw);
                // Ensure Fermenter always exists
                if (!library["Fermenter"]) {
                    library["Fermenter"] = this._defaultPersona;
                }
                return library;
            } catch (e) {
                return { "Fermenter": this._defaultPersona };
            }
        },
        set personaLibrary(v) {
            safeSet("PERSONA_LIBRARY", JSON.stringify(v || {}));
        },

        // Get current persona object
        getCurrentPersona() {
            const library = this.personaLibrary;
            const name = this.currentPersonaName;
            return library[name] || this._defaultPersona;
        },

        // Save a persona to library
        savePersona(name, role) {
            if (!name || typeof name !== 'string') return;
            const trimmedName = name.trim();
            if (!trimmedName) return;

            const library = this.personaLibrary;
            library[trimmedName] = {
                name: trimmedName,
                role: (role || "").trim()
            };
            this.personaLibrary = library;
        },

        // Get list of persona names
        getPersonaNames() {
            return Object.keys(this.personaLibrary);
        }
    };

    return store;
})();