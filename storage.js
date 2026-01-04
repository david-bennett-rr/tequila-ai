// Storage Module - LocalStorage abstraction
const Storage = (function() {
    const store = {
        get apiKey() { 
            return localStorage.getItem("OPENAI_API_KEY") || ""; 
        },
        set apiKey(v) { 
            localStorage.setItem("OPENAI_API_KEY", v); 
        },
        get model() { 
            return localStorage.getItem("REALTIME_MODEL") || "gpt-realtime"; 
        },
        set model(v) { 
            localStorage.setItem("REALTIME_MODEL", v); 
        },
        get voice() { 
            return localStorage.getItem("REALTIME_VOICE") || "alloy"; 
        },
        set voice(v) { 
            localStorage.setItem("REALTIME_VOICE", v); 
        },
        get elevenLabsKey() {
            return localStorage.getItem("ELEVENLABS_API_KEY") || "";
        },
        set elevenLabsKey(v) {
            localStorage.setItem("ELEVENLABS_API_KEY", v);
        },
        get elevenLabsVoice() {
            return localStorage.getItem("ELEVENLABS_VOICE") || "21m00Tcm4TlvDq8ikWAM";
        },
        set elevenLabsVoice(v) {
            localStorage.setItem("ELEVENLABS_VOICE", v);
        },
        get ttsProvider() {
            return localStorage.getItem("TTS_PROVIDER") || "openai";
        },
        set ttsProvider(v) {
            localStorage.setItem("TTS_PROVIDER", v);
        },
        get localTtsEndpoint() {
            return localStorage.getItem("LOCAL_TTS_ENDPOINT") || "";
        },
        set localTtsEndpoint(v) {
            localStorage.setItem("LOCAL_TTS_ENDPOINT", v);
        },
        get llmProvider() {
            return localStorage.getItem("LLM_PROVIDER") || "openai";
        },
        set llmProvider(v) {
            localStorage.setItem("LLM_PROVIDER", v);
        },
        get localLlmEndpoint() {
            return localStorage.getItem("LOCAL_LLM_ENDPOINT") || "";
        },
        set localLlmEndpoint(v) {
            localStorage.setItem("LOCAL_LLM_ENDPOINT", v);
        },
        get localLlmModel() {
            return localStorage.getItem("LOCAL_LLM_MODEL") || "llama2";
        },
        set localLlmModel(v) {
            localStorage.setItem("LOCAL_LLM_MODEL", v);
        }
    };

    return store;
})();