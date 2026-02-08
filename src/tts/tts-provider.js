// TTSProvider Module - Text-to-Speech providers (Browser, ElevenLabs, Local)
// Uses: Config, Events, AppState, Watchdog
const TTSProvider = (function() {
    let elevenLabsAudio = null;
    let browserUtterance = null;
    let chromeResumeHackTimer = null;
    let currentAudioUrl = null;  // Track current object URL for cleanup

    // Track active streaming audio for cleanup on stop
    let activeStreamingAudio = null;
    let activeStreamingAudioUrl = null;  // Track URL separately for cleanup on stop
    let streamingStopped = false;  // Flag to prevent callbacks after stop

    // Track all active audio elements for comprehensive cleanup
    let allActiveAudioElements = new Set();

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

    // Helper: Safely revoke an audio URL, checking if it's still current
    const safeRevokeAudioUrl = (audioUrl) => {
        if (!audioUrl) return;
        if (currentAudioUrl === audioUrl) {
            revokeCurrentAudioUrl();
        } else {
            URL.revokeObjectURL(audioUrl);
        }
    };

    // Stop all currently playing audio from any source
    // This ensures no overlapping speech when starting new TTS
    const stopAllAudio = () => {
        // Stop browser TTS
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }

        // Stop main elevenLabsAudio element
        Utils.stopAudio(elevenLabsAudio);

        // Stop active streaming audio and revoke its URL to prevent memory leak
        Utils.stopAudio(activeStreamingAudio);
        activeStreamingAudio = null;
        if (activeStreamingAudioUrl) {
            URL.revokeObjectURL(activeStreamingAudioUrl);
            activeStreamingAudioUrl = null;
        }

        // Stop all tracked audio elements
        allActiveAudioElements.forEach(audio => Utils.stopAudio(audio));
        allActiveAudioElements.clear();

        // Clean up Chrome resume hack timer
        chromeResumeHackTimer = Utils.clearTimer(chromeResumeHackTimer, true);
    };

    // Track an audio element for cleanup
    const trackAudioElement = (audio) => {
        allActiveAudioElements.add(audio);
        // Auto-remove when ended or errored
        const cleanup = () => {
            allActiveAudioElements.delete(audio);
        };
        audio.addEventListener('ended', cleanup, { once: true });
        audio.addEventListener('error', cleanup, { once: true });
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
        chromeResumeHackTimer = Utils.clearTimer(chromeResumeHackTimer, true);
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

        // Stop ALL audio sources before starting new speech (prevents overlap)
        stopAllAudio();
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
                chromeResumeHackTimer = Utils.clearTimer(chromeResumeHackTimer, true);
            }
        }, Config.CHROME_RESUME_INTERVAL);

        browserUtterance.onend = () => {
            chromeResumeHackTimer = Utils.clearTimer(chromeResumeHackTimer, true);
            handleTTSComplete('browser');
        };

        browserUtterance.onerror = (e) => {
            chromeResumeHackTimer = Utils.clearTimer(chromeResumeHackTimer, true);
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

        // Stop ALL audio sources before starting new speech (prevents overlap)
        stopAllAudio();
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
                    try { elevenLabsAudio.pause(); } catch (e) { UI.log("[elevenlabs] pause error on timeout: " + e.message); }
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
                safeRevokeAudioUrl(audioUrl);
                handleTTSComplete('elevenlabs');
            };
            elevenLabsAudio.onerror = (e) => {
                safeRevokeAudioUrl(audioUrl);
                handleTTSError('elevenlabs', e?.message || 'playback error');
            };

            await playWithLimiter(elevenLabsAudio);
            UI.log("[elevenlabs] playing audio (limited)");
        } catch (e) {
            safeRevokeAudioUrl(audioUrl);
            handleTTSError('elevenlabs', e.message);
        }
    };

    const speakWithLocalTTS = async (text) => {
        const endpoint = Storage.localTtsEndpoint.trim() || "http://localhost:5002/api/tts";
        let audioUrl = null;

        stopAllAudio();
        revokeCurrentAudioUrl();
        stopTTSWatchdogs();

        try {
            UI.log("[local-tts] requesting audio...");
            Speech.setAssistantSpeaking(true);
            emitTTSStarted('local');

            Watchdog.startTTSTimeout(() => {
                revokeCurrentAudioUrl();
                if (elevenLabsAudio) {
                    try { elevenLabsAudio.pause(); } catch (e) { UI.log("[local-tts] pause error on timeout: " + e.message); }
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
                safeRevokeAudioUrl(audioUrl);
                handleTTSComplete('local');
            };
            elevenLabsAudio.onerror = (e) => {
                safeRevokeAudioUrl(audioUrl);
                handleTTSError('local', e?.message || 'playback error');
            };

            await playWithLimiter(elevenLabsAudio);
            UI.log("[local-tts] playing audio (limited)");
        } catch (e) {
            safeRevokeAudioUrl(audioUrl);
            handleTTSError('local', e.message);
        }
    };

    // ============= Streaming TTS Functions =============
    // These accept a callback that fires when playback completes

    // Streaming TTS timeout constant (per-chunk timeout)
    const STREAMING_TTS_FETCH_TIMEOUT = 15000;  // 15 seconds for API fetch
    const STREAMING_TTS_PLAYBACK_TIMEOUT = 30000;  // 30 seconds for audio playback

    // Helper: Set assistant speaking state (tries Speech module first, falls back to AppState)
    const setAssistantSpeakingIfNeeded = (speaking) => {
        if (speaking && AppState.getFlag('assistantSpeaking')) return; // Already speaking
        if (typeof Speech !== 'undefined' && Speech.setAssistantSpeaking) {
            Speech.setAssistantSpeaking(speaking);
        } else {
            AppState.setFlag('assistantSpeaking', speaking);
        }
    };

    // Helper: Play audio blob with full lifecycle management (timeout, cleanup, callbacks)
    const playStreamingAudio = async (audioBlob, providerName, onComplete) => {
        const audioUrl = URL.createObjectURL(audioBlob);

        // Track URL for cleanup - ensures single revoke
        let urlRevoked = false;
        const revokeUrl = () => {
            if (!urlRevoked) {
                URL.revokeObjectURL(audioUrl);
                urlRevoked = true;
            }
        };

        let audio;
        try {
            audio = new Audio(audioUrl);
        } catch (audioError) {
            revokeUrl();
            throw audioError;
        }
        activeStreamingAudio = audio;
        activeStreamingAudioUrl = audioUrl;
        trackAudioElement(audio);

        // Playback timeout state
        let playbackTimeoutId = null;
        let playbackCompleted = false;

        // Helper to clear streaming refs if this audio is current
        const clearStreamingRefs = () => {
            if (activeStreamingAudio === audio) {
                activeStreamingAudio = null;
                activeStreamingAudioUrl = null;
            }
        };

        const handleComplete = () => {
            if (playbackCompleted) return;
            playbackCompleted = true;
            playbackTimeoutId = Utils.clearTimer(playbackTimeoutId);
            revokeUrl();
            clearStreamingRefs();
            if (!streamingStopped) {
                onComplete?.();
            }
        };

        audio.onended = handleComplete;
        audio.onerror = handleComplete;

        // Playback timeout
        playbackTimeoutId = setTimeout(() => {
            if (!playbackCompleted) {
                UI.log("[" + providerName + "] playback timeout - forcing completion");
                playbackCompleted = true;
                Utils.stopAudio(audio);
                revokeUrl();
                clearStreamingRefs();
                if (!streamingStopped) {
                    onComplete?.();
                }
            }
        }, STREAMING_TTS_PLAYBACK_TIMEOUT);

        try {
            await playWithLimiter(audio);
        } catch (playError) {
            playbackTimeoutId = Utils.clearTimer(playbackTimeoutId);
            revokeUrl();
            clearStreamingRefs();
            throw playError;
        }
    };

    const speakWithElevenLabsStreaming = async (text, onComplete) => {
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
            setAssistantSpeakingIfNeeded(true);

            const { response } = await Utils.fetchWithTimeout(
                `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
                {
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
                },
                STREAMING_TTS_FETCH_TIMEOUT
            );

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
            await playStreamingAudio(audioBlob, "elevenlabs-stream", onComplete);
        } catch (e) {
            UI.log("[elevenlabs-stream] error: " + e.message);
            if (!streamingStopped) {
                onComplete?.();
            }
        }
    };

    const speakWithLocalTTSStreaming = async (text, onComplete) => {
        if (streamingStopped) {
            onComplete?.();
            return;
        }

        const endpoint = Storage.localTtsEndpoint?.trim() || "http://localhost:5002/api/tts";

        try {
            setAssistantSpeakingIfNeeded(true);

            const { response } = await Utils.fetchWithTimeout(
                endpoint,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: text })
                },
                STREAMING_TTS_FETCH_TIMEOUT
            );

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
            await playStreamingAudio(audioBlob, "local-tts-stream", onComplete);
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

        // Revoke streaming audio URL to prevent memory leak
        // (onended won't fire since we're pausing, not ending naturally)
        // NOTE: We null out the URL BEFORE calling stopAllAudio to prevent double-revoke
        // since stopAllAudio also checks activeStreamingAudioUrl
        if (activeStreamingAudioUrl) {
            const urlToRevoke = activeStreamingAudioUrl;
            activeStreamingAudioUrl = null;  // Clear first to prevent stopAllAudio from revoking again
            URL.revokeObjectURL(urlToRevoke);
        }

        // Use comprehensive audio stop to ensure ALL audio sources are stopped
        // Note: activeStreamingAudioUrl is already null, so stopAllAudio won't double-revoke
        stopAllAudio();

        // Also null out our references (stopAllAudio pauses but doesn't null these)
        elevenLabsAudio = null;
        activeStreamingAudio = null;
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
