// WebRTC Module - OpenAI Realtime API connection
// Uses: Config, Events, AppState, Watchdog
const WebRTC = (function() {
    let pc = null;
    let dataChannel = null;
    let remoteAudio = null;
    let localLlmConnected = false;
    let localStream = null;  // Microphone stream for direct audio mode
    let micMuted = false;    // Track microphone mute state
    const textBuf = Object.create(null);
    let responseIdCounter = 0;  // Counter for generating unique fallback IDs
    let currentFallbackId = null;  // Current fallback ID for responses missing response_id

    // Streaming TTS state
    let streamingBuffer = "";           // Accumulates text for sentence detection
    let streamingQueue = [];            // Queue of sentences to speak
    let isStreamingSpeaking = false;    // Is TTS currently playing a streamed chunk
    let streamingResponseId = null;     // Track which response we're streaming
    let streamingGeneration = 0;        // Generation counter to invalidate stale callbacks
    let streamingResponseComplete = false;  // True when response.done received, waiting for queue to drain

    // Get or create a consistent ID for a response
    // This ensures content_part.done and response.done use the same ID
    // Note: All message handling runs on the same JS thread, so no true race condition,
    // but we need to ensure consistent ID assignment across related messages
    const getResponseId = (msg) => {
        // Try to get ID from various places in the message
        // response.content_part.done has response_id at top level
        // response.done has id nested in msg.response.id
        const actualId = msg.response_id || msg.response?.id;

        if (actualId) {
            // If we have an actual ID, check if we were using a fallback
            // and migrate the buffer to the real ID
            if (currentFallbackId && !textBuf[actualId] && textBuf[currentFallbackId]) {
                textBuf[actualId] = textBuf[currentFallbackId];
                delete textBuf[currentFallbackId];
                UI.log("[id] migrated fallback " + currentFallbackId + " -> " + actualId);
            }
            // Clear fallback since we now have real ID
            currentFallbackId = null;
            return actualId;
        }

        // No ID found - use fallback system
        // Create a new fallback if none exists for this "session"
        if (!currentFallbackId) {
            currentFallbackId = "_fallback_" + responseIdCounter++;
            UI.log("[id] created fallback: " + currentFallbackId);
        }
        return currentFallbackId;
    };

    // Clear the current fallback ID (called when response.done is received)
    const clearCurrentFallback = () => {
        currentFallbackId = null;
    };

    // Mute/unmute microphone to prevent feedback when assistant speaks
    const setMicMuted = (muted) => {
        if (!localStream) return;
        micMuted = muted;
        localStream.getAudioTracks().forEach(track => {
            track.enabled = !muted;
        });
        UI.log("[mic] " + (muted ? "muted" : "unmuted"));
    };

    // Event unsubscribe functions for cleanup
    let unsubSpeakingStarted = null;
    let unsubSpeakingStopped = null;
    let unsubUserInterrupted = null;

    // Guard against concurrent cleanup
    let cleanupInProgress = false;

    // ============= Streaming TTS Functions =============

    // Reset streaming state for new response
    const resetStreamingState = () => {
        streamingBuffer = "";
        streamingQueue = [];
        isStreamingSpeaking = false;
        streamingResponseId = null;
        streamingGeneration++;  // Invalidate any pending callbacks
        streamingResponseComplete = false;
    };

    // Extract complete sentences from buffer, return { sentences: [], remaining: "" }
    const extractSentences = (text) => {
        const sentences = [];
        // Match sentences ending with . ! or ? (with optional quotes)
        const regex = /[^.!?]*[.!?]+["']?\s*/g;
        let match;
        let lastIndex = 0;

        while ((match = regex.exec(text)) !== null) {
            const sentence = match[0].trim();
            if (sentence.length > 0) {
                sentences.push(sentence);
            }
            lastIndex = regex.lastIndex;
        }

        return {
            sentences,
            remaining: text.slice(lastIndex)
        };
    };

    // Process next item in streaming queue
    const processStreamingQueue = () => {
        // Early exit if queue is empty or already speaking
        if (isStreamingSpeaking || streamingQueue.length === 0) {
            // Queue empty and not speaking - check if response is complete
            // Also verify Speech module exists before calling
            if (!isStreamingSpeaking && streamingQueue.length === 0 &&
                streamingResponseComplete && AppState.getFlag('assistantSpeaking')) {
                UI.log("[streaming] queue drained - assistant done speaking");
                if (typeof Speech !== 'undefined' && Speech.setAssistantSpeaking) {
                    Speech.setAssistantSpeaking(false);
                } else {
                    // Fallback: clear the flag directly if Speech module unavailable
                    AppState.setFlag('assistantSpeaking', false);
                }
                streamingResponseComplete = false;  // Reset for next response
            }
            return;
        }

        const sentence = streamingQueue.shift();
        if (!sentence) return;

        isStreamingSpeaking = true;
        const currentGen = streamingGeneration;  // Capture generation for callback validation
        UI.log("[streaming] speaking: " + sentence.substring(0, 50) + (sentence.length > 50 ? "..." : ""));

        // Check TTSProvider module exists before calling
        if (typeof TTSProvider === 'undefined') {
            UI.log("[streaming] TTSProvider not available");
            isStreamingSpeaking = false;
            return;
        }

        const provider = TTSProvider.getProvider();

        // Callback that validates generation before continuing
        const onComplete = () => {
            // Ignore callback if generation changed (new response started)
            if (currentGen !== streamingGeneration) {
                UI.log("[streaming] ignoring stale callback (gen " + currentGen + " vs " + streamingGeneration + ")");
                return;
            }
            isStreamingSpeaking = false;
            processStreamingQueue();
        };

        // Use streaming-aware TTS that calls back when done
        // Note: These are async functions but we don't await - they handle their own errors
        // and call onComplete when done. We add .catch() to prevent unhandled rejections.
        if (provider === "elevenlabs") {
            TTSProvider.speakWithElevenLabsStreaming(sentence, onComplete).catch(e => {
                UI.log("[streaming] elevenlabs error: " + e.message);
                onComplete();
            });
        } else if (provider === "local") {
            TTSProvider.speakWithLocalTTSStreaming(sentence, onComplete).catch(e => {
                UI.log("[streaming] local TTS error: " + e.message);
                onComplete();
            });
        } else {
            // Fallback - no streaming callback support, use setTimeout to avoid stack overflow
            setTimeout(onComplete, 0);
        }
    };

    // Handle incoming text delta for streaming
    const handleTextDelta = (delta, responseId) => {
        // Validate responseId - skip if it's a stale fallback from a previous response
        // This can happen if messages arrive out of order during reconnection
        if (!responseId) {
            UI.log("[streaming] skipping delta with no responseId");
            return;
        }

        // New response - reset state
        if (streamingResponseId !== responseId) {
            // Only reset if this looks like a genuinely new response
            // (not just a late message from the current one)
            if (streamingResponseId !== null) {
                UI.log("[streaming] new response detected: " + responseId + " (was: " + streamingResponseId + ")");
            }
            resetStreamingState();
            streamingResponseId = responseId;
            // Reset TTS stopped flag so new speech can play
            TTSProvider.resetStoppedFlag();
        }

        streamingBuffer += delta;

        // Extract any complete sentences
        const { sentences, remaining } = extractSentences(streamingBuffer);
        streamingBuffer = remaining;

        // Queue sentences for TTS
        if (sentences.length > 0 && TTSProvider.shouldUseSpeech()) {
            streamingQueue.push(...sentences);
            processStreamingQueue();
        }
    };

    // Flush any remaining text at end of response
    const flushStreamingBuffer = () => {
        if (streamingBuffer.trim() && TTSProvider.shouldUseSpeech()) {
            streamingQueue.push(streamingBuffer.trim());
        }
        streamingBuffer = "";
        // Mark response as complete - queue will set assistantSpeaking=false when drained
        streamingResponseComplete = true;
        // Trigger queue processing (in case queue is already empty)
        processStreamingQueue();
    };

    // Conversation history for local LLM (keeps last few exchanges)
    const MAX_HISTORY = 6;  // 3 exchanges (user + assistant each)
    let conversationHistory = [];

    // Reconnect state
    let reconnectAttempts = 0;
    let reconnectTimer = null;

    const getReconnectDelay = () => {
        return Math.min(Config.BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), Config.MAX_RECONNECT_DELAY);
    };

    const scheduleReconnect = () => {
        if (!AppState.getFlag('shouldBeConnected') || reconnectTimer) return;

        // Check if we've exceeded max reconnect attempts - trigger page reload as last resort
        if (reconnectAttempts >= Config.MAX_RECONNECT_ATTEMPTS) {
            UI.log("[sys] CRITICAL: max reconnect attempts (" + Config.MAX_RECONNECT_ATTEMPTS + ") exceeded");
            UI.log("[sys] triggering page reload in " + Config.PAGE_RELOAD_DELAY + "ms");
            UI.toast("reloading page...");
            Events.emit(Events.EVENTS.ERROR, { source: 'webrtc', error: 'max reconnect attempts exceeded', fatal: true });
            setTimeout(() => {
                window.location.reload();
            }, Config.PAGE_RELOAD_DELAY);
            return;
        }

        const delay = getReconnectDelay();
        reconnectAttempts++;
        UI.log("[sys] scheduling reconnect in " + delay + "ms (attempt " + reconnectAttempts + "/" + Config.MAX_RECONNECT_ATTEMPTS + ")");
        UI.toast("reconnecting...");

        AppState.transition(AppState.STATES.RECONNECTING, 'scheduling reconnect');
        Events.emit(Events.EVENTS.RECONNECT_SCHEDULED, { attempt: reconnectAttempts, delay: delay });

        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;
            if (AppState.getFlag('shouldBeConnected') && !isConnected()) {
                UI.log("[sys] attempting reconnect...");
                try {
                    await connect();
                } catch (e) {
                    UI.log("[sys] reconnect failed: " + e.message);
                    Events.emit(Events.EVENTS.CONNECTION_FAILED, { error: e.message, attempt: reconnectAttempts });
                    scheduleReconnect();
                }
            }
        }, delay);
    };

    const isConnected = () => {
        // For WebRTC: check dataChannel is actually open
        if (dataChannel && dataChannel.readyState === "open") {
            return true;
        }
        // For local LLM: just check the flag (we'll verify with actual requests)
        // Note: local LLM health is verified on each request, not via persistent connection
        return localLlmConnected;
    };

    const handleMessage = (e) => {
        let msg;
        try {
            msg = JSON.parse(e.data);
        } catch {
            return;
        }

        const t = msg.type;

        // Handle server VAD events (direct audio mode)
        if (t === "input_audio_buffer.speech_started") {
            UI.log("[vad] speech started");
            UI.setTranscript("Listening...", "listening");
            return;
        }

        if (t === "input_audio_buffer.speech_stopped") {
            UI.log("[vad] speech stopped");
            UI.setTranscript("Processing...", "waiting");
            return;
        }

        if (t === "input_audio_buffer.committed") {
            UI.log("[vad] audio committed");
            return;
        }

        // Handle user transcription (from Whisper in direct audio mode)
        if (t === "conversation.item.input_audio_transcription.completed") {
            const transcript = msg.transcript || "";
            if (transcript) {
                UI.log("[you] " + transcript);
                UI.addExchange("user", transcript, 0, 0);
            }
            return;
        }

        // Handle streaming text deltas for low-latency TTS
        if (t === "response.text.delta" || t === "response.audio_transcript.delta") {
            const id = getResponseId(msg);
            const delta = msg.delta || "";
            if (delta && TTSProvider.shouldUseSpeech()) {
                handleTextDelta(delta, id);
            }
            return;
        }

        if (t === "response.content_part.done") {
            const id = getResponseId(msg);
            if (msg.part?.type === "text") {
                textBuf[id] = (textBuf[id] || "") + (msg.part.text || "");
            } else if (msg.part?.type === "audio" && msg.part?.transcript) {
                textBuf[id] = (textBuf[id] || "") + (msg.part.transcript || "");
            }
            return;
        }

        if (t === "rate_limits.updated") {
            const lim = msg.rate_limits?.find?.(x => x.name === "tokens");
            if (lim) UI.updateRateLimit(lim);
            return;
        }

        if (t === "response.done" && msg.response) {
            const id = getResponseId(msg);
            const assistantText = (textBuf[id] || "").trim();
            delete textBuf[id];
            clearCurrentFallback();  // Reset fallback for next response

            const usage = msg.response.usage || msg.usage || {};
            const inTok = usage.input_tokens ?? usage.input_token_details?.text_tokens ?? 0;
            const outTok = usage.output_tokens ?? usage.output_token_details?.text_tokens ?? 0;

            if (assistantText) UI.log("[assistant] " + assistantText);
            UI.addExchange("assistant", assistantText, inTok, outTok);

            Events.emit(Events.EVENTS.ASSISTANT_RESPONSE, { text: assistantText, inTok, outTok });

            // Flush any remaining streamed text
            flushStreamingBuffer();

            // Only use non-streaming TTS if streaming didn't handle it
            // (streaming handles TTS sentence-by-sentence as they arrive)
            if (!streamingResponseId && TTSProvider.shouldUseSpeech()) {
                // Reset stopped flag so new speech can play
                TTSProvider.resetStoppedFlag();
                const provider = TTSProvider.getProvider();
                if (provider === "elevenlabs" && assistantText) {
                    TTSProvider.speakWithElevenLabs(assistantText);
                } else if (provider === "local" && assistantText) {
                    TTSProvider.speakWithLocalTTS(assistantText);
                }
            }

            UI.log("[audio] response.done received");
        }
    };

    const cleanupConnection = () => {
        // Guard against concurrent cleanup calls
        if (cleanupInProgress) {
            UI.log("[cleanup] already in progress, skipping");
            return;
        }
        cleanupInProgress = true;

        try {
            try { dataChannel?.close(); } catch {}
            try { pc?.close(); } catch {}
            if (localStream) {
                localStream.getTracks().forEach(track => track.stop());
                localStream = null;
            }
            // Unsubscribe from events
            if (unsubSpeakingStarted) {
                unsubSpeakingStarted();
                unsubSpeakingStarted = null;
            }
            if (unsubSpeakingStopped) {
                unsubSpeakingStopped();
                unsubSpeakingStopped = null;
            }
            if (unsubUserInterrupted) {
                unsubUserInterrupted();
                unsubUserInterrupted = null;
            }
            micMuted = false;
            pc = null;
            dataChannel = null;
        } finally {
            cleanupInProgress = false;
        }
    };

    const connect = async () => {
        const llmProvider = Storage.llmProvider;
        const API_KEY = (Storage.apiKey || "").trim();
        const MODEL = (Storage.model || "").trim();
        const VOICE = Storage.voice;

        // Clean up any existing event listeners before reconnecting
        // This prevents listener accumulation when connect() is called multiple times
        if (unsubSpeakingStarted) {
            unsubSpeakingStarted();
            unsubSpeakingStarted = null;
        }
        if (unsubSpeakingStopped) {
            unsubSpeakingStopped();
            unsubSpeakingStopped = null;
        }
        if (unsubUserInterrupted) {
            unsubUserInterrupted();
            unsubUserInterrupted = null;
        }

        // Mark that we want to stay connected (for kiosk auto-reconnect)
        AppState.setFlag('shouldBeConnected', true);

        Events.emit(Events.EVENTS.CONNECTION_REQUESTED);
        // Transition to CONNECTING - may come from IDLE, RECONNECTING, or ERROR
        // If already CONNECTING, this is a no-op (returns true for same state)
        if (!AppState.transition(AppState.STATES.CONNECTING, 'connect requested')) {
            // If transition failed, force it for recovery (kiosk reliability)
            UI.log("[sys] forcing CONNECTING state for recovery");
            AppState.forceState(AppState.STATES.CONNECTING, 'forced for recovery');
        }

        if (llmProvider === "local") {
            UI.setControls(false);
            UI.toast("connecting to local LLM…");
            // Simulate connection for local LLM (no WebRTC)
            localLlmConnected = true;
            reconnectAttempts = 0;
            UI.setControls("connected");
            UI.toast("connected (local LLM)");
            UI.log("[sys] connected to local LLM");

            AppState.transition(AppState.STATES.CONNECTED, 'local LLM connected');
            Events.emit(Events.EVENTS.CONNECTION_ESTABLISHED, { provider: 'local' });

            // Start connection monitoring using Watchdog
            Watchdog.startConnectionMonitor(scheduleReconnect);

            Speech.init();
            return;
        }

        if (!API_KEY) {
            UI.toast("Missing API key");
            AppState.setFlag('shouldBeConnected', false);
            AppState.transition(AppState.STATES.IDLE, 'missing API key');
            Events.emit(Events.EVENTS.CONNECTION_FAILED, { error: 'missing API key' });
            return;
        }

        UI.setControls(false);
        UI.toast("connecting…");

        pc = new RTCPeerConnection({
            iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
        });

        // Monitor RTCPeerConnection state for kiosk reliability
        pc.onconnectionstatechange = () => {
            UI.log("[rtc] connection state: " + pc.connectionState);
            if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                UI.log("[rtc] connection lost, scheduling reconnect");
                Events.emit(Events.EVENTS.CONNECTION_LOST, { state: pc.connectionState });

                if (AppState.getFlag('shouldBeConnected')) {
                    cleanupConnection();
                    scheduleReconnect();
                }
            } else if (pc.connectionState === "connected") {
                reconnectAttempts = 0;  // Reset on successful connection
            }
        };

        pc.oniceconnectionstatechange = () => {
            UI.log("[rtc] ICE state: " + pc.iceConnectionState);
            if (pc.iceConnectionState === "failed") {
                UI.log("[rtc] ICE failed, scheduling reconnect");
                Events.emit(Events.EVENTS.CONNECTION_LOST, { state: 'ice-failed' });

                if (AppState.getFlag('shouldBeConnected')) {
                    cleanupConnection();
                    scheduleReconnect();
                }
            }
        };

        remoteAudio = new Audio();
        remoteAudio.autoplay = true;

        pc.ontrack = (e) => {
            const [stream] = e.streams;
            remoteAudio.srcObject = stream;
            UI.log("[audio] remote track received");
            AudioMonitor.setup(stream);
        };

        // Check if direct audio mode is enabled
        const useDirectAudio = Storage.useDirectAudio;

        if (useDirectAudio) {
            // Capture microphone and add to WebRTC connection
            try {
                localStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: 24000  // OpenAI expects 24kHz
                    }
                });
                localStream.getTracks().forEach(track => {
                    pc.addTrack(track, localStream);
                });
                UI.log("[audio] microphone added to WebRTC (direct audio mode)");
            } catch (e) {
                UI.log("[audio] microphone access failed: " + e.message);
                UI.toast("Microphone access denied");
                // Fall back to text mode
            }
        }

        dataChannel = pc.createDataChannel("oai-events");
        dataChannel.onopen = () => {
            UI.log("[dc] open");
            reconnectAttempts = 0;  // Reset on successful connection
        };
        dataChannel.onclose = () => {
            UI.log("[dc] close");
            // Trigger reconnect if we should still be connected
            if (AppState.getFlag('shouldBeConnected')) {
                UI.log("[dc] unexpected close, scheduling reconnect");
                Events.emit(Events.EVENTS.CONNECTION_LOST, { reason: 'datachannel-close' });
                scheduleReconnect();
            }
        };
        dataChannel.onerror = (e) => {
            UI.log("[dc] error " + (e?.message || e));
            Events.emit(Events.EVENTS.ERROR, { source: 'datachannel', error: e?.message || e });
            // Trigger reconnect on error
            if (AppState.getFlag('shouldBeConnected')) {
                scheduleReconnect();
            }
        };
        dataChannel.onmessage = handleMessage;

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);

        // Build session config based on mode
        const ttsProvider = TTSProvider.getProvider();
        const wantOpenAIAudio = ttsProvider === "openai";

        const sessionConfig = {
            model: MODEL,
            voice: VOICE,
            instructions: Prompts.REALTIME_INSTRUCTIONS
        };

        // Only request audio output if using OpenAI TTS
        if (wantOpenAIAudio) {
            sessionConfig.output_audio_format = "pcm16";
            sessionConfig.modalities = ["text", "audio"];
        } else {
            // Text-only output for ElevenLabs/Local/Browser TTS
            sessionConfig.modalities = ["text"];
        }

        // Enable audio input if direct audio mode
        if (useDirectAudio && localStream) {
            sessionConfig.input_audio_format = "pcm16";
            sessionConfig.input_audio_transcription = { model: "whisper-1" };
            sessionConfig.turn_detection = {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500  // How long to wait after speech stops
            };
            UI.log("[session] direct audio mode with server VAD" + (wantOpenAIAudio ? "" : " (text-only response)"));
        }

        const createSession = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + API_KEY,
                "Content-Type": "application/json",
                "OpenAI-Beta": "realtime=v1"
            },
            body: JSON.stringify(sessionConfig)
        });

        if (!createSession.ok) {
            UI.log("[err] session: " + (await createSession.text()));
            UI.toast("session failed");
            Events.emit(Events.EVENTS.CONNECTION_FAILED, { error: 'session creation failed' });
            // Trigger reconnect on session failure
            if (AppState.getFlag('shouldBeConnected')) {
                scheduleReconnect();
            }
            return;
        }

        const { client_secret } = await createSession.json();
        const token = client_secret?.value || client_secret;

        // Validate token before proceeding
        if (!token) {
            UI.log("[err] session: no client_secret in response");
            UI.toast("session failed - no token");
            Events.emit(Events.EVENTS.CONNECTION_FAILED, { error: 'no client_secret in session response' });
            if (AppState.getFlag('shouldBeConnected')) {
                scheduleReconnect();
            }
            return;
        }

        const sdpRes = await fetch("https://api.openai.com/v1/realtime?model=" + encodeURIComponent(MODEL), {
            method: "POST",
            headers: {
                Authorization: "Bearer " + token,
                "Content-Type": "application/sdp",
                "OpenAI-Beta": "realtime=v1"
            },
            body: offer.sdp
        });

        if (!sdpRes.ok) {
            UI.log("[err] sdp: " + (await sdpRes.text()));
            UI.toast("SDP failed");
            Events.emit(Events.EVENTS.CONNECTION_FAILED, { error: 'SDP exchange failed' });
            // Trigger reconnect on SDP failure
            if (AppState.getFlag('shouldBeConnected')) {
                scheduleReconnect();
            }
            return;
        }

        const answerSdp = await sdpRes.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        UI.setControls("connected");
        UI.toast("connected");
        UI.log("[sys] connected via WebRTC");

        AppState.transition(AppState.STATES.CONNECTED, 'WebRTC connected');
        Events.emit(Events.EVENTS.CONNECTION_ESTABLISHED, { provider: 'openai' });

        // Start connection monitoring using Watchdog
        Watchdog.startConnectionMonitor(scheduleReconnect);

        // Listen for user interruptions to reset streaming TTS
        unsubUserInterrupted = Events.on(Events.EVENTS.USER_INTERRUPTED, () => {
            UI.log("[streaming] user interrupted - clearing queue");
            // Reset streaming state first
            resetStreamingState();
            // Ensure assistantSpeaking is cleared so UI returns to listening mode
            // (Speech.setAssistantSpeaking is called by the speech module, but we need
            // to ensure the streaming queue check doesn't leave us stuck)
            if (AppState.getFlag('assistantSpeaking')) {
                UI.log("[streaming] clearing stuck assistantSpeaking state after interruption");
                // Check Speech module exists before calling
                if (typeof Speech !== 'undefined' && Speech.setAssistantSpeaking) {
                    Speech.setAssistantSpeaking(false);
                } else {
                    // Fallback: clear the flag directly
                    AppState.setFlag('assistantSpeaking', false);
                }
            }
        });

        // Only use browser Speech API if not in direct audio mode
        if (!useDirectAudio || !localStream) {
            Speech.init();
        } else {
            UI.log("[sys] direct audio mode - skipping browser speech recognition");
            UI.setTranscript("Listening (direct audio)...", "listening");
            // Note: We don't mute the mic during assistant speech in direct audio mode
            // OpenAI's server VAD will detect user interruptions automatically
            // The echo cancellation in getUserMedia should handle feedback
        }
    };

    // Wrapper that catches errors and triggers reconnect
    const connectWithRetry = async () => {
        try {
            await connect();
        } catch (e) {
            UI.log("[sys] connection error: " + e.message);
            UI.toast("connection failed");
            Events.emit(Events.EVENTS.CONNECTION_FAILED, { error: e.message });
            AppState.transition(AppState.STATES.ERROR, 'connection error');
            if (AppState.getFlag('shouldBeConnected')) {
                scheduleReconnect();
            }
        }
    };

    const sendText = (text) => {
        if (!isConnected()) return;

        // Validate Storage module exists
        if (typeof Storage === 'undefined') {
            UI.log("[err] Storage module not available");
            return;
        }

        const llmProvider = Storage.llmProvider;
        const localLlmEndpoint = (Storage.localLlmEndpoint || "").trim() || "http://localhost:11434/api/generate";
        const modalities = TTSProvider.shouldUseOpenAIAudio() ? ["audio", "text"] : ["text"];
        // Use chat format for instruct models, simpler format for base models
        const isInstructModel = (Storage.localLlmModel || "").toLowerCase().includes("instruct") ||
                                (Storage.localLlmModel || "").toLowerCase().includes("chat") ||
                                (Storage.localLlmModel || "").toLowerCase().includes("qwen") ||
                                (Storage.localLlmModel || "").toLowerCase().includes("dolphin") ||
                                (Storage.localLlmModel || "").toLowerCase().includes("mistral");

        // Build conversation history string
        const historyText = conversationHistory.length > 0
            ? conversationHistory.map(h => `${h.role === 'user' ? 'Guest' : 'You'}: ${h.content}`).join('\n') + '\n'
            : '';

        // Get summary with null check for Summary module
        const summary = typeof Summary !== 'undefined' ? Summary.summary : '';

        // Build prompt with null check for Prompts module
        let finalPrompt;
        if (typeof Prompts !== 'undefined') {
            finalPrompt = isInstructModel
                ? Prompts.buildInstructPrompt(text, summary, historyText)
                : Prompts.buildBasePrompt(text, historyText);
        } else {
            // Fallback if Prompts module unavailable
            finalPrompt = historyText + 'Guest: ' + text + '\nYou:';
        }
        if (llmProvider === "local") {
            // Add user message to history
            conversationHistory.push({ role: 'user', content: text });

            // Send to local LLM endpoint (Ollama format)
            UI.log("[you] " + text);
            UI.addExchange("user", text, 0, 0);
            UI.log("[local-llm] sending to " + localLlmEndpoint);
            UI.log("[local-llm] model: " + (Storage.localLlmModel || "llama2") + " - waiting for response...");
            UI.setTranscript("Thinking...", "waiting");

            const startTime = Date.now();

            // Use AbortController for timeout (2 minutes for large models)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000);

            // Wrap in Promise.resolve to ensure all errors (sync and async) are caught
            Promise.resolve().then(async () => {
                try {
                    const res = await fetch(localLlmEndpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: Storage.localLlmModel || "llama2",
                            prompt: finalPrompt,
                            stream: false
                        }),
                        signal: controller.signal
                    });

                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    UI.log("[local-llm] response received in " + elapsed + "s");

                    if (!res.ok) {
                        throw new Error("HTTP " + res.status);
                    }

                    const data = await res.json();

                    // Ollama returns { response: "..." }, other APIs might use { text: "..." }
                    // Ensure we have a string before calling .trim()
                    const rawResponse = data.response || data.text || data.content || "";
                    let assistantText = (typeof rawResponse === 'string' ? rawResponse : String(rawResponse)).trim();
                    if (!assistantText) {
                        UI.log("[local-llm] empty response: " + JSON.stringify(data));
                        UI.setTranscript("Listening...", "listening");
                        return;
                    }

                    // Clean up response - remove "You:" prefix if model included it
                    if (assistantText.toLowerCase().startsWith('you:')) {
                        assistantText = assistantText.slice(4).trim();
                    }

                    // Add assistant response to history
                    conversationHistory.push({ role: 'assistant', content: assistantText });

                    // Trim history to max size
                    while (conversationHistory.length > MAX_HISTORY) {
                        conversationHistory.shift();
                    }

                    UI.log("[assistant] " + assistantText);
                    UI.addExchange("assistant", assistantText, 0, 0);

                    Events.emit(Events.EVENTS.ASSISTANT_RESPONSE, { text: assistantText, inTok: 0, outTok: 0 });

                    if (TTSProvider.shouldUseSpeech()) {
                        // Reset stopped flag so new speech can play
                        TTSProvider.resetStoppedFlag();
                        const provider = TTSProvider.getProvider();
                        if (provider === "elevenlabs" && assistantText) {
                            TTSProvider.speakWithElevenLabs(assistantText);
                        } else if (provider === "browser" && assistantText) {
                            TTSProvider.speakWithBrowser(assistantText);
                        } else if (provider === "local" && assistantText) {
                            TTSProvider.speakWithLocalTTS(assistantText);
                        }
                    } else {
                        // No TTS - go back to listening
                        UI.setTranscript("Listening...", "listening");
                    }
                } catch (e) {
                    if (e.name === 'AbortError') {
                        UI.log("[local-llm] TIMEOUT: model took too long (>2min). Try a smaller model.");
                        UI.toast("LLM timeout - try smaller model");
                    } else {
                        UI.log("[local-llm] error: " + e.message);
                        if (e.message === "Failed to fetch") {
                            UI.log("[local-llm] Hint: Is Ollama running? Try: OLLAMA_ORIGINS=* ollama serve");
                        }
                    }
                    Events.emit(Events.EVENTS.ERROR, { source: 'local-llm', error: e.message });
                    UI.setTranscript("Listening...", "listening");
                } finally {
                    // Always clear timeout to prevent leaks
                    clearTimeout(timeoutId);
                }
            }).catch(e => {
                // Catch any unhandled errors from the async IIFE to prevent unhandled rejection
                UI.log("[local-llm] unexpected error: " + e.message);
                Events.emit(Events.EVENTS.ERROR, { source: 'local-llm', error: e.message, unexpected: true });
                UI.setTranscript("Listening...", "listening");
                clearTimeout(timeoutId);
            });
            return;
        }

        // OpenAI uses its own prompt (always instruct-capable)
        // Use null checks for Prompts and Summary modules
        const openaiSummary = typeof Summary !== 'undefined' ? Summary.summary : '';
        const openaiPrompt = typeof Prompts !== 'undefined'
            ? Prompts.buildInstructPrompt(text, openaiSummary, '')
            : text;  // Fallback to just the text if Prompts unavailable

        const messages = [
            {
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: openaiPrompt }]
                }
            },
            {
                type: "response.create",
                response: { modalities: modalities }
            }
        ];

        messages.forEach(msg => dataChannel.send(JSON.stringify(msg)));
        UI.log("[you] " + text);
        UI.addExchange("user", text, 0, 0);
    };

    const hangup = () => {
        // Mark that we intentionally disconnected (no auto-reconnect)
        AppState.setFlag('shouldBeConnected', false);
        reconnectAttempts = 0;

        // Clear conversation history for fresh start
        conversationHistory = [];

        // Clear any pending reconnect
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        // Stop connection monitor watchdog
        Watchdog.stop(Watchdog.NAMES.CONNECTION_MONITOR);

        // Stop modules with null checks in case they failed to load
        if (typeof Speech !== 'undefined' && Speech.stop) {
            Speech.stop();
        }
        if (typeof AudioMonitor !== 'undefined' && AudioMonitor.stop) {
            AudioMonitor.stop();
        }
        if (typeof TTSProvider !== 'undefined' && TTSProvider.stop) {
            TTSProvider.stop();
        }

        cleanupConnection();
        remoteAudio = null;
        localLlmConnected = false;

        AppState.transition(AppState.STATES.IDLE, 'user hangup');
        Events.emit(Events.EVENTS.DISCONNECTED);

        UI.setControls("idle");
        UI.toast("idle");
        UI.log("[sys] disconnected");
    };

    return {
        connect: connectWithRetry,
        sendText,
        hangup,
        isConnected,
        setMicMuted
    };
})();
