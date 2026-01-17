// NoiseMonitor Module - Ambient noise detection and adaptive thresholds
// Uses: Config, Events, UI
const NoiseMonitor = (function() {
    let audioContext = null;
    let analyser = null;
    let microphone = null;
    let stream = null;
    let monitorInterval = null;

    // Noise tracking
    let noiseHistory = [];
    const HISTORY_SIZE = 50;  // ~2.5 seconds at 50ms intervals
    let ambientNoiseLevel = 0;
    let peakLevel = 0;
    let isCalibrating = true;
    let calibrationSamples = 0;
    const CALIBRATION_SAMPLES = 40;  // ~2 seconds

    // Adaptive thresholds
    let adaptiveSilenceThreshold = Config.SILENCE_THRESHOLD;
    let adaptiveMinWords = Config.MIN_WORDS_FOR_SEND;

    const setup = async () => {
        try {
            // Clean up any existing resources before creating new ones
            // This prevents memory leaks if setup() is called multiple times
            if (monitorInterval) {
                clearInterval(monitorInterval);
                monitorInterval = null;
            }
            if (microphone) {
                try { microphone.disconnect(); } catch {}
                microphone = null;
            }
            if (audioContext && audioContext.state !== 'closed') {
                try { await audioContext.close(); } catch {}
            }
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioContext = null;
            analyser = null;

            // Request microphone access
            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;

            microphone = audioContext.createMediaStreamSource(stream);
            microphone.connect(analyser);

            // Start monitoring
            startMonitoring();
            UI.log("[noise] monitor started, calibrating...");

        } catch (e) {
            UI.log("[noise] setup failed: " + e.message);
            // Non-fatal - speech recognition will still work without noise monitoring
        }
    };

    const startMonitoring = () => {
        if (monitorInterval) return;
        if (!analyser) return;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        monitorInterval = setInterval(() => {
            if (!analyser) return;

            try {
                analyser.getByteFrequencyData(dataArray);

                // Calculate RMS (root mean square) for better level detection
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i] * dataArray[i];
                }
                const rms = Math.sqrt(sum / dataArray.length);
                const currentLevel = rms;

                // Track peak
                if (currentLevel > peakLevel) {
                    peakLevel = currentLevel;
                }

                // Add to history
                noiseHistory.push(currentLevel);
                if (noiseHistory.length > HISTORY_SIZE) {
                    noiseHistory.shift();
                }

                // Calibration phase - establish baseline ambient noise
                if (isCalibrating) {
                    calibrationSamples++;
                    if (calibrationSamples >= CALIBRATION_SAMPLES) {
                        finishCalibration();
                    }
                } else {
                    // Update ambient noise (rolling average of lower percentile)
                    updateAmbientNoise();
                    // Adjust thresholds based on noise
                    adjustThresholds();
                }

                // Update UI indicator
                updateNoiseIndicator(currentLevel);

            } catch (e) {
                UI.log("[noise] monitor error: " + e.message);
            }
        }, 50);
    };

    const finishCalibration = () => {
        isCalibrating = false;

        // Calculate ambient noise from calibration samples
        const sorted = [...noiseHistory].sort((a, b) => a - b);
        // Use 25th percentile as ambient baseline (ignoring peaks)
        const p25Index = Math.floor(sorted.length * 0.25);
        ambientNoiseLevel = sorted[p25Index] || 10;

        UI.log("[noise] calibration complete. ambient: " + ambientNoiseLevel.toFixed(1) + ", peak: " + peakLevel.toFixed(1));
        Events.emit(Events.EVENTS.NOISE_CALIBRATED, { ambient: ambientNoiseLevel, peak: peakLevel });

        // Initial threshold adjustment
        adjustThresholds();
    };

    const updateAmbientNoise = () => {
        if (noiseHistory.length < 10) return;

        // Continuously update ambient noise estimate
        // Use median of recent lows to adapt to changing conditions
        const sorted = [...noiseHistory].sort((a, b) => a - b);
        const p25Index = Math.floor(sorted.length * 0.25);
        const newAmbient = sorted[p25Index];

        // Smooth the update (slow adaptation)
        ambientNoiseLevel = ambientNoiseLevel * 0.95 + newAmbient * 0.05;
    };

    const adjustThresholds = () => {
        // Noise level categories
        // < 15: Quiet room
        // 15-30: Normal conversation nearby
        // 30-50: Busy/noisy
        // > 50: Very loud

        if (ambientNoiseLevel < 15) {
            // Quiet - use default settings
            adaptiveSilenceThreshold = Config.SILENCE_THRESHOLD;
            adaptiveMinWords = Config.MIN_WORDS_FOR_SEND;
        } else if (ambientNoiseLevel < 30) {
            // Moderate noise - slightly longer silence threshold
            adaptiveSilenceThreshold = Config.SILENCE_THRESHOLD + 500;
            adaptiveMinWords = Config.MIN_WORDS_FOR_SEND;
        } else if (ambientNoiseLevel < 50) {
            // Noisy - require more words, longer pauses
            adaptiveSilenceThreshold = Config.SILENCE_THRESHOLD + 1000;
            adaptiveMinWords = Math.max(Config.MIN_WORDS_FOR_SEND, 3);
        } else {
            // Very noisy - be more conservative
            adaptiveSilenceThreshold = Config.SILENCE_THRESHOLD + 1500;
            adaptiveMinWords = Math.max(Config.MIN_WORDS_FOR_SEND, 4);
        }
    };

    const updateNoiseIndicator = (currentLevel) => {
        // Update UI with noise level indicator
        const indicator = document.getElementById('noise-indicator');
        if (!indicator) return;

        // Determine noise category
        let category, color;
        if (isCalibrating) {
            category = "calibrating";
            color = "#888";
        } else if (ambientNoiseLevel < 15) {
            category = "quiet";
            color = "#4CAF50";  // Green
        } else if (ambientNoiseLevel < 30) {
            category = "moderate";
            color = "#FFC107";  // Yellow
        } else if (ambientNoiseLevel < 50) {
            category = "noisy";
            color = "#FF9800";  // Orange
        } else {
            category = "loud";
            color = "#f44336";  // Red
        }

        indicator.style.backgroundColor = color;
        indicator.title = `Noise: ${category} (${ambientNoiseLevel.toFixed(0)})`;
    };

    // Check if current speech seems like noise vs real speech
    const isLikelyNoise = (transcript, confidence) => {
        // Very short transcripts in noisy environments are likely false positives
        if (ambientNoiseLevel > 30) {
            const words = transcript.trim().split(/\s+/).filter(w => w.length > 0);

            // Single word with low confidence in noisy environment = probably noise
            if (words.length === 1 && confidence < 0.7) {
                UI.log("[noise] filtering likely noise: '" + transcript + "' (conf: " + confidence.toFixed(2) + ")");
                return true;
            }

            // Common noise misrecognitions
            const noiseWords = ['the', 'a', 'uh', 'um', 'oh', 'ah', 'hmm', 'huh'];
            if (words.length === 1 && noiseWords.includes(words[0].toLowerCase())) {
                UI.log("[noise] filtering noise word: '" + transcript + "'");
                return true;
            }
        }
        return false;
    };

    // Force recalibration (useful if environment changes)
    const recalibrate = () => {
        UI.log("[noise] starting recalibration...");
        isCalibrating = true;
        calibrationSamples = 0;
        noiseHistory = [];
        peakLevel = 0;
    };

    const getAdaptiveSettings = () => {
        return {
            silenceThreshold: adaptiveSilenceThreshold,
            minWords: adaptiveMinWords,
            ambientNoise: ambientNoiseLevel,
            isCalibrating: isCalibrating
        };
    };

    const stop = () => {
        if (monitorInterval) {
            clearInterval(monitorInterval);
            monitorInterval = null;
        }
        if (microphone) {
            try { microphone.disconnect(); } catch {}
            microphone = null;
        }
        if (audioContext && audioContext.state !== 'closed') {
            try { audioContext.close(); } catch {}
        }
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        audioContext = null;
        analyser = null;
    };

    return {
        setup,
        stop,
        recalibrate,
        isLikelyNoise,
        getAdaptiveSettings,
        get ambientNoise() { return ambientNoiseLevel; },
        get calibrating() { return isCalibrating; }
    };
})();
