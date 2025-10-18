// Speech Recognition Module with Voice Activity Detection
const Speech = (function() {
  let recognition = null;
  let isListening = false;
  let shouldBeListening = false;
  let assistantSpeaking = false;
  let silenceTimer = null;
  let finalTranscript = "";
  let recognitionBlocked = false;  // Prevent multiple start calls

  const SILENCE_THRESHOLD = 1500; // 1.5 seconds of silence = end of speech

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
      btn.textContent = "Stop Listening";
      btn.classList.add("active");
      UI.setTranscript("Listening...", "listening");
      UI.log("[speech] recognition started");
    };

    recognition.onend = () => {
      isListening = false;
      UI.log("[speech] recognition ended");
      
      // Clear any pending silence timer
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      
      // Only auto-restart if we should be listening, assistant isn't speaking, and not blocked
      if (shouldBeListening && !assistantSpeaking && !recognitionBlocked) {
        // Longer delay to prevent rapid restarts
        setTimeout(() => {
          if (shouldBeListening && !assistantSpeaking && !isListening && !recognitionBlocked) {
            recognitionBlocked = true;  // Prevent multiple starts
            UI.log("[speech] auto-restarting");
            try {
              recognition.start();
            } catch (e) {
              UI.log("[speech] restart error: " + e.message);
              recognitionBlocked = false;
            }
          }
        }, 1000);  // 1 second delay between restarts
      } else if (!shouldBeListening) {
        const btn = Utils.$("listen");
        btn.textContent = "Start Listening";
        btn.classList.remove("active");
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

      // Start new silence timer if we have final speech
      if (finalTranscript.trim()) {
        silenceTimer = setTimeout(() => {
          const textToSend = finalTranscript.trim();
          if (textToSend && WebRTC.isConnected() && !assistantSpeaking) {
            UI.log("[speech] silence detected, sending: " + textToSend);
            
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
      // Ignore aborted errors - these happen when we stop recognition
      if (event.error === 'aborted') {
        return;
      }
      if (event.error !== 'no-speech') {
        UI.log("[speech] error: " + event.error);
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
      if (isListening) {
        recognition.stop();
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      finalTranscript = "";
    } else {
      // Start listening
      shouldBeListening = true;
      finalTranscript = "";
      recognitionBlocked = false;
      if (!isListening && !assistantSpeaking) {
        try {
          recognition.start();
        } catch (e) {
          UI.log("[speech] start error: " + e.message);
        }
      }
    }
  };

  const stop = () => {
    shouldBeListening = false;
    recognitionBlocked = true;
    if (recognition && isListening) {
      recognition.stop();
    }
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    finalTranscript = "";
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
      
      // Update UI
      if (shouldBeListening) {
        UI.setTranscript("Listening...", "listening");
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