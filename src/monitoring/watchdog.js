// Watchdog Module - Consolidated timer management for kiosk reliability
const Watchdog = (function() {
    // Registry of all active watchdogs
    const watchdogs = {};

    // Create or restart a watchdog
    const start = (name, callback, interval, options = {}) => {
        // Stop existing watchdog with this name
        stop(name);

        const watchdog = {
            name: name,
            callback: callback,
            interval: interval,
            startTime: Date.now(),
            maxDuration: options.maxDuration || null,  // Optional max duration before auto-stop
            onTimeout: options.onTimeout || null,       // Called if maxDuration exceeded
            timer: null
        };

        watchdog.timer = setInterval(() => {
            try {
                // Check if max duration exceeded
                if (watchdog.maxDuration) {
                    const elapsed = Date.now() - watchdog.startTime;
                    if (elapsed > watchdog.maxDuration) {
                        UI.log("[watchdog] " + name + " exceeded max duration (" + elapsed + "ms)");
                        if (watchdog.onTimeout) {
                            watchdog.onTimeout(elapsed);
                        }
                        stop(name);
                        return;
                    }
                }

                // Execute the watchdog callback
                callback();
            } catch (e) {
                UI.log("[watchdog] " + name + " error: " + e.message);
            }
        }, interval);

        watchdogs[name] = watchdog;
        UI.log("[watchdog] started: " + name + " (interval: " + interval + "ms)");
    };

    // Stop a watchdog by name
    const stop = (name) => {
        if (watchdogs[name]) {
            clearInterval(watchdogs[name].timer);
            delete watchdogs[name];
            UI.log("[watchdog] stopped: " + name);
        }
    };

    // Stop all watchdogs
    const stopAll = () => {
        Object.keys(watchdogs).forEach(name => stop(name));
    };

    // Check if a watchdog is running
    const isRunning = (name) => !!watchdogs[name];

    // Reset a watchdog's start time (for max duration tracking)
    const reset = (name) => {
        if (watchdogs[name]) {
            watchdogs[name].startTime = Date.now();
            UI.log("[watchdog] reset: " + name);
        }
    };

    // Get status of all watchdogs
    const getStatus = () => {
        const status = {};
        Object.keys(watchdogs).forEach(name => {
            status[name] = {
                running: true,
                interval: watchdogs[name].interval,
                elapsed: Date.now() - watchdogs[name].startTime,
                maxDuration: watchdogs[name].maxDuration
            };
        });
        return status;
    };

    // Predefined watchdog names
    const NAMES = {
        SPEECH_RECOGNITION: 'speech-recognition',
        SPEECH_HEALTH: 'speech-health',
        CONNECTION_MONITOR: 'connection-monitor',
        TTS_TIMEOUT: 'tts-timeout',
        BROWSER_TTS: 'browser-tts',
        AUDIO_MONITOR: 'audio-monitor',
        SPEAKING_TIMEOUT: 'speaking-timeout'
    };

    // Convenience method: start speech recognition watchdog
    const startSpeechWatchdog = (onRestart) => {
        start(NAMES.SPEECH_RECOGNITION, () => {
            const flags = AppState.getSnapshot().flags;
            if (flags.shouldBeListening && !flags.assistantSpeaking && !flags.recognitionActive) {
                UI.log("[watchdog] speech recognition stopped, triggering restart");
                if (onRestart) onRestart();
            }
        }, Config.WATCHDOG_INTERVAL);
    };

    // Convenience method: start speech health check
    const startSpeechHealthCheck = (onStuckDetected) => {
        start(NAMES.SPEECH_HEALTH, () => {
            const flags = AppState.getSnapshot().flags;
            if (flags.shouldBeListening && !flags.assistantSpeaking) {
                // Check for stuck states
                if (onStuckDetected) onStuckDetected();
            }
        }, Config.HEALTH_CHECK_INTERVAL);
    };

    // Convenience method: start connection monitor
    // Note: Uses WebRTC.isConnected() for actual connection state, not AppState
    // This catches cases where state machine says connected but actual connection is dead
    const startConnectionMonitor = (onDisconnected) => {
        start(NAMES.CONNECTION_MONITOR, () => {
            const flags = AppState.getSnapshot().flags;
            // Check actual connection status, not just state machine
            const actuallyConnected = typeof WebRTC !== 'undefined' && WebRTC.isConnected();
            if (flags.shouldBeConnected && !actuallyConnected) {
                UI.log("[watchdog] connection lost (actual check), triggering reconnect");
                if (onDisconnected) onDisconnected();
            }
        }, Config.CONNECTION_MONITOR_INTERVAL);
    };

    // Convenience method: start TTS timeout (max speaking duration)
    const startTTSTimeout = (onTimeout) => {
        start(NAMES.TTS_TIMEOUT, () => {
            // This is checked via maxDuration, callback is just a no-op
        }, 1000, {
            maxDuration: Config.MAX_SPEAKING_DURATION,
            onTimeout: () => {
                UI.log("[watchdog] TTS timeout exceeded, forcing end");
                if (onTimeout) onTimeout();
            }
        });
    };

    // Convenience method: start browser TTS watchdog (Chrome bug)
    const startBrowserTTSWatchdog = (onStuck, onEnded) => {
        start(NAMES.BROWSER_TTS, () => {
            if ('speechSynthesis' in window) {
                if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
                    UI.log("[watchdog] browser TTS ended without event");
                    stop(NAMES.BROWSER_TTS);
                    if (onEnded) onEnded();
                }
            }
        }, Config.BROWSER_TTS_WATCHDOG_INTERVAL, {
            maxDuration: Config.MAX_SPEAKING_DURATION,
            onTimeout: () => {
                UI.log("[watchdog] browser TTS stuck, forcing cancel");
                if ('speechSynthesis' in window) {
                    window.speechSynthesis.cancel();
                }
                if (onStuck) onStuck();
            }
        });
    };

    // Convenience method: start audio speaking timeout
    const startSpeakingTimeout = (onTimeout) => {
        start(NAMES.SPEAKING_TIMEOUT, () => {
            // Checked via maxDuration
        }, 1000, {
            maxDuration: Config.MAX_AUDIO_SPEAKING_DURATION,
            onTimeout: () => {
                UI.log("[watchdog] audio speaking timeout exceeded");
                if (onTimeout) onTimeout();
            }
        });
    };

    return {
        start,
        stop,
        stopAll,
        isRunning,
        reset,
        getStatus,
        NAMES,
        // Convenience methods
        startSpeechWatchdog,
        startSpeechHealthCheck,
        startConnectionMonitor,
        startTTSTimeout,
        startBrowserTTSWatchdog,
        startSpeakingTimeout
    };
})();
