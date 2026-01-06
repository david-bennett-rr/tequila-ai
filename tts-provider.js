const TTSProvider = (function() {
    let elevenLabsAudio = null;
    let browserUtterance = null;
    let speakingTimeoutTimer = null;
    const MAX_SPEAKING_DURATION = 60000;  // 60 seconds max for any TTS

    // Failsafe: ensure assistantSpeaking doesn't get stuck forever
    const startSpeakingTimeout = () => {
        clearSpeakingTimeout();
        speakingTimeoutTimer = setTimeout(() => {
            UI.log("[tts] timeout: assistantSpeaking stuck, forcing reset");
            Speech.setAssistantSpeaking(false);
        }, MAX_SPEAKING_DURATION);
    };

    const clearSpeakingTimeout = () => {
        if (speakingTimeoutTimer) {
            clearTimeout(speakingTimeoutTimer);
            speakingTimeoutTimer = null;
        }
    };

    // Chrome bug workaround: speechSynthesis can get stuck, onend may never fire
    // This watchdog checks if speech is still playing and forces completion if stuck
    let browserTTSWatchdog = null;
    let browserTTSStartTime = 0;

    const startBrowserTTSWatchdog = () => {
        stopBrowserTTSWatchdog();
        browserTTSStartTime = Date.now();
        browserTTSWatchdog = setInterval(() => {
            // Check if speechSynthesis thinks it's still speaking
            if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
                // Speech finished but onend might not have fired (Chrome bug)
                UI.log("[browser-tts] watchdog: speech ended without event, cleaning up");
                stopBrowserTTSWatchdog();
                clearSpeakingTimeout();
                Speech.setAssistantSpeaking(false);
            } else if (Date.now() - browserTTSStartTime > MAX_SPEAKING_DURATION) {
                // Stuck for too long, force cancel
                UI.log("[browser-tts] watchdog: stuck too long, forcing cancel");
                window.speechSynthesis.cancel();
                stopBrowserTTSWatchdog();
                clearSpeakingTimeout();
                Speech.setAssistantSpeaking(false);
            }
        }, 500);  // Check every 500ms
    };

    const stopBrowserTTSWatchdog = () => {
        if (browserTTSWatchdog) {
            clearInterval(browserTTSWatchdog);
            browserTTSWatchdog = null;
        }
        browserTTSStartTime = 0;
    };

    const speakWithBrowser = (text) => {
        if (!('speechSynthesis' in window)) {
            UI.log("[browser-tts] not supported");
            return;
        }

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();
        clearSpeakingTimeout();
        stopBrowserTTSWatchdog();

        // Chrome bug: voices may not be loaded yet
        // Try to get voices, if empty wait a bit
        let voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) {
            UI.log("[browser-tts] waiting for voices to load...");
        }

        UI.log("[browser-tts] speaking...");
        Speech.setAssistantSpeaking(true);
        startSpeakingTimeout();
        startBrowserTTSWatchdog();

        browserUtterance = new SpeechSynthesisUtterance(text);
        browserUtterance.rate = 1.0;
        browserUtterance.pitch = 1.0;

        // Chrome bug workaround: long utterances get cut off
        // We can help by periodically resuming (in case it pauses)
        const chromeResumeHack = setInterval(() => {
            if (window.speechSynthesis.speaking) {
                window.speechSynthesis.pause();
                window.speechSynthesis.resume();
            } else {
                clearInterval(chromeResumeHack);
            }
        }, 10000);  // Every 10 seconds

        browserUtterance.onend = () => {
            clearInterval(chromeResumeHack);
            stopBrowserTTSWatchdog();
            clearSpeakingTimeout();
            Speech.setAssistantSpeaking(false);
            UI.log("[browser-tts] complete");
        };

        browserUtterance.onerror = (e) => {
            clearInterval(chromeResumeHack);
            stopBrowserTTSWatchdog();
            clearSpeakingTimeout();
            UI.log("[browser-tts] error: " + e.error);
            Speech.setAssistantSpeaking(false);
        };

        window.speechSynthesis.speak(browserUtterance);
    };

    const speakWithElevenLabs = async (text) => {
        const apiKey = Storage.elevenLabsKey.trim();
        const voiceId = Storage.elevenLabsVoice.trim() || "21m00Tcm4TlvDq8ikWAM";

        if (!apiKey) {
            UI.log("[elevenlabs] missing API key");
            return;
        }

        clearSpeakingTimeout();

        try {
            UI.log("[elevenlabs] requesting audio...");
            Speech.setAssistantSpeaking(true);
            startSpeakingTimeout();

            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                method: "POST",
                headers: {
                    "xi-api-key": apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_turbo_v2_5",
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75
                    }
                })
            });

            if (!response.ok) {
                clearSpeakingTimeout();
                UI.log("[elevenlabs] error: " + (await response.text()));
                Speech.setAssistantSpeaking(false);
                return;
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            if (!elevenLabsAudio) {
                elevenLabsAudio = new Audio();
            }

            elevenLabsAudio.src = audioUrl;
            elevenLabsAudio.onended = () => {
                clearSpeakingTimeout();
                Speech.setAssistantSpeaking(false);
                URL.revokeObjectURL(audioUrl);
                UI.log("[elevenlabs] playback complete");
            };
            elevenLabsAudio.onerror = (e) => {
                clearSpeakingTimeout();
                UI.log("[elevenlabs] playback error: " + (e?.message || e));
                Speech.setAssistantSpeaking(false);
                URL.revokeObjectURL(audioUrl);
            };

            await elevenLabsAudio.play();
            UI.log("[elevenlabs] playing audio");
        } catch (e) {
            clearSpeakingTimeout();
            UI.log("[elevenlabs] error: " + e.message);
            Speech.setAssistantSpeaking(false);
        }
    };

    const speakWithLocalTTS = async (text) => {
        const endpoint = Storage.localTtsEndpoint.trim() || "http://localhost:5002/api/tts";
        clearSpeakingTimeout();

        try {
            UI.log("[local-tts] requesting audio...");
            Speech.setAssistantSpeaking(true);
            startSpeakingTimeout();

            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text })
            });

            if (!response.ok) {
                clearSpeakingTimeout();
                UI.log("[local-tts] error: " + (await response.text()));
                Speech.setAssistantSpeaking(false);
                return;
            }
            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);
            if (!elevenLabsAudio) {
                elevenLabsAudio = new Audio();
            }
            elevenLabsAudio.src = audioUrl;
            elevenLabsAudio.onended = () => {
                clearSpeakingTimeout();
                Speech.setAssistantSpeaking(false);
                URL.revokeObjectURL(audioUrl);
                UI.log("[local-tts] playback complete");
            };
            elevenLabsAudio.onerror = (e) => {
                clearSpeakingTimeout();
                UI.log("[local-tts] playback error: " + (e?.message || e));
                Speech.setAssistantSpeaking(false);
                URL.revokeObjectURL(audioUrl);
            };
            await elevenLabsAudio.play();
            UI.log("[local-tts] playing audio");
        } catch (e) {
            clearSpeakingTimeout();
            UI.log("[local-tts] error: " + e.message);
            Speech.setAssistantSpeaking(false);
        }
    };

    const stop = () => {
        clearSpeakingTimeout();
        stopBrowserTTSWatchdog();
        if (elevenLabsAudio) {
            elevenLabsAudio.pause();
            elevenLabsAudio = null;
        }
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
    };

    const getProvider = () => {
        return Storage.ttsProvider || "openai";
    };

    const shouldUseSpeech = () => {
        const el = Utils.$("useSpeech");
        return el ? el.checked : true;
    };

    const shouldUseOpenAIAudio = () => {
        return shouldUseSpeech() && getProvider() === "openai";
    };

    return {
        speakWithBrowser,
        speakWithElevenLabs,
        speakWithLocalTTS,
        stop,
        getProvider,
        shouldUseSpeech,
        shouldUseOpenAIAudio
    };
})();