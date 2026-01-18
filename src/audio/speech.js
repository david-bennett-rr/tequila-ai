// Speech Recognition Module with Voice Activity Detection
// Uses: Config, Events, AppState, Watchdog
const Speech = (function() {
    let recognition = null;
    let silenceTimer = null;
    let silenceTimerId = 0;  // Unique ID for each timer to detect stale callbacks
    let finalTranscript = "";
    let recognitionBlocked = false;
    let retryCount = 0;
    let pendingRetryTimer = null;  // Track pending retry to prevent race conditions

    // Store handler references for cleanup
    let handlers = {
        onstart: null,
        onend: null,
        onresult: null,
        onerror: null
    };

    // Phrases that indicate user wants to interrupt/stop the assistant
    const INTERRUPTION_PHRASES = [
        // English - direct commands
        'stop', 'shut up', 'be quiet', 'quiet', 'enough', 'ok stop',
        'okay stop', 'hold on', 'wait', 'pause', 'never mind', 'nevermind',
        'hang on', 'one sec', 'one second', 'hey', 'excuse me', 'sorry',
        'actually', 'um actually', 'no no', 'no wait',
        // English - additional
        'shh', 'shhh', 'hush', 'silence', 'that\'s enough', 'okay okay',
        'ok ok', 'got it', 'i got it', 'i get it', 'thanks', 'thank you',
        'skip', 'next', 'stop talking', 'stop it', 'quit it', 'can you stop',
        'please stop', 'alright', 'all right', 'yeah yeah', 'yes yes',
        'i know', 'i understand', 'understood', 'fine', 'okay fine',
        'moving on', 'let me', 'let me speak', 'my turn', 'hold it',
        'wait wait', 'whoa', 'woah', 'hey hey', 'um', 'uh', 'hmm',
        // Spanish - direct commands
        'para', 'párate', 'basta', 'espera', 'cállate', 'silencio',
        'un momento', 'alto', 'ya', 'ya basta', 'ya estuvo',
        // Spanish - attention/interruption
        'oye', 'oiga', 'perdón', 'perdona', 'disculpa', 'disculpe',
        'gracias', 'muchas gracias', 'ok ya', 'okay ya', 'está bien',
        // Spanish - additional
        'momento', 'espérate', 'aguanta', 'detente', 'calla', 'shh',
        'ya entendí', 'ya sé', 'entiendo', 'entendido', 'listo',
        'bueno', 'bueno ya', 'órale', 'ándale', 'sale', 'va',
        'no no', 'no espera', 'un segundo', 'tantito', 'ahorita',
        'mira', 'oyes', 'este', 'eh', 'ah', 'ey'
    ];

    // Check if text contains an interruption phrase
    const isInterruption = (text) => {
        const lower = text.toLowerCase().trim();
        return INTERRUPTION_PHRASES.some(phrase =>
            lower === phrase ||
            lower.startsWith(phrase + ' ') ||
            lower.endsWith(' ' + phrase)
        );
    };

    // Remove all event handlers from recognition object
    const removeHandlers = () => {
        if (!recognition) return;
        recognition.onstart = null;
        recognition.onend = null;
        recognition.onresult = null;
        recognition.onerror = null;
    };

    // Calculate retry delay with exponential backoff
    const getRetryDelay = () => {
        return Math.min(Config.BASE_RETRY_DELAY * Math.pow(2, retryCount), Config.MAX_RETRY_DELAY);
    };

    // Attempt to start recognition with retry logic
    // Uses recognitionBlocked as a mutex to prevent concurrent start attempts
    // Note: We allow starting even when assistant is speaking to detect interruptions
    const tryStartRecognition = () => {
        // Early exit conditions - check all flags atomically
        if (!recognition) {
            UI.log("[speech] tryStart: no recognition object");
            return;
        }
        if (recognitionBlocked) {
            UI.log("[speech] tryStart: blocked (start in progress)");
            return;
        }
        if (AppState.getFlag('recognitionActive')) {
            UI.log("[speech] tryStart: already active");
            return;
        }
        if (!AppState.getFlag('shouldBeListening')) {
            return; // Silent exit - user doesn't want to listen
        }
        // Note: Removed assistantSpeaking check - we keep listening to detect interruptions

        // Set mutex before attempting start
        recognitionBlocked = true;

        try {
            recognition.start();
            // Note: recognitionBlocked is cleared in onstart handler
            retryCount = 0;
        } catch (e) {
            // Clear mutex on failure
            recognitionBlocked = false;

            // Handle "already started" error gracefully
            if (e.message && e.message.includes('already started')) {
                UI.log("[speech] recognition already running (race condition handled)");
                return;
            }

            UI.log("[speech] start error: " + e.message);
            retryCount++;

            // Check if we've exceeded max retry attempts - trigger page reload as last resort
            if (retryCount >= Config.MAX_SPEECH_RETRY_ATTEMPTS) {
                UI.log("[speech] CRITICAL: max retry attempts (" + Config.MAX_SPEECH_RETRY_ATTEMPTS + ") exceeded");
                UI.log("[speech] triggering page reload in " + Config.PAGE_RELOAD_DELAY + "ms");
                UI.toast("reloading page...");
                Events.emit(Events.EVENTS.ERROR, { source: 'speech', error: 'max retry attempts exceeded', fatal: true });
                setTimeout(() => {
                    window.location.reload();
                }, Config.PAGE_RELOAD_DELAY);
                return;
            }

            const delay = getRetryDelay();
            UI.log("[speech] scheduling retry in " + delay + "ms (attempt " + retryCount + "/" + Config.MAX_SPEECH_RETRY_ATTEMPTS + ")");
            // Cancel any existing pending retry to prevent accumulation
            if (pendingRetryTimer) {
                clearTimeout(pendingRetryTimer);
            }
            pendingRetryTimer = setTimeout(() => {
                pendingRetryTimer = null;
                if (AppState.getFlag('shouldBeListening') &&
                    !AppState.getFlag('assistantSpeaking') &&
                    !AppState.getFlag('recognitionActive')) {
                    tryStartRecognition();
                }
            }, delay);
        }
    };

    const updateButtonToStart = () => {
        const btn = Utils.$("listen");
        if (btn) {
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg> Start Listening`;
            btn.classList.remove("active");
        }
    };

    const updateButtonToStop = () => {
        const btn = Utils.$("listen");
        if (btn) {
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg> Stop Listening`;
            btn.classList.add("active");
        }
    };

    const init = () => {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            UI.log("[err] Speech recognition not supported");
            Utils.$("listen").disabled = true;
            return false;
        }

        // Clean up existing handlers if reinitializing
        removeHandlers();

        if (!recognition) {
            recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';
        }

        handlers.onstart = () => {
            AppState.setFlag('recognitionActive', true);
            recognitionBlocked = false;
            updateButtonToStop();
            UI.setTranscript("Listening...", "listening");
            UI.log("[speech] recognition started");
            Events.emit(Events.EVENTS.LISTENING_STARTED);

            if (AppState.isConnected()) {
                AppState.transition(AppState.STATES.LISTENING, 'recognition started');
            }
        };

        handlers.onend = () => {
            AppState.setFlag('recognitionActive', false);
            recognitionBlocked = false;
            UI.log("[speech] recognition ended");
            Events.emit(Events.EVENTS.LISTENING_STOPPED);

            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }

            // Auto-restart if we should be listening (even during assistant speech for interruption detection)
            if (AppState.getFlag('shouldBeListening')) {
                // Skip if a retry is already pending (prevents race condition from rapid onend events)
                if (pendingRetryTimer) {
                    UI.log("[speech] auto-restart skipped - retry already pending");
                    return;
                }
                const delay = getRetryDelay();
                UI.log("[speech] auto-restarting in " + delay + "ms");
                pendingRetryTimer = setTimeout(() => {
                    pendingRetryTimer = null;
                    if (AppState.getFlag('shouldBeListening') &&
                        !AppState.getFlag('recognitionActive')) {
                        tryStartRecognition();
                    }
                }, delay);
            } else {
                updateButtonToStart();
                UI.setTranscript("Click to start listening...");
                if (AppState.isConnected()) {
                    AppState.transition(AppState.STATES.CONNECTED, 'stopped listening');
                }
            }
        };

        handlers.onresult = (event) => {
            let interimTranscript = "";
            let currentFinal = "";

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcript = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    currentFinal += transcript + " ";
                } else {
                    interimTranscript = transcript;
                }
            }

            // Check for interruption while assistant is speaking
            if (AppState.getFlag('assistantSpeaking')) {
                const heardText = (currentFinal + interimTranscript).trim();
                if (heardText && isInterruption(heardText)) {
                    UI.log("[speech] interruption detected: '" + heardText + "'");
                    // Stop TTS playback
                    TTSProvider.stop();
                    // Reset streaming TTS queue in WebRTC
                    Events.emit(Events.EVENTS.USER_INTERRUPTED);
                    // Clear assistant speaking state
                    setAssistantSpeaking(false);
                    finalTranscript = "";
                    UI.setTranscript("Listening...", "listening");
                }
                return;  // Don't process as normal speech while assistant talking
            }

            if (currentFinal) {
                finalTranscript += currentFinal;
            }

            const displayText = finalTranscript + interimTranscript;
            UI.setTranscript(displayText);
            Events.emit(Events.EVENTS.TRANSCRIPT_UPDATE, { text: displayText, isFinal: !!currentFinal });

            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }

            const trimmedTranscript = finalTranscript.trim();
            const wordCount = trimmedTranscript.split(/\s+/).filter(w => w.length > 0).length;

            // Get adaptive settings from noise monitor (if available)
            const adaptive = typeof NoiseMonitor !== 'undefined'
                ? NoiseMonitor.getAdaptiveSettings()
                : { silenceThreshold: Config.SILENCE_THRESHOLD, minWords: Config.MIN_WORDS_FOR_SEND };

            if (trimmedTranscript && wordCount >= adaptive.minWords) {
                // Capture confidence now, before setTimeout (event may be stale later)
                const lastConfidence = event.results[event.results.length - 1]?.[0]?.confidence || 0.9;

                // Increment timer ID to invalidate any previous timer callbacks
                const currentTimerId = ++silenceTimerId;

                silenceTimer = setTimeout(() => {
                    // Check if this timer is still valid (not superseded by a newer one)
                    if (currentTimerId !== silenceTimerId) {
                        return;  // Stale timer callback, ignore
                    }

                    const textToSend = finalTranscript.trim();

                    // Check if this looks like noise (if noise monitor available)
                    if (typeof NoiseMonitor !== 'undefined') {
                        if (NoiseMonitor.isLikelyNoise(textToSend, lastConfidence)) {
                            finalTranscript = "";
                            UI.setTranscript("Listening...", "listening");
                            return;
                        }
                    }

                    UI.log("[speech] silence detected, sending: " + textToSend);

                    if (textToSend && AppState.canSendMessage()) {
                        finalTranscript = "";
                        Events.emit(Events.EVENTS.USER_SPEECH_FINAL, { text: textToSend });
                        WebRTC.sendText(textToSend);
                        UI.setTranscript("Processing...", "waiting");
                        AppState.transition(AppState.STATES.PROCESSING, 'user speech sent');
                    }
                }, adaptive.silenceThreshold);
            }
        };

        handlers.onerror = (event) => {
            recognitionBlocked = false;
            AppState.setFlag('recognitionActive', false);

            if (event.error === 'aborted') {
                return;
            }

            if (event.error !== 'no-speech') {
                UI.log("[speech] error: " + event.error);
            }

            Events.emit(Events.EVENTS.LISTENING_ERROR, { error: event.error });

            const recoverableErrors = ['network', 'audio-capture', 'no-speech'];
            if (recoverableErrors.includes(event.error) &&
                AppState.getFlag('shouldBeListening')) {
                // Skip if a retry is already pending (prevents race condition)
                if (pendingRetryTimer) {
                    UI.log("[speech] error retry skipped - retry already pending");
                    return;
                }
                // Recover even during assistant speech (for interruption detection)
                retryCount++;
                const delay = getRetryDelay();
                UI.log("[speech] recoverable error, retrying in " + delay + "ms");
                pendingRetryTimer = setTimeout(() => {
                    pendingRetryTimer = null;
                    if (AppState.getFlag('shouldBeListening') &&
                        !AppState.getFlag('recognitionActive')) {
                        tryStartRecognition();
                    }
                }, delay);
            }
        };

        // Assign handlers to recognition object
        recognition.onstart = handlers.onstart;
        recognition.onend = handlers.onend;
        recognition.onresult = handlers.onresult;
        recognition.onerror = handlers.onerror;

        return true;
    };

    const toggle = () => {
        if (!recognition) {
            if (!init()) return;
        }

        if (AppState.getFlag('shouldBeListening')) {
            // Stop listening
            AppState.setFlag('shouldBeListening', false);
            recognitionBlocked = true;
            Watchdog.stop(Watchdog.NAMES.SPEECH_RECOGNITION);
            Watchdog.stop(Watchdog.NAMES.SPEECH_HEALTH);

            if (AppState.getFlag('recognitionActive')) {
                recognition.stop();
            }
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            if (pendingRetryTimer) {
                clearTimeout(pendingRetryTimer);
                pendingRetryTimer = null;
            }
            finalTranscript = "";
            retryCount = 0;
        } else {
            // Start listening
            AppState.setFlag('shouldBeListening', true);
            finalTranscript = "";
            recognitionBlocked = false;
            retryCount = 0;

            // Start watchdogs
            Watchdog.startSpeechWatchdog(tryStartRecognition);
            Watchdog.startSpeechHealthCheck(() => {
                if (recognitionBlocked && !AppState.getFlag('recognitionActive')) {
                    UI.log("[speech] health check: clearing stuck blocked state");
                    recognitionBlocked = false;
                    tryStartRecognition();
                }
            });

            if (!AppState.getFlag('recognitionActive')) {
                tryStartRecognition();
            }
        }
    };

    const stop = () => {
        AppState.setFlag('shouldBeListening', false);
        AppState.setFlag('assistantSpeaking', false);
        Watchdog.stop(Watchdog.NAMES.SPEECH_RECOGNITION);
        Watchdog.stop(Watchdog.NAMES.SPEECH_HEALTH);

        if (recognition && AppState.getFlag('recognitionActive')) {
            recognitionBlocked = true;
            recognition.stop();
        }
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
        if (pendingRetryTimer) {
            clearTimeout(pendingRetryTimer);
            pendingRetryTimer = null;
        }
        finalTranscript = "";
        AppState.setFlag('recognitionActive', false);
        recognitionBlocked = false;
        retryCount = 0;

        // Clean up event handlers to prevent memory leaks
        removeHandlers();

        updateButtonToStart();
        UI.setTranscript("Click to start listening...");
    };

    const setAssistantSpeaking = (speaking) => {
        AppState.setFlag('assistantSpeaking', speaking);

        if (speaking) {
            UI.log("[speech] assistant started speaking");
            Events.emit(Events.EVENTS.ASSISTANT_SPEAKING_STARTED);

            if (AppState.isConnected()) {
                AppState.transition(AppState.STATES.SPEAKING, 'assistant speaking');
            }

            // Mute mic if listenWhileSpeaking is OFF
            if (!Storage.listenWhileSpeaking && typeof WebRTC !== 'undefined' && WebRTC.setMicMuted) {
                WebRTC.setMicMuted(true);
                UI.log("[speech] mic muted (listenWhileSpeaking=off)");
            }

            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            finalTranscript = "";
            UI.setTranscript("Assistant is speaking...", "waiting");

        } else {
            UI.log("[speech] assistant stopped speaking");
            Events.emit(Events.EVENTS.ASSISTANT_SPEAKING_STOPPED);

            // Unmute mic if it was muted
            if (!Storage.listenWhileSpeaking && typeof WebRTC !== 'undefined' && WebRTC.setMicMuted) {
                WebRTC.setMicMuted(false);
                UI.log("[speech] mic unmuted");
            }

            finalTranscript = "";
            retryCount = 0;

            if (AppState.getFlag('shouldBeListening')) {
                UI.setTranscript("Listening...", "listening");

                if (AppState.isConnected()) {
                    AppState.transition(AppState.STATES.LISTENING, 'assistant finished');
                }

                if (!AppState.getFlag('recognitionActive') && recognition) {
                    UI.log("[speech] restarting recognition after assistant finished");
                    setTimeout(() => {
                        // Verify recognition still exists (could be nullified by stop())
                        if (recognition &&
                            AppState.getFlag('shouldBeListening') &&
                            !AppState.getFlag('assistantSpeaking') &&
                            !AppState.getFlag('recognitionActive')) {
                            tryStartRecognition();
                        }
                    }, 500);
                }
            } else {
                UI.setTranscript("Click to start listening...");
                if (AppState.isConnected()) {
                    AppState.transition(AppState.STATES.CONNECTED, 'assistant finished, not listening');
                }
            }
        }
    };

    return {
        init,
        toggle,
        stop,
        setAssistantSpeaking,
        get assistantSpeaking() { return AppState.getFlag('assistantSpeaking'); }
    };
})();
