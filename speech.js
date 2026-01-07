// Speech Recognition Module with Voice Activity Detection
// Uses: Config, Events, AppState, Watchdog
const Speech = (function() {
    let recognition = null;
    let silenceTimer = null;
    let finalTranscript = "";
    let recognitionBlocked = false;
    let retryCount = 0;

    // Calculate retry delay with exponential backoff
    const getRetryDelay = () => {
        return Math.min(Config.BASE_RETRY_DELAY * Math.pow(2, retryCount), Config.MAX_RETRY_DELAY);
    };

    // Attempt to start recognition with retry logic
    // Uses recognitionBlocked as a mutex to prevent concurrent start attempts
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
        if (AppState.getFlag('assistantSpeaking')) {
            UI.log("[speech] tryStart: assistant speaking");
            return;
        }

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
            setTimeout(() => {
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

        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
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

        recognition.onend = () => {
            AppState.setFlag('recognitionActive', false);
            recognitionBlocked = false;
            UI.log("[speech] recognition ended");
            Events.emit(Events.EVENTS.LISTENING_STOPPED);

            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }

            // Auto-restart if we should be listening and assistant isn't speaking
            if (AppState.getFlag('shouldBeListening') && !AppState.getFlag('assistantSpeaking')) {
                const delay = getRetryDelay();
                UI.log("[speech] auto-restarting in " + delay + "ms");
                setTimeout(() => {
                    if (AppState.getFlag('shouldBeListening') &&
                        !AppState.getFlag('assistantSpeaking') &&
                        !AppState.getFlag('recognitionActive')) {
                        tryStartRecognition();
                    }
                }, delay);
            } else if (!AppState.getFlag('shouldBeListening')) {
                updateButtonToStart();
                UI.setTranscript("Click to start listening...");
                if (AppState.isConnected()) {
                    AppState.transition(AppState.STATES.CONNECTED, 'stopped listening');
                }
            }
        };

        recognition.onresult = (event) => {
            if (AppState.getFlag('assistantSpeaking')) {
                return;
            }

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

            if (trimmedTranscript && wordCount >= Config.MIN_WORDS_FOR_SEND) {
                silenceTimer = setTimeout(() => {
                    const textToSend = finalTranscript.trim();
                    UI.log("[speech] silence detected, sending: " + textToSend);

                    if (textToSend && AppState.canSendMessage()) {
                        finalTranscript = "";
                        Events.emit(Events.EVENTS.USER_SPEECH_FINAL, { text: textToSend });
                        WebRTC.sendText(textToSend);
                        UI.setTranscript("Processing...", "waiting");
                        AppState.transition(AppState.STATES.PROCESSING, 'user speech sent');
                    }
                }, Config.SILENCE_THRESHOLD);
            }
        };

        recognition.onerror = (event) => {
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
                AppState.getFlag('shouldBeListening') &&
                !AppState.getFlag('assistantSpeaking')) {
                retryCount++;
                const delay = getRetryDelay();
                UI.log("[speech] recoverable error, retrying in " + delay + "ms");
                setTimeout(() => {
                    if (AppState.getFlag('shouldBeListening') &&
                        !AppState.getFlag('assistantSpeaking') &&
                        !AppState.getFlag('recognitionActive')) {
                        tryStartRecognition();
                    }
                }, delay);
            }
        };

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

            if (!AppState.getFlag('recognitionActive') && !AppState.getFlag('assistantSpeaking')) {
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
        finalTranscript = "";
        AppState.setFlag('recognitionActive', false);
        recognitionBlocked = false;
        retryCount = 0;

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

            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
            finalTranscript = "";
            UI.setTranscript("Assistant is speaking...", "waiting");

        } else {
            UI.log("[speech] assistant stopped speaking");
            Events.emit(Events.EVENTS.ASSISTANT_SPEAKING_STOPPED);

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
                        if (AppState.getFlag('shouldBeListening') &&
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
