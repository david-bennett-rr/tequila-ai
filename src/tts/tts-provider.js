// TTSProvider Module - Text-to-Speech providers (Browser, ElevenLabs, Local)
// Uses: Config, Events, AppState, Watchdog
const TTSProvider = (function() {
    let elevenLabsAudio = null;
    let browserUtterance = null;
    let chromeResumeHackTimer = null;
    let currentAudioUrl = null;  // Track current object URL for cleanup

    // Track active streaming audio for cleanup on stop
    let activeStreamingAudio = null;
    let streamingStopped = false;  // Flag to prevent callbacks after stop

    // Audio processing for volume normalization
    let audioContext = null;
    let compressor = null;
    let gainNode = null;

    // Initialize audio processing chain with compressor/limiter
    const initAudioProcessing = () => {
        if (audioContext) return;
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Compressor to tame loud peaks
            compressor = audioContext.createDynamicsCompressor();
            compressor.threshold.value = -24;  // Start compressing at -24dB
            compressor.knee.value = 12;        // Soft knee for natural sound
            compressor.ratio.value = 8;        // 8:1 compression ratio
            compressor.attack.value = 0.003;   // Fast attack (3ms)
            compressor.release.value = 0.15;   // Moderate release (150ms)

            // Gain node for overall volume control
            gainNode = audioContext.createGain();
            gainNode.gain.value = 0.8;  // Slightly reduce overall volume

            // Chain: source -> compressor -> gain -> destination
            compressor.connect(gainNode);
            gainNode.connect(audioContext.destination);

            UI.log("[audio] volume limiter initialized");
        } catch (e) {
            UI.log("[audio] failed to init volume limiter: " + e.message);
        }
    };

    // Track which audio elements have been connected to avoid double-connect error
    const connectedElements = new WeakSet();

    // Play audio through the compressor chain
    const playWithLimiter = async (audioElement) => {
        initAudioProcessing();
        if (!audioContext || !compressor) {
            // Fallback to direct playback
            return audioElement.play();
        }

        // Resume audio context if suspended (browser autoplay policy)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Only connect once per audio element (createMediaElementSource can only be called once)
        if (!connectedElements.has(audioElement)) {
            try {
                const source = audioContext.createMediaElementSource(audioElement);
                source.connect(compressor);
                connectedElements.add(audioElement);
            } catch (e) {
                // Element may already be connected from a previous operation
                // or audio context may be in invalid state - fall back to direct playback
                UI.log("[audio] limiter connection failed, using direct playback: " + e.message);
                return audioElement.play();
            }
        }

        return audioElement.play();
    };

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
        // Ignore if stop() was called (streamingStopped is set)
        if (streamingStopped) {
            UI.log("[" + provider + "] ignoring completion after stop");
            return;
        }
        stopTTSWatchdogs();
        Speech.setAssistantSpeaking(false);
        UI.log("[" + provider + "] playback complete");
        emitTTSEnded(provider);
    };

    // Handle TTS error
    const handleTTSError = (provider, error) => {
        // Ignore if stop() was called (streamingStopped is set)
        if (streamingStopped) {
            UI.log("[" + provider + "] ignoring error after stop");
            return;
        }
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
                // Wrap pause in try-catch in case audio element is in invalid state
                if (elevenLabsAudio) {
                    try { elevenLabsAudio.pause(); } catch {}
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

            await playWithLimiter(elevenLabsAudio);
            UI.log("[elevenlabs] playing audio (limited)");
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
            // Note: We use a local reference to handle the case where elevenLabsAudio
            // hasn't been created yet when timeout fires
            Watchdog.startTTSTimeout(() => {
                revokeCurrentAudioUrl();
                // elevenLabsAudio is shared across TTS providers - check before using
                if (elevenLabsAudio) {
                    try { elevenLabsAudio.pause(); } catch {}
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

            await playWithLimiter(elevenLabsAudio);
            UI.log("[local-tts] playing audio (limited)");
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

    // ============= Streaming TTS Functions =============
    // These accept a callback that fires when playback completes

    const speakWithElevenLabsStreaming = async (text, onComplete) => {
        // Check if stopped before even starting
        if (streamingStopped) {
            onComplete?.();
            return;
        }

        const apiKey = Storage.elevenLabsKey?.trim();
        const voiceId = Storage.elevenLabsVoice?.trim() || "21m00Tcm4TlvDq8ikWAM";

        if (!apiKey) {
            UI.log("[elevenlabs-stream] no API key");
            onComplete?.();
            return;
        }

        try {
            // Only set speaking if not already speaking (avoid redundant calls)
            if (!AppState.getFlag('assistantSpeaking')) {
                if (typeof Speech !== 'undefined' && Speech.setAssistantSpeaking) {
                    Speech.setAssistantSpeaking(true);
                } else {
                    AppState.setFlag('assistantSpeaking', true);
                }
            }

            const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
                method: "POST",
                headers: {
                    "xi-api-key": apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    text: text,
                    model_id: "eleven_turbo_v2_5",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 }
                })
            });

            // Check if stopped while fetching
            if (streamingStopped) {
                onComplete?.();
                return;
            }

            if (!response.ok) {
                UI.log("[elevenlabs-stream] error: " + response.status);
                onComplete?.();
                return;
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            // Track URL for cleanup in case of error
            let urlRevoked = false;
            const revokeUrl = () => {
                if (!urlRevoked) {
                    URL.revokeObjectURL(audioUrl);
                    urlRevoked = true;
                }
            };

            const audio = new Audio(audioUrl);
            activeStreamingAudio = audio;  // Track for stop()

            audio.onended = () => {
                revokeUrl();
                activeStreamingAudio = null;
                // Only call onComplete if not stopped (stop() handles state)
                if (!streamingStopped) {
                    onComplete?.();
                }
            };
            audio.onerror = () => {
                revokeUrl();
                activeStreamingAudio = null;
                if (!streamingStopped) {
                    onComplete?.();
                }
            };

            try {
                await playWithLimiter(audio);
            } catch (playError) {
                // Clean up URL if playback fails
                revokeUrl();
                activeStreamingAudio = null;
                throw playError;  // Re-throw to be caught by outer catch
            }
        } catch (e) {
            UI.log("[elevenlabs-stream] error: " + e.message);
            if (!streamingStopped) {
                onComplete?.();
            }
        }
    };

    const speakWithLocalTTSStreaming = async (text, onComplete) => {
        // Check if stopped before even starting
        if (streamingStopped) {
            onComplete?.();
            return;
        }

        const endpoint = Storage.localTtsEndpoint?.trim() || "http://localhost:5002/api/tts";

        try {
            // Only set speaking if not already speaking (avoid redundant calls)
            if (!AppState.getFlag('assistantSpeaking')) {
                if (typeof Speech !== 'undefined' && Speech.setAssistantSpeaking) {
                    Speech.setAssistantSpeaking(true);
                } else {
                    AppState.setFlag('assistantSpeaking', true);
                }
            }

            const response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: text })
            });

            // Check if stopped while fetching
            if (streamingStopped) {
                onComplete?.();
                return;
            }

            if (!response.ok) {
                UI.log("[local-tts-stream] error: " + response.status);
                onComplete?.();
                return;
            }

            const audioBlob = await response.blob();
            const audioUrl = URL.createObjectURL(audioBlob);

            // Track URL for cleanup in case of error
            let urlRevoked = false;
            const revokeUrl = () => {
                if (!urlRevoked) {
                    URL.revokeObjectURL(audioUrl);
                    urlRevoked = true;
                }
            };

            const audio = new Audio(audioUrl);
            activeStreamingAudio = audio;  // Track for stop()

            audio.onended = () => {
                revokeUrl();
                activeStreamingAudio = null;
                // Only call onComplete if not stopped (stop() handles state)
                if (!streamingStopped) {
                    onComplete?.();
                }
            };
            audio.onerror = () => {
                revokeUrl();
                activeStreamingAudio = null;
                if (!streamingStopped) {
                    onComplete?.();
                }
            };

            try {
                await playWithLimiter(audio);
            } catch (playError) {
                // Clean up URL if playback fails
                revokeUrl();
                activeStreamingAudio = null;
                throw playError;  // Re-throw to be caught by outer catch
            }
        } catch (e) {
            UI.log("[local-tts-stream] error: " + e.message);
            if (!streamingStopped) {
                onComplete?.();
            }
        }
    };

    const stop = () => {
        // Set flag to prevent any streaming callbacks from continuing
        streamingStopped = true;

        stopTTSWatchdogs();
        revokeCurrentAudioUrl();

        // Stop non-streaming audio
        if (elevenLabsAudio) {
            elevenLabsAudio.pause();
            elevenLabsAudio = null;
        }

        // Stop streaming audio
        if (activeStreamingAudio) {
            activeStreamingAudio.pause();
            activeStreamingAudio = null;
        }

        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
    };

    // Reset the stopped flag (call this when starting new speech)
    const resetStoppedFlag = () => {
        streamingStopped = false;
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
        speakWithElevenLabsStreaming,
        speakWithLocalTTSStreaming,
        stop,
        resetStoppedFlag,
        getProvider,
        shouldUseSpeech,
        shouldUseOpenAIAudio
    };
})();
