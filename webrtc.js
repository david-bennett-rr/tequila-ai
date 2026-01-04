const WebRTC = (function() {
    let pc = null;
    let dataChannel = null;
    let remoteAudio = null;
    let localLlmConnected = false;
    const textBuf = Object.create(null);

    const isConnected = () => {
        return localLlmConnected || (dataChannel && dataChannel.readyState === "open");
    };

    const handleMessage = (e) => {
        let msg;
        try { 
            msg = JSON.parse(e.data); 
        } catch { 
            return; 
        }
        
        const t = msg.type;

        if (t === "response.content_part.done") {
            const id = msg.response_id || "r";
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
            const id = msg.response.id || msg.response_id || "r";
            const assistantText = (textBuf[id] || "").trim();
            delete textBuf[id];

            const usage = msg.response.usage || msg.usage || {};
            const inTok = usage.input_tokens ?? usage.input_token_details?.text_tokens ?? 0;
            const outTok = usage.output_tokens ?? usage.output_token_details?.text_tokens ?? 0;

            if (assistantText) UI.log("[assistant] " + assistantText);
            UI.addExchange("assistant", assistantText, inTok, outTok);
            
            // Use ElevenLabs if selected
            if (TTSProvider.shouldUseSpeech()) {
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

    const connect = async () => {
        const llmProvider = Storage.llmProvider;
        const localLlmEndpoint = Storage.localLlmEndpoint.trim() || "http://localhost:11434/api/generate";
        const API_KEY = Storage.apiKey.trim();
        const MODEL = Storage.model.trim();
        const VOICE = Storage.voice;
        
        if (llmProvider === "local") {
            UI.setControls(false);
            UI.toast("connecting to local LLM…");
            // Simulate connection for local LLM (no WebRTC)
            localLlmConnected = true;
            UI.setControls("connected");
            UI.toast("connected (local LLM)");
            UI.log("[sys] connected to local LLM");
            Speech.init();
            return;
        }

        if (!API_KEY) {
            UI.toast("Missing API key");
            return;
        }

        UI.setControls(false);
        UI.toast("connecting…");

        pc = new RTCPeerConnection({ 
            iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] 
        });

        remoteAudio = new Audio();
        remoteAudio.autoplay = true;
        
        pc.ontrack = (e) => {
            const [stream] = e.streams;
            remoteAudio.srcObject = stream;
            UI.log("[audio] remote track received");
            AudioMonitor.setup(stream);
        };

        dataChannel = pc.createDataChannel("oai-events");
        dataChannel.onopen = () => UI.log("[dc] open");
        dataChannel.onclose = () => UI.log("[dc] close");
        dataChannel.onerror = (e) => UI.log("[dc] error " + (e?.message || e));
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
                instructions: "You are a concise, friendly voice assistant. Keep replies short. The user is sending text messages only, not audio."
            })
        });

        if (!createSession.ok) { 
            UI.log("[err] session: " + (await createSession.text())); 
            UI.toast("session failed"); 
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
            return; 
        }

        const answerSdp = await sdpRes.text();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

        UI.setControls("connected");
        UI.toast("connected");
        UI.log("[sys] connected via WebRTC");
        
        Speech.init();
    };

    const sendText = (text) => {
        if (!isConnected()) return;
        const llmProvider = Storage.llmProvider;
        const localLlmEndpoint = Storage.localLlmEndpoint.trim() || "http://localhost:11434/api/generate";
        const modalities = TTSProvider.shouldUseOpenAIAudio() ? ["audio", "text"] : ["text"];
        const finalPrompt = `STRICT RULES - FOLLOW EXACTLY:
1. MAX 2 sentences. Never more.
2. ZERO emojis. Never use any emoji.
3. NO asterisks, NO *actions*, NO roleplay.
4. Plain text only. Direct answers.
5. Only discuss Jose Cuervo tequila.
6. Reply in same language as user.

Background: ${Summary.summary}

Question: ${text}

Answer (2 sentences max, no emoji):`;
        if (llmProvider === "local") {
            // Send to local LLM endpoint (Ollama format)
            UI.log("[you] " + text);
            UI.addExchange("user", text, 0, 0);
            UI.log("[local-llm] sending to " + localLlmEndpoint);

            fetch(localLlmEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: Storage.localLlmModel || "llama2",
                    prompt: finalPrompt,
                    stream: false
                })
            })
            .then(res => {
                if (!res.ok) {
                    throw new Error("HTTP " + res.status);
                }
                return res.json();
            })
            .then(data => {
                // Ollama returns { response: "..." }, other APIs might use { text: "..." }
                const assistantText = data.response || data.text || data.content || "";
                if (!assistantText) {
                    UI.log("[local-llm] empty response: " + JSON.stringify(data));
                    return;
                }
                UI.log("[assistant] " + assistantText);
                UI.addExchange("assistant", assistantText, 0, 0);
                if (TTSProvider.shouldUseSpeech()) {
                    const provider = TTSProvider.getProvider();
                    if (provider === "elevenlabs" && assistantText) {
                        TTSProvider.speakWithElevenLabs(assistantText);
                    } else if (provider === "browser" && assistantText) {
                        TTSProvider.speakWithBrowser(assistantText);
                    } else if (provider === "local" && assistantText) {
                        TTSProvider.speakWithLocalTTS(assistantText);
                    }
                }
            })
            .catch(e => {
                UI.log("[local-llm] error: " + e.message);
                if (e.message === "Failed to fetch") {
                    UI.log("[local-llm] Hint: Is Ollama running? Try: OLLAMA_ORIGINS=* ollama serve");
                }
            });
            return;
        }

        const messages = [
            {
                type: "conversation.item.create",
                item: { 
                    type: "message", 
                    role: "user", 
                    content: [{ type: "input_text", text: finalPrompt }] 
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
        Speech.stop();
        AudioMonitor.stop();
        TTSProvider.stop();

        try { dataChannel?.close(); } catch {}
        try { pc?.close(); } catch {}
        pc = null;
        dataChannel = null;
        remoteAudio = null;
        localLlmConnected = false;
        UI.setControls("idle");
        UI.toast("idle");
        UI.log("[sys] disconnected");
    };

    return {
        connect,
        sendText,
        hangup,
        isConnected
    };
})();