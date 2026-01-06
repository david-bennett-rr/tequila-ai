const AudioMonitor = (function() {
    let audioContext = null;
    let analyser = null;
    let source = null;
    let checkInterval = null;
    let silenceStartTime = 0;
    let speakingStartTime = 0;      // Track when speaking started
    let lastStream = null;          // Store stream for recovery
    const SILENCE_THRESHOLD = 500;
    const MAX_SPEAKING_DURATION = 120000;  // 2 minutes max speaking time failsafe

    const setup = (stream) => {
        // Store stream for potential recovery
        lastStream = stream;

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
                    });
                }
            };

            start();
            UI.log("[audio] analyser setup complete");
        } catch (e) {
            UI.log("[audio] analyser setup failed: " + e.message);
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
                const isPlaying = average > 5;

                if (isPlaying && !wasPlaying) {
                    wasPlaying = true;
                    silenceStartTime = 0;
                    speakingStartTime = Date.now();
                    if (!Speech.assistantSpeaking) {
                        Speech.setAssistantSpeaking(true);
                        UI.log("[audio] detected start (level: " + average.toFixed(1) + ")");
                    }
                } else if (!isPlaying && wasPlaying) {
                    if (silenceStartTime === 0) {
                        silenceStartTime = Date.now();
                    }

                    const silenceDuration = Date.now() - silenceStartTime;
                    if (silenceDuration > SILENCE_THRESHOLD) {
                        wasPlaying = false;
                        silenceStartTime = 0;
                        speakingStartTime = 0;
                        if (Speech.assistantSpeaking) {
                            Speech.setAssistantSpeaking(false);
                            UI.log("[audio] detected end (silence: " + silenceDuration + "ms)");
                        }
                    }
                }

                // Failsafe: force end speaking if it's been too long (audio stream might be broken)
                if (wasPlaying && speakingStartTime > 0) {
                    const speakingDuration = Date.now() - speakingStartTime;
                    if (speakingDuration > MAX_SPEAKING_DURATION) {
                        UI.log("[audio] failsafe: speaking too long (" + speakingDuration + "ms), forcing end");
                        wasPlaying = false;
                        silenceStartTime = 0;
                        speakingStartTime = 0;
                        Speech.setAssistantSpeaking(false);
                    }
                }
            } catch (e) {
                UI.log("[audio] monitor error: " + e.message);
                // Try to recover
                if (lastStream && lastStream.active) {
                    stop();
                    setTimeout(() => setup(lastStream), 1000);
                }
            }
        }, 50);
    };

    const stop = () => {
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        cleanup();
        lastStream = null;
        silenceStartTime = 0;
        speakingStartTime = 0;
    };

    return { setup, stop };
})();