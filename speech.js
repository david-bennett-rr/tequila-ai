// Speech Recognition Module with Voice Activity Detection
const Speech = (function() {
  let recognition = null;
  let isListening = false;
  let shouldBeListening = false;
  let assistantSpeaking = false;
  let silenceTimer = null;
  let finalTranscript = "";
  let recognitionBlocked = false;  // Prevent multiple start calls
  let watchdogTimer = null;        // Watchdog to ensure listening stays active
  let retryCount = 0;              // Track consecutive retry attempts
  let healthCheckInterval = null;  // Periodic health check

  const SILENCE_THRESHOLD = 2000; // 2 seconds of silence = end of speech
  const MIN_WORDS_FOR_SEND = 2;   // Minimum words before considering a send
  const WATCHDOG_INTERVAL = 5000; // Check every 5 seconds
  const MAX_RETRY_DELAY = 10000;  // Max 10 second delay between retries
  const BASE_RETRY_DELAY = 500;   // Start with 500ms delay

  // Calculate retry delay with exponential backoff
  const getRetryDelay = () => {
    const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, retryCount), MAX_RETRY_DELAY);
    return delay;
  };

  // Attempt to start recognition with retry logic
  const tryStartRecognition = () => {
    if (!recognition || isListening || !shouldBeListening || assistantSpeaking || recognitionBlocked) {
      return;
    }

    recognitionBlocked = true;
    try {
      recognition.start();
      retryCount = 0; // Reset on successful start
    } catch (e) {
      UI.log("[speech] start error: " + e.message);
      recognitionBlocked = false;

      // Schedule retry with backoff
      retryCount++;
      const delay = getRetryDelay();
      UI.log("[speech] scheduling retry in " + delay + "ms (attempt " + retryCount + ")");
      setTimeout(() => {
        if (shouldBeListening && !assistantSpeaking && !isListening) {
          tryStartRecognition();
        }
      }, delay);
    }
  };

  // Watchdog function to ensure listening stays active
  const startWatchdog = () => {
    stopWatchdog();
    watchdogTimer = setInterval(() => {
      if (shouldBeListening && !assistantSpeaking && !isListening && !recognitionBlocked) {
        UI.log("[speech] watchdog: recognition stopped unexpectedly, restarting...");
        tryStartRecognition();
      }
    }, WATCHDOG_INTERVAL);
  };

  const stopWatchdog = () => {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  };

  // Health check that runs periodically to detect stuck states
  const startHealthCheck = () => {
    stopHealthCheck();
    healthCheckInterval = setInterval(() => {
      if (shouldBeListening && !assistantSpeaking) {
        // If we should be listening but recognition thinks it's running but we haven't received events
        // This catches edge cases where recognition gets stuck
        if (recognitionBlocked) {
          // Been blocked too long, reset
          UI.log("[speech] health check: clearing stuck blocked state");
          recognitionBlocked = false;
          if (!isListening) {
            tryStartRecognition();
          }
        }
      }
    }, WATCHDOG_INTERVAL * 2); // Run less frequently than watchdog
  };

  const stopHealthCheck = () => {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
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
      isListening = true;
      recognitionBlocked = false;
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
      UI.setTranscript("Listening...", "listening");
      UI.log("[speech] recognition started");
    };

    recognition.onend = () => {
      isListening = false;
      recognitionBlocked = false;  // Always clear block on end
      UI.log("[speech] recognition ended");

      // Clear any pending silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      // Only auto-restart if we should be listening and assistant isn't speaking
      if (shouldBeListening && !assistantSpeaking) {
        // Use retry logic with backoff
        const delay = getRetryDelay();
        UI.log("[speech] auto-restarting in " + delay + "ms");
        setTimeout(() => {
          if (shouldBeListening && !assistantSpeaking && !isListening) {
            tryStartRecognition();
          }
        }, delay);
      } else if (!shouldBeListening) {
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
        UI.setTranscript("Click to start listening...");
      }
    };

    recognition.onresult = (event) => {
      // Completely ignore results if assistant is speaking
      if (assistantSpeaking) {
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

      // Update final transcript if we have new final results
      if (currentFinal) {
        finalTranscript += currentFinal;
      }

      // Display current state
      const displayText = finalTranscript + interimTranscript;
      UI.setTranscript(displayText);

      // Clear existing silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }

      // Start new silence timer if we have final speech with enough words
      const trimmedTranscript = finalTranscript.trim();
      const wordCount = trimmedTranscript.split(/\s+/).filter(w => w.length > 0).length;

      if (trimmedTranscript && wordCount >= MIN_WORDS_FOR_SEND) {
        silenceTimer = setTimeout(() => {
          const textToSend = finalTranscript.trim();
          UI.log("[speech] silence detected, text: " + textToSend);
          UI.log("[speech] connected: " + WebRTC.isConnected() + ", assistantSpeaking: " + assistantSpeaking);
          if (textToSend && WebRTC.isConnected() && !assistantSpeaking) {
            UI.log("[speech] sending to WebRTC...");

            // Clear transcript
            finalTranscript = "";

            // Send the message
            WebRTC.sendText(textToSend);

            // Update UI
            UI.setTranscript("Processing...", "waiting");
          }
        }, SILENCE_THRESHOLD);
      }
    };

    recognition.onerror = (event) => {
      recognitionBlocked = false;
      isListening = false;  // Ensure state is correct after error

      // Ignore aborted errors - these happen when we stop recognition intentionally
      if (event.error === 'aborted') {
        return;
      }

      // Log errors (except no-speech which is normal)
      if (event.error !== 'no-speech') {
        UI.log("[speech] error: " + event.error);
      }

      // For recoverable errors, schedule a restart
      // 'network' - temporary network issue
      // 'audio-capture' - mic issue that might resolve
      // 'no-speech' - just means silence, will restart naturally
      // 'not-allowed' - permission denied (can't recover without user action)
      // 'service-not-allowed' - browser doesn't allow (can't recover)
      const recoverableErrors = ['network', 'audio-capture', 'no-speech'];
      if (recoverableErrors.includes(event.error) && shouldBeListening && !assistantSpeaking) {
        retryCount++;
        const delay = getRetryDelay();
        UI.log("[speech] recoverable error, retrying in " + delay + "ms");
        setTimeout(() => {
          if (shouldBeListening && !assistantSpeaking && !isListening) {
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

    if (shouldBeListening) {
      // Stop listening
      shouldBeListening = false;
      recognitionBlocked = true;  // Block auto-restart
      stopWatchdog();
      stopHealthCheck();
      if (isListening) {
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
      shouldBeListening = true;
      finalTranscript = "";
      recognitionBlocked = false;
      retryCount = 0;
      // Start watchdog and health check for kiosk mode reliability
      startWatchdog();
      startHealthCheck();
      if (!isListening && !assistantSpeaking) {
        tryStartRecognition();
      }
    }
  };

  const stop = () => {
    shouldBeListening = false;
    assistantSpeaking = false;  // Clear assistant speaking state
    stopWatchdog();
    stopHealthCheck();
    if (recognition && isListening) {
      recognitionBlocked = true;  // Only block during active stop
      recognition.stop();
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    finalTranscript = "";
    isListening = false;
    recognitionBlocked = false;  // Clear block so we can restart later
    retryCount = 0;

    // Reset button UI
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
    UI.setTranscript("Click to start listening...");
  };

  const setAssistantSpeaking = (speaking) => {
    assistantSpeaking = speaking;

    if (speaking) {
      // Assistant started speaking
      UI.log("[speech] assistant started speaking");

      // Clear any pending timers and transcript
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      finalTranscript = "";

      UI.setTranscript("Assistant is speaking...", "waiting");

    } else {
      // Assistant stopped speaking
      UI.log("[speech] assistant stopped speaking");

      // Clear transcript to start fresh
      finalTranscript = "";
      retryCount = 0;  // Reset retry count after assistant finishes

      // Update UI
      if (shouldBeListening) {
        UI.setTranscript("Listening...", "listening");

        // Restart recognition if it's not currently running
        if (!isListening && recognition) {
          UI.log("[speech] restarting recognition after assistant finished");
          // Short delay before restarting, then use retry logic
          setTimeout(() => {
            if (shouldBeListening && !assistantSpeaking && !isListening) {
              tryStartRecognition();
            }
          }, 500);
        }
      } else {
        UI.setTranscript("Click to start listening...");
      }
    }
  };

  return {
    init,
    toggle,
    stop,
    setAssistantSpeaking,
    get assistantSpeaking() { return assistantSpeaking; }
  };
})();