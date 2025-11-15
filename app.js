// Main App Module - Application initialization
const App = (function() {
    const { $ } = Utils;

    const init = () => {
        // Load saved settings
        $("apiKey").value = Storage.apiKey;
        $("model").value = Storage.model;
        $("voice").value = Storage.voice;
        $("elevenLabsKey").value = Storage.elevenLabsKey;
        $("elevenLabsVoice").value = Storage.elevenLabsVoice;
        $("ttsProvider").value = Storage.ttsProvider;

        // Setup event handlers
        $("saveKey").onclick = () => {
            Storage.apiKey = $("apiKey").value.trim();
            Storage.model = $("model").value.trim() || "gpt-realtime";
            Storage.voice = $("voice").value;
            Storage.elevenLabsKey = $("elevenLabsKey").value.trim();
            Storage.elevenLabsVoice = $("elevenLabsVoice").value.trim() || "21m00Tcm4TlvDq8ikWAM";
            Storage.ttsProvider = $("ttsProvider").value;
            UI.toast("Saved.");
        };

        $("connect").onclick = WebRTC.connect;
        $("hangup").onclick = WebRTC.hangup;
        $("listen").onclick = Speech.toggle;

        $("send").onclick = () => {
            const text = $("text").value.trim();
            if (!text) return;
            WebRTC.sendText(text);
            $("text").value = "";
        };

        $("text").addEventListener("keydown", (e) => {
            if (e.key === "Enter") $("send").click();
        });

        // Initial UI state
        UI.setControls("idle");
        if (Storage.apiKey) {
            UI.toast("key loaded");
        }
    };

    return { init };
})();

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", App.init);