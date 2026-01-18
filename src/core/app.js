// Main App Module - Application initialization
// Uses: Config, Events, AppState, Watchdog, all feature modules

// Global error handlers for kiosk reliability - catch all errors to prevent crashes
window.onerror = (msg, url, line, col) => {
    console.error("[global] Uncaught error:", msg, "at", url, line, col);
    if (typeof UI !== 'undefined' && UI.log) {
        UI.log("[err] " + msg);
    }
    if (typeof Events !== 'undefined') {
        Events.emit(Events.EVENTS.ERROR, { source: 'global', error: msg, url, line, col });
    }
    // Return true to prevent the error from stopping execution
    return true;
};

window.onunhandledrejection = (event) => {
    console.error("[global] Unhandled promise rejection:", event.reason);
    if (typeof UI !== 'undefined' && UI.log) {
        UI.log("[err] promise: " + (event.reason?.message || event.reason));
    }
    if (typeof Events !== 'undefined') {
        Events.emit(Events.EVENTS.ERROR, { source: 'promise', error: event.reason?.message || event.reason });
    }
    // Prevent the rejection from stopping execution
    event.preventDefault();
};

// Handle page visibility changes (kiosk may sleep/wake)
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        console.log("[global] Page became visible, checking connections...");
        if (typeof UI !== 'undefined' && UI.log) {
            UI.log("[sys] page visible, checking status...");
        }
        // The WebRTC connection monitor (via Watchdog) will handle reconnection if needed
    }
});

const App = (function() {
    // Validate Utils module exists before destructuring
    if (typeof Utils === 'undefined' || !Utils.$) {
        console.error("[app] CRITICAL: Utils module not loaded");
        return {
            init: () => {
                console.error("[app] Cannot initialize - Utils module missing");
            }
        };
    }

    const { $ } = Utils;

    const init = () => {
        // Load saved settings
        const apiKey = $("apiKey");
        const model = $("model");
        const voice = $("voice");
        const elevenLabsKey = $("elevenLabsKey");
        const elevenLabsVoice = $("elevenLabsVoice");
        const elevenLabsVoiceSelect = $("elevenLabsVoiceSelect");
        const elevenLabsVoiceNewRow = $("elevenLabsVoiceNewRow");
        const ttsProvider = $("ttsProvider");
        const localTtsEndpoint = $("localTtsEndpoint");
        const llmProvider = $("llmProvider");
        const localLlmEndpoint = $("localLlmEndpoint");
        const localLlmModel = $("localLlmModel");
        const useDirectAudio = $("useDirectAudio");
        const listenWhileSpeaking = $("listenWhileSpeaking");

        // Persona elements
        const personaSelect = $("personaSelect");
        const personaName = $("personaName");
        const personaRole = $("personaRole");
        const personaNameRow = $("personaNameRow");

        if (apiKey) apiKey.value = Storage.apiKey;
        if (model) model.value = Storage.model;
        if (voice) voice.value = Storage.voice;
        if (elevenLabsKey) elevenLabsKey.value = Storage.elevenLabsKey;
        if (ttsProvider) ttsProvider.value = Storage.ttsProvider;
        if (localTtsEndpoint) localTtsEndpoint.value = Storage.localTtsEndpoint || "http://localhost:5002/api/tts";
        if (llmProvider) llmProvider.value = Storage.llmProvider;
        if (localLlmEndpoint) localLlmEndpoint.value = Storage.localLlmEndpoint || "http://localhost:11434/api/generate";
        if (localLlmModel) localLlmModel.value = Storage.localLlmModel || "llama2";
        if (useDirectAudio) useDirectAudio.checked = Storage.useDirectAudio;
        if (listenWhileSpeaking) listenWhileSpeaking.checked = Storage.listenWhileSpeaking;

        // Populate persona dropdown
        const populatePersonaDropdown = () => {
            if (!personaSelect) return;
            const currentName = Storage.currentPersonaName;
            const names = Storage.getPersonaNames();

            // Clear and rebuild
            personaSelect.innerHTML = '<option value="">-- Create new persona --</option>';
            names.forEach(name => {
                const option = document.createElement("option");
                option.value = name;
                option.textContent = name;
                personaSelect.appendChild(option);
            });

            // Set current selection
            if (currentName && names.includes(currentName)) {
                personaSelect.value = currentName;
                Utils.setDisplay(personaNameRow, false);
                // Load current persona data
                const persona = Storage.getCurrentPersona();
                if (personaRole) personaRole.value = persona.role || "";
            } else {
                personaSelect.value = "";
                Utils.setDisplay(personaNameRow, true);
            }
        };
        populatePersonaDropdown();

        // Handle persona select change
        if (personaSelect) {
            personaSelect.addEventListener("change", () => {
                if (personaSelect.value === "") {
                    // Creating new persona
                    Utils.setDisplay(personaNameRow, true);
                    if (personaName) personaName.value = "";
                    if (personaRole) personaRole.value = "";
                } else {
                    // Selected existing persona
                    Utils.setDisplay(personaNameRow, false);
                    const library = Storage.personaLibrary;
                    const persona = library[personaSelect.value];
                    if (persona && personaRole) {
                        personaRole.value = persona.role || "";
                    }
                }
            });
        }

        // Populate ElevenLabs voice history dropdown
        const populateVoiceHistory = () => {
            if (!elevenLabsVoiceSelect) return;
            const currentValue = Storage.elevenLabsVoice;
            const history = Storage.elevenLabsVoiceHistory;

            // Clear existing options except the first "enter new" option
            elevenLabsVoiceSelect.innerHTML = '<option value="">-- Enter new voice ID --</option>';

            // Add history options
            history.forEach(voiceId => {
                const option = document.createElement("option");
                option.value = voiceId;
                option.textContent = voiceId;
                elevenLabsVoiceSelect.appendChild(option);
            });

            // Set current value if it exists in history
            if (currentValue && history.includes(currentValue)) {
                elevenLabsVoiceSelect.value = currentValue;
                Utils.setDisplay(elevenLabsVoiceNewRow, false);
            } else if (currentValue) {
                // Current value not in history - show in text input
                elevenLabsVoiceSelect.value = "";
                if (elevenLabsVoice) elevenLabsVoice.value = currentValue;
                Utils.setDisplay(elevenLabsVoiceNewRow, true);
            }
        };
        populateVoiceHistory();

        // Handle voice select change
        if (elevenLabsVoiceSelect) {
            elevenLabsVoiceSelect.addEventListener("change", () => {
                if (elevenLabsVoiceSelect.value === "") {
                    // User wants to enter a new voice ID
                    Utils.setDisplay(elevenLabsVoiceNewRow, true);
                    if (elevenLabsVoice) elevenLabsVoice.value = "";
                } else {
                    // User selected an existing voice
                    Utils.setDisplay(elevenLabsVoiceNewRow, false);
                }
            });
        }

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
                // Save persona
                let selectedPersonaName = "";
                if (personaSelect && personaSelect.value) {
                    // Existing persona selected - update its role
                    selectedPersonaName = personaSelect.value;
                    const roleValue = personaRole ? personaRole.value.trim() : "";
                    Storage.savePersona(selectedPersonaName, roleValue);
                } else if (personaName) {
                    // New persona - save with name and role
                    const nameValue = personaName.value.trim();
                    const roleValue = personaRole ? personaRole.value.trim() : "";
                    if (nameValue) {
                        Storage.savePersona(nameValue, roleValue);
                        selectedPersonaName = nameValue;
                        populatePersonaDropdown();
                    }
                }
                if (selectedPersonaName) {
                    Storage.currentPersonaName = selectedPersonaName;
                }

                Storage.apiKey = apiKey ? apiKey.value.trim() : "";
                Storage.model = model ? (model.value.trim() || "gpt-realtime") : "gpt-realtime";
                Storage.voice = voice ? voice.value : "alloy";
                Storage.elevenLabsKey = elevenLabsKey ? elevenLabsKey.value.trim() : "";

                // Get voice ID from either select dropdown or text input
                let voiceIdValue = "";
                if (elevenLabsVoiceSelect && elevenLabsVoiceSelect.value) {
                    // User selected from dropdown
                    voiceIdValue = elevenLabsVoiceSelect.value;
                } else if (elevenLabsVoice) {
                    // User entered new voice ID
                    voiceIdValue = elevenLabsVoice.value.trim();
                }
                Storage.elevenLabsVoice = voiceIdValue || "21m00Tcm4TlvDq8ikWAM";

                // Save voice ID to history for dropdown
                if (voiceIdValue) {
                    Storage.addVoiceToHistory(voiceIdValue);
                    populateVoiceHistory();
                }
                Storage.ttsProvider = ttsProvider ? ttsProvider.value : "openai";
                Storage.localTtsEndpoint = localTtsEndpoint ? localTtsEndpoint.value.trim() : "";
                Storage.llmProvider = llmProvider ? llmProvider.value : "openai";
                Storage.localLlmEndpoint = localLlmEndpoint ? localLlmEndpoint.value.trim() : "";
                Storage.localLlmModel = localLlmModel ? (localLlmModel.value.trim() || "llama2") : "llama2";
                Storage.useDirectAudio = useDirectAudio ? useDirectAudio.checked : false;
                Storage.listenWhileSpeaking = listenWhileSpeaking ? listenWhileSpeaking.checked : false;
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

        // Subscribe to state changes for debugging
        Events.on(Events.EVENTS.STATE_CHANGED, (data) => {
            UI.log("[app] state: " + data.from + " -> " + data.to);
        });

        // Subscribe to errors for centralized error handling
        Events.on(Events.EVENTS.ERROR, (data) => {
            console.error("[app] Error from " + data.source + ":", data.error);
        });

        // Initial UI state
        UI.setControls("idle");
        if (Storage.apiKey) {
            UI.toast("ready");
        }

        // Initialize noise monitor for adaptive speech detection
        if (typeof NoiseMonitor !== 'undefined') {
            NoiseMonitor.setup().then(() => {
                UI.log("[app] noise monitor ready");
            }).catch(e => {
                UI.log("[app] noise monitor unavailable: " + e.message);
            });
        }

        UI.log("[app] initialized with new module architecture");
    };

    return { init };
})();

// Initialize app when DOM is ready
document.addEventListener("DOMContentLoaded", App.init);
