// WebRTC Module with Audio Level Detection
const WebRTC = (function() {
  let pc = null;
  let dataChannel = null;
  let remoteAudio = null;
  const textBuf = Object.create(null);
  
  // Audio detection
  let audioContext = null;
  let analyser = null;
  let source = null;
  let audioLevelCheckInterval = null;
  let silenceStartTime = 0;
  let isReceivingAudio = false;
  const AUDIO_SILENCE_THRESHOLD = 500; // 500ms of silence after audio = done speaking

  const isConnected = () => {
    return dataChannel && dataChannel.readyState === "open";
  };

  // Setup Web Audio API for level detection
  const setupAudioAnalyser = (stream) => {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      
      startAudioLevelMonitor();
      UI.log("[audio] analyser setup complete");
    } catch (e) {
      UI.log("[audio] analyser setup failed: " + e.message);
    }
  };

  // Monitor audio levels to detect when assistant is actually speaking
  const startAudioLevelMonitor = () => {
    if (audioLevelCheckInterval) return;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let wasPlayingAudio = false;
    
    audioLevelCheckInterval = setInterval(() => {
      if (!analyser) return;
      
      analyser.getByteFrequencyData(dataArray);
      
      // Calculate average volume
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const isPlayingAudio = average > 5; // Threshold for "audio is playing"
      
      if (isPlayingAudio && !wasPlayingAudio) {
        // Audio just started
        wasPlayingAudio = true;
        silenceStartTime = 0;
        if (!Speech.assistantSpeaking) {
          Speech.setAssistantSpeaking(true);
          UI.log("[audio] detected audio start (level: " + average.toFixed(1) + ")");
        }
      } else if (!isPlayingAudio && wasPlayingAudio) {
        // Audio just stopped - start silence timer
        if (silenceStartTime === 0) {
          silenceStartTime = Date.now();
        }
        
        // Check if we've been silent long enough
        const silenceDuration = Date.now() - silenceStartTime;
        if (silenceDuration > AUDIO_SILENCE_THRESHOLD) {
          wasPlayingAudio = false;
          silenceStartTime = 0;
          if (Speech.assistantSpeaking) {
            Speech.setAssistantSpeaking(false);
            UI.log("[audio] detected audio end (silence: " + silenceDuration + "ms)");
          }
        }
      }
    }, 50); // Check every 50ms for responsive detection
  };

  const stopAudioLevelMonitor = () => {
    if (audioLevelCheckInterval) {
      clearInterval(audioLevelCheckInterval);
      audioLevelCheckInterval = null;
    }
    if (source) {
      source.disconnect();
      source = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }
    analyser = null;
  };

  const handleMessage = (e) => {
    let msg;
    try { 
      msg = JSON.parse(e.data); 
    } catch { 
      return; 
    }
    
    const t = msg.type;

    // Track when we're receiving audio
    if (t === "response.audio.delta" || t === "response.audio_transcript.delta") {
      isReceivingAudio = true;
    }

    // Buffer text responses
    if (t === "response.output_text.delta" || t === "response.text.delta") {
      const id = msg.response_id || msg.response?.id || "r";
      textBuf[id] = (textBuf[id] || "") + (msg.delta || "");
      return;
    }

    // Handle various content completion types
    if (t === "response.content_part.done") {
      const id = msg.response_id || "r";
      if (msg.part?.type === "text") {
        textBuf[id] = (textBuf[id] || "") + (msg.part.text || "");
      } else if (msg.part?.type === "audio" && msg.part?.transcript) {
        textBuf[id] = (textBuf[id] || "") + (msg.part.transcript || "");
      }
      return;
    }

    // Handle output items
    if (t === "response.output_item.done" && msg.item?.type === "message" && msg.item?.role === "assistant") {
      const id = msg.response_id || "r";
      const texts = (msg.item.content || []).filter(x => x.type === "text").map(x => x.text || "");
      if (texts.length) textBuf[id] = (textBuf[id] || "") + texts.join(" ");
      return;
    }

    // Handle conversation items
    if (t === "conversation.item.created" && msg.item?.type === "message" && msg.item?.role === "assistant") {
      const id = msg.response_id || "r";
      const texts = (msg.item.content || []).filter(x => x.type === "text").map(x => x.text || "");
      if (texts.length) textBuf[id] = (textBuf[id] || "") + texts.join(" ");
      return;
    }

    // Handle rate limits
    if (t === "rate_limits.updated") {
      const lim = msg.rate_limits?.find?.(x => x.name === "tokens");
      if (lim) UI.updateRateLimit(lim);
      return;
    }

    // Handle response completion
    if (t === "response.done" && msg.response) {
      const id = msg.response.id || msg.response_id || "r";
      const assistantText = (textBuf[id] || "").trim();
      delete textBuf[id];

      const usage = msg.response.usage || msg.usage || {};
      const inTok = usage.input_tokens ?? usage.input_token_details?.text_tokens ?? 0;
      const outTok = usage.output_tokens ?? usage.output_token_details?.text_tokens ?? 0;

      if (assistantText) UI.log("[assistant] " + assistantText);
      UI.addExchange("assistant", assistantText, inTok, outTok);
      
      isReceivingAudio = false;
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

    // Setup WebRTC
    pc = new RTCPeerConnection({ 
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] 
    });

    // Setup remote audio
    remoteAudio = new Audio();
    remoteAudio.autoplay = true;
    
    pc.ontrack = (e) => {
      const [stream] = e.streams;
      remoteAudio.srcObject = stream;
      UI.log("[audio] remote track received");
      
      // Setup audio analyser for level detection
      setupAudioAnalyser(stream);
    };

    // Setup data channel
    dataChannel = pc.createDataChannel("oai-events");
    dataChannel.onopen = () => UI.log("[dc] open");
    dataChannel.onclose = () => UI.log("[dc] close");
    dataChannel.onerror = (e) => UI.log("[dc] error " + (e?.message || e));
    dataChannel.onmessage = handleMessage;

    // Create offer
    const offer = await pc.createOffer({ 
      offerToReceiveAudio: true,
      offerToReceiveVideo: false 
    });
    await pc.setLocalDescription(offer);

    // Create session
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

    // Exchange SDP
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
        response: { modalities: ["audio", "text"] }
      }
    ];

    messages.forEach(msg => dataChannel.send(JSON.stringify(msg)));
    UI.log("[you] " + text);
    UI.addExchange("user", text, 0, 0);
  };

  const hangup = () => {
    Speech.stop();
    stopAudioLevelMonitor();
    
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