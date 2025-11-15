const WebRTC = (function() {
    let pc = null;
    let dataChannel = null;
    let remoteAudio = null;
    const textBuf = Object.create(null);

    const isConnected = () => {
        return dataChannel && dataChannel.readyState === "open";
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
            if (TTSProvider.shouldUseSpeech() && TTSProvider.getProvider() === "elevenlabs" && assistantText) {
                TTSProvider.speakWithElevenLabs(assistantText);
            }
            
            UI.log("[audio] response.done received");
        }
    };

    const connect = async () => {
        const API_KEY = Storage.apiKey.trim();
        const MODEL = Storage.model.trim();
        const VOICE = Storage.voice;
        
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

        const modalities = TTSProvider.shouldUseOpenAIAudio() ? ["audio", "text"] : ["text"];

        const finalPrompt = `
      FOR LLMs:
      You are a tequila expert and mixologist. You only want to talk about tequila and tequila-based drinks.
      You are hip and snarky, and sprinkle a bit of "Spanglish" into your replies.
      Keep your replies short and to the point, no more than 2-3 sentences.
      ONLY RESPOND IN ENGLISH. ONLY TALK ABOUT TEQUILA.
      -----
      THE USER SAID:
      ${text}
    `;

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