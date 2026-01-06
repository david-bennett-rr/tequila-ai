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
        }
    };

    return store;
})();