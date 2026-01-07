// AudioMonitor Module - Audio level monitoring for voice activity detection
// Uses: Config, Events, AppState, Watchdog
// Note: This module only controls assistantSpeaking when using OpenAI audio (WebRTC)
// For other TTS providers (ElevenLabs, Browser, Local), TTSProvider handles the state
const AudioMonitor = (function() {
    let audioContext = null;
    let analyser = null;
    let source = null;
    let checkInterval = null;
    let silenceStartTime = 0;
    let lastStream = null;          // Store stream for recovery
    let isOpenAIAudio = false;      // Track if we should control speaking state

    const setup = (stream) => {
        // Store stream for potential recovery
        lastStream = stream;

        // Check if we're using OpenAI audio - only then should AudioMonitor control speaking state
        // For other TTS providers, they handle their own speaking state
        isOpenAIAudio = typeof TTSProvider !== 'undefined' && TTSProvider.shouldUseOpenAIAudio();

        try {
            // Clean up any existing context first
            cleanup();

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;

            source = audioContext.createMediaStreamSource(stream);
            source.connect(analyser);

            // Handle AudioContext state changes (can get suspended)
            audioContext.onstatechange = () => {
                UI.log("[audio] context state: " + audioContext.state);
                if (audioContext.state === "suspended") {
                    UI.log("[audio] context suspended, attempting resume");
                    audioContext.resume().catch(e => {
                        UI.log("[audio] resume failed: " + e.message);
                        Events.emit(Events.EVENTS.ERROR, { source: 'audio-context', error: e.message });
                    });
                }
            };

            start();
            UI.log("[audio] analyser setup complete");
        } catch (e) {
            UI.log("[audio] analyser setup failed: " + e.message);
            Events.emit(Events.EVENTS.ERROR, { source: 'audio-monitor', error: e.message });
            // Attempt recovery after delay
            setTimeout(() => {
                if (lastStream && lastStream.active) {
                    UI.log("[audio] attempting analyser recovery...");
                    setup(lastStream);
                }
            }, 2000);
        }
    };

    const cleanup = () => {
        if (source) {
            try { source.disconnect(); } catch {}
            source = null;
        }
        if (audioContext && audioContext.state !== "closed") {
            try { audioContext.close(); } catch {}
        }
        audioContext = null;
        analyser = null;
    };

    const start = () => {
        if (checkInterval) return;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        let wasPlaying = false;

        checkInterval = setInterval(() => {
            if (!analyser) return;

            try {
                analyser.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
                const isPlaying = average > Config.AUDIO_LEVEL_THRESHOLD;

                if (isPlaying && !wasPlaying) {
                    wasPlaying = true;
                    silenceStartTime = 0;

                    // Start speaking timeout watchdog (always, as failsafe)
                    Watchdog.startSpeakingTimeout(() => {
                        UI.log("[audio] failsafe: speaking too long, forcing end");
                        wasPlaying = false;
                        silenceStartTime = 0;
                        Watchdog.stop(Watchdog.NAMES.SPEAKING_TIMEOUT);
                        if (AppState.getFlag('assistantSpeaking')) {
                            Speech.setAssistantSpeaking(false);
                        }
                    });

                    // Only control speaking state if using OpenAI audio
                    // For other TTS providers, they handle their own state
                    if (isOpenAIAudio && !AppState.getFlag('assistantSpeaking')) {
                        Speech.setAssistantSpeaking(true);
                        UI.log("[audio] detected start (level: " + average.toFixed(1) + ")");
                    }
                } else if (!isPlaying && wasPlaying) {
                    if (silenceStartTime === 0) {
                        silenceStartTime = Date.now();
                    }

                    const silenceDuration = Date.now() - silenceStartTime;
                    if (silenceDuration > Config.AUDIO_SILENCE_THRESHOLD) {
                        wasPlaying = false;
                        silenceStartTime = 0;

                        // Stop speaking timeout watchdog
                        Watchdog.stop(Watchdog.NAMES.SPEAKING_TIMEOUT);

                        // Only control speaking state if using OpenAI audio
                        if (isOpenAIAudio && AppState.getFlag('assistantSpeaking')) {
                            Speech.setAssistantSpeaking(false);
                            UI.log("[audio] detected end (silence: " + silenceDuration + "ms)");
                        }
                    }
                }
            } catch (e) {
                UI.log("[audio] monitor error: " + e.message);
                Events.emit(Events.EVENTS.ERROR, { source: 'audio-monitor', error: e.message });
                // Try to recover
                if (lastStream && lastStream.active) {
                    stop();
                    setTimeout(() => setup(lastStream), 1000);
                }
            }
        }, Config.AUDIO_MONITOR_INTERVAL);
    };

    const stop = () => {
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        Watchdog.stop(Watchdog.NAMES.SPEAKING_TIMEOUT);
        cleanup();
        lastStream = null;
        silenceStartTime = 0;
    };

    return { setup, stop };
})();
