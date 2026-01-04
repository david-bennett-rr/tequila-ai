// Main App Module - Application initialization
const App = (function() {
    const { $ } = Utils;

    const init = () => {
        // Load saved settings
        const apiKey = $("apiKey");
        const model = $("model");
        const voice = $("voice");
        const elevenLabsKey = $("elevenLabsKey");
        const elevenLabsVoice = $("elevenLabsVoice");
        const ttsProvider = $("ttsProvider");
        const localTtsEndpoint = $("localTtsEndpoint");
        const llmProvider = $("llmProvider");
        const localLlmEndpoint = $("localLlmEndpoint");
        const localLlmModel = $("localLlmModel");

        if (apiKey) apiKey.value = Storage.apiKey;
        if (model) model.value = Storage.model;
        if (voice) voice.value = Storage.voice;
        if (elevenLabsKey) elevenLabsKey.value = Storage.elevenLabsKey;
        if (elevenLabsVoice) elevenLabsVoice.value = Storage.elevenLabsVoice;
        if (ttsProvider) ttsProvider.value = Storage.ttsProvider;
        if (localTtsEndpoint) localTtsEndpoint.value = Storage.localTtsEndpoint || "http://localhost:5002/api/tts";
        if (llmProvider) llmProvider.value = Storage.llmProvider;
        if (localLlmEndpoint) localLlmEndpoint.value = Storage.localLlmEndpoint || "http://localhost:11434/api/generate";
        if (localLlmModel) localLlmModel.value = Storage.localLlmModel || "llama2";

        // Update provider field visibility
        UI.updateProviderFields();

        // Provider change handlers
        if (llmProvider) {
            llmProvider.addEventListener("change", UI.updateProviderFields);
        }
        if (ttsProvider) {
            ttsProvider.addEventListener("change", UI.updateProviderFields);
        }

        // Mode switcher handlers
        const modeSpeech = $("modeSpeech");
        const modeText = $("modeText");
        const transcriptCard = $("transcriptCard");

        if (modeSpeech && modeText) {
            modeSpeech.onclick = () => {
                modeSpeech.classList.add("active");
                modeText.classList.remove("active");
                if (transcriptCard) transcriptCard.style.display = "block";
            };
            modeText.onclick = () => {
                modeText.classList.add("active");
                modeSpeech.classList.remove("active");
                if (transcriptCard) transcriptCard.style.display = "none";
            };
        }

        // Save configuration handler
        const saveKey = $("saveKey");
        if (saveKey) {
            saveKey.onclick = () => {
                Storage.apiKey = apiKey ? apiKey.value.trim() : "";
                Storage.model = model ? (model.value.trim() || "gpt-realtime") : "gpt-realtime";
                Storage.voice = voice ? voice.value : "alloy";
                Storage.elevenLabsKey = elevenLabsKey ? elevenLabsKey.value.trim() : "";
                Storage.elevenLabsVoice = elevenLabsVoice ? (elevenLabsVoice.value.trim() || "21m00Tcm4TlvDq8ikWAM") : "";
                Storage.ttsProvider = ttsProvider ? ttsProvider.value : "openai";
                Storage.localTtsEndpoint = localTtsEndpoint ? localTtsEndpoint.value.trim() : "";
                Storage.llmProvider = llmProvider ? llmProvider.value : "openai";
                Storage.localLlmEndpoint = localLlmEndpoint ? localLlmEndpoint.value.trim() : "";
                Storage.localLlmModel = localLlmModel ? (localLlmModel.value.trim() || "llama2") : "llama2";
                UI.toast("saved");

                // Brief visual feedback
                saveKey.textContent = "Saved!";
                setTimeout(() => {
                    saveKey.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                        <polyline points="17 21 17 13 7 13 7 21"></polyline>
                        <polyline points="7 3 7 8 15 8"></polyline>
                    </svg> Save Configuration`;
                }, 1500);
            };
        }

        // Connection handlers
        const connect = $("connect");
        const hangup = $("hangup");
        const listen = $("listen");
        const send = $("send");
        const text = $("text");

        if (connect) connect.onclick = WebRTC.connect;
        if (hangup) hangup.onclick = WebRTC.hangup;
        if (listen) listen.onclick = Speech.toggle;

        if (send) {
            send.onclick = () => {
                if (!text) return;
                const msg = text.value.trim();
                if (!msg) return;
                WebRTC.sendText(msg);
                text.value = "";
            };
        }

        if (text) {
            text.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && send) send.click();
            });
        }

        // Initial UI state
        UI.setControls("idle");
        if (Storage.apiKey) {
            UI.toast("ready");
        }
    };

    return { init };
})();

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", App.init);