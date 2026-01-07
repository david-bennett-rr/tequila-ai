// TTSProvider Module - Text-to-Speech providers (Browser, ElevenLabs, Local)
// Uses: Config, Events, AppState, Watchdog
const TTSProvider = (function() {
    let elevenLabsAudio = null;
    let browserUtterance = null;
    let chromeResumeHackTimer = null;
    let currentAudioUrl = null;  // Track current object URL for cleanup

    // Revoke current audio URL if one exists
    const revokeCurrentAudioUrl = () => {
        if (currentAudioUrl) {
            URL.revokeObjectURL(currentAudioUrl);
            currentAudioUrl = null;
        }
    };

    // Helper to emit TTS events
    const emitTTSStarted = (provider) => {
        Events.emit(Events.EVENTS.TTS_STARTED, { provider });
    };

    const emitTTSEnded = (provider) => {
        Events.emit(Events.EVENTS.TTS_ENDED, { provider });
    };

    const emitTTSError = (provider, error) => {
        Events.emit(Events.EVENTS.TTS_ERROR, { provider, error });
    };

    // Cleanup helper for TTS timeout watchdog
    const stopTTSWatchdogs = () => {
        Watchdog.stop(Watchdog.NAMES.TTS_TIMEOUT);
        Watchdog.stop(Watchdog.NAMES.BROWSER_TTS);
        if (chromeResumeHackTimer) {
            clearInterval(chromeResumeHackTimer);
            chromeResumeHackTimer = null;
        }
    };

    // Handle TTS completion
    const handleTTSComplete = (provider) => {
        stopTTSWatchdogs();
        Speech.setAssistantSpeaking(false);
        UI.log("[" + provider + "] playback complete");
        emitTTSEnded(provider);
    };

    // Handle TTS error
    const handleTTSError = (provider, error) => {
        stopTTSWatchdogs();
        UI.log("[" + provider + "] error: " + error);
        Speech.setAssistantSpeaking(false);
        emitTTSError(provider, error);
    };

    const speakWithBrowser = (text) => {
        if (!('speechSynthesis' in window)) {
            UI.log("[browser-tts] not supported");
            emitTTSError('browser', 'not supported');
            return;
        }

        // Cancel any ongoing speech
        window.speechSynthesis.cancel();
        stopTTSWatchdogs();

        // Chrome bug: voices may not be loaded yet
        let voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) {
            UI.log("[browser-tts] waiting for voices to load...");
        }

        UI.log("[browser-tts] speaking...");
        Speech.setAssistantSpeaking(true);
        emitTTSStarted('browser');

        // Start TTS timeout watchdog
        Watchdog.startTTSTimeout(() => {
            window.speechSynthesis.cancel();
            handleTTSError('browser', 'timeout exceeded');
        });

        // Start browser TTS watchdog for Chrome bugs
        Watchdog.startBrowserTTSWatchdog(
            // onStuck
            () => {
                handleTTSError('browser', 'stuck - forced cancel');
            },
            // onEnded (speech ended without event)
            () => {
                handleTTSComplete('browser');
            }
        );

        browserUtterance = new SpeechSynthesisUtterance(text);
        browserUtterance.rate = 1.0;
        browserUtterance.pitch = 1.0;

        // Chrome bug workaround: long utterances get cut off
        // We can help by periodically resuming (in case it pauses)
        chromeResumeHackTimer = setInterval(() => {
            if (window.speechSynthesis.speaking) {
                window.speechSynthesis.pause();
                window.speechSynthesis.resume();
            } else {
                clearInterval(chromeResumeHackTimer);
                chromeResumeHackTimer = null;
            }
        }, Config.CHROME_RESUME_INTERVAL);

        browserUtterance.onend = () => {
            if (chromeResumeHackTimer) {
                clearInterval(chromeResumeHackTimer);
                chromeResumeHackTimer = null;
            }
            handleTTSComplete('browser');
        };

        browserUtterance.onerror = (e) => {
            if (chromeResumeHackTimer) {
                clearInterval(chromeResumeHackTimer);
                chromeResumeHackTimer = null;
            }
            handleTTSError('browser', e.error);
        };

        window.speechSynthesis.speak(browserUtterance);
    };

    const speakWithElevenLabs = async (text) => {
        const apiKey = Storage.elevenLabsKey.trim();
        const voiceId = Storage.elevenLabsVoice.trim() || "21m00Tcm4TlvDq8ikWAM";
        let audioUrl = null;  // Track URL for this specific call

        if (!apiKey) {
            UI.log("[elevenlabs] missing API key");
            emitTTSError('elevenlabs', 'missing API key');
            return;
        }

        // Clean up any previous audio URL
        revokeCurrentAudioUrl();
        stopTTSWatchdogs();

        try {
            UI.log("[elevenlabs] requesting audio...");
            Speech.setAssistantSpeaking(true);
            emitTTSStarted('elevenlabs');

            // Start TTS timeout watchdog
            Watchdog.startTTSTimeout(() => {
                revokeCurrentAudioUrl();
                if (elevenLabsAudio) {
                    elevenLabsAudio.pause();
                }
                handleTTSError('elevenlabs', 'timeout exceeded');
            });

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
                handleTTSError('elevenlabs', await response.text());
                return;
            }

            const audioBlob = await response.blob();
            audioUrl = URL.createObjectURL(audioBlob);
            currentAudioUrl = audioUrl;

            if (!elevenLabsAudio) {
                elevenLabsAudio = new Audio();
            }

            elevenLabsAudio.src = audioUrl;
            elevenLabsAudio.onended = () => {
                // Only revoke if this is still the current URL (not replaced by new request)
                if (currentAudioUrl === audioUrl) {
                    revokeCurrentAudioUrl();
                } else {
                    URL.revokeObjectURL(audioUrl);
                }
                handleTTSComplete('elevenlabs');
            };
            elevenLabsAudio.onerror = (e) => {
                if (currentAudioUrl === audioUrl) {
                    revokeCurrentAudioUrl();
                } else {
                    URL.revokeObjectURL(audioUrl);
                }
                handleTTSError('elevenlabs', e?.message || 'playback error');
            };

            await elevenLabsAudio.play();
            UI.log("[elevenlabs] playing audio");
        } catch (e) {
            // Clean up this call's URL if it was created
            if (audioUrl) {
                if (currentAudioUrl === audioUrl) {
                    revokeCurrentAudioUrl();
                } else {
                    URL.revokeObjectURL(audioUrl);
                }
            }
            handleTTSError('elevenlabs', e.message);
        }
    };

    const speakWithLocalTTS = async (text) => {
        const endpoint = Storage.localTtsEndpoint.trim() || "http://localhost:5002/api/tts";
        let audioUrl = null;  // Track URL for this specific call

        // Clean up any previous audio URL
        revokeCurrentAudioUrl();
        stopTTSWatchdogs();

        try {
            UI.log("[local-tts] requesting audio...");
            Speech.setAssistantSpeaking(true);
            emitTTSStarted('local');

            // Start TTS timeout watchdog
            Watchdog.startTTSTimeout(() => {
                revokeCurrentAudioUrl();
                if (elevenLabsAudio) {
                    elevenLabsAudio.pause();
                }
                handleTTSError('local', 'timeout exceeded');
            });

            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text })
            });

            if (!response.ok) {
                handleTTSError('local', await response.text());
                return;
            }

            const audioBlob = await response.blob();
            audioUrl = URL.createObjectURL(audioBlob);
            currentAudioUrl = audioUrl;

            if (!elevenLabsAudio) {
                elevenLabsAudio = new Audio();
            }

            elevenLabsAudio.src = audioUrl;
            elevenLabsAudio.onended = () => {
                // Only revoke if this is still the current URL (not replaced by new request)
                if (currentAudioUrl === audioUrl) {
                    revokeCurrentAudioUrl();
                } else {
                    URL.revokeObjectURL(audioUrl);
                }
                handleTTSComplete('local');
            };
            elevenLabsAudio.onerror = (e) => {
                if (currentAudioUrl === audioUrl) {
                    revokeCurrentAudioUrl();
                } else {
                    URL.revokeObjectURL(audioUrl);
                }
                handleTTSError('local', e?.message || 'playback error');
            };

            await elevenLabsAudio.play();
            UI.log("[local-tts] playing audio");
        } catch (e) {
            // Clean up this call's URL if it was created
            if (audioUrl) {
                if (currentAudioUrl === audioUrl) {
                    revokeCurrentAudioUrl();
                } else {
                    URL.revokeObjectURL(audioUrl);
                }
            }
            handleTTSError('local', e.message);
        }
    };

    const stop = () => {
        stopTTSWatchdogs();
        revokeCurrentAudioUrl();
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
