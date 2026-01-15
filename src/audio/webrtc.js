// WebRTC Module - OpenAI Realtime API connection
// Uses: Config, Events, AppState, Watchdog
const WebRTC = (function() {
    let pc = null;
    let dataChannel = null;
    let remoteAudio = null;
    let localLlmConnected = false;
    const textBuf = Object.create(null);
    let responseIdCounter = 0;  // Counter for generating unique fallback IDs
    const fallbackIdMap = Object.create(null);  // Maps missing response_ids to generated fallback IDs

    // Streaming TTS state
    let streamingBuffer = "";           // Accumulates text for sentence detection
    let streamingQueue = [];            // Queue of sentences to speak
    let isStreamingSpeaking = false;    // Is TTS currently playing a streamed chunk
    let streamingResponseId = null;     // Track which response we're streaming

    // Get or create a consistent ID for a response
    // This ensures content_part.done and response.done use the same ID
    const getResponseId = (msg) => {
        // Try to get ID from various places in the message
        // response.content_part.done has response_id at top level
        // response.done has id nested in msg.response.id
        const actualId = msg.response_id || msg.response?.id;

        if (actualId) {
            // If we have an actual ID, check if we were using a fallback
            // and migrate the buffer to the real ID
            if (fallbackIdMap._current && !textBuf[actualId] && textBuf[fallbackIdMap._current]) {
                textBuf[actualId] = textBuf[fallbackIdMap._current];
                delete textBuf[fallbackIdMap._current];
                delete fallbackIdMap._current;
            }
            return actualId;
        }

        // No ID found - use fallback system
        // For content_part messages, create a new fallback if none exists for this "session"
        if (!fallbackIdMap._current) {
            fallbackIdMap._current = "_fallback_" + responseIdCounter++;
        }
        return fallbackIdMap._current;
    };

    // Clear the current fallback ID (called when response.done is received)
    const clearCurrentFallback = () => {
        delete fallbackIdMap._current;
    };

    // ============= Streaming TTS Functions =============

    // Reset streaming state for new response
    const resetStreamingState = () => {
        streamingBuffer = "";
        streamingQueue = [];
        isStreamingSpeaking = false;
        streamingResponseId = null;
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
        if (isStreamingSpeaking || streamingQueue.length === 0) return;

        const sentence = streamingQueue.shift();
        if (!sentence) return;

        isStreamingSpeaking = true;
        UI.log("[streaming] speaking: " + sentence.substring(0, 50) + (sentence.length > 50 ? "..." : ""));

        const provider = TTSProvider.getProvider();

        // Use streaming-aware TTS that calls back when done
        if (provider === "elevenlabs") {
            TTSProvider.speakWithElevenLabsStreaming(sentence, () => {
                isStreamingSpeaking = false;
                processStreamingQueue();
            });
        } else if (provider === "local") {
            TTSProvider.speakWithLocalTTSStreaming(sentence, () => {
                isStreamingSpeaking = false;
                processStreamingQueue();
            });
        } else {
            // Fallback - no streaming callback support
            isStreamingSpeaking = false;
            processStreamingQueue();
        }
    };

    // Handle incoming text delta for streaming
    const handleTextDelta = (delta, responseId) => {
        // New response - reset state
        if (streamingResponseId !== responseId) {
            resetStreamingState();
            streamingResponseId = responseId;
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
            processStreamingQueue();
        }
        streamingBuffer = "";
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
        try { dataChannel?.close(); } catch {}
        try { pc?.close(); } catch {}
        pc = null;
        dataChannel = null;
    };

    const connect = async () => {
        const llmProvider = Storage.llmProvider;
        const API_KEY = Storage.apiKey.trim();
        const MODEL = Storage.model.trim();
        const VOICE = Storage.voice;

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

        const createSession = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + API_KEY,
                "Content-Type": "application/json",
                "OpenAI-Beta": "realtime=v1"
            },
            body: JSON.stringify({
                model: MODEL,
                voice: VOICE,
                output_audio_format: "pcm16",
                instructions: Prompts.REALTIME_INSTRUCTIONS
            })
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

        Speech.init();
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
        const llmProvider = Storage.llmProvider;
        const localLlmEndpoint = Storage.localLlmEndpoint.trim() || "http://localhost:11434/api/generate";
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

        const finalPrompt = isInstructModel
            ? Prompts.buildInstructPrompt(text, Summary.summary, historyText)
            : Prompts.buildBasePrompt(text, historyText);
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

            fetch(localLlmEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: Storage.localLlmModel || "llama2",
                    prompt: finalPrompt,
                    stream: false
                }),
                signal: controller.signal
            })
            .then(res => {
                clearTimeout(timeoutId);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                UI.log("[local-llm] response received in " + elapsed + "s");
                if (!res.ok) {
                    throw new Error("HTTP " + res.status);
                }
                return res.json();
            })
            .then(data => {
                // Ollama returns { response: "..." }, other APIs might use { text: "..." }
                let assistantText = (data.response || data.text || data.content || "").trim();
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
            })
            .catch(e => {
                clearTimeout(timeoutId);
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
            });
            return;
        }

        // OpenAI uses its own prompt (always instruct-capable)
        const openaiPrompt = Prompts.buildInstructPrompt(text, Summary.summary, '');

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

        Speech.stop();
        AudioMonitor.stop();
        TTSProvider.stop();

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
        isConnected
    };
})();
