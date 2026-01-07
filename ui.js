// UI Module - User interface operations
const UI = (function() {
  const { $, escapeHtml } = Utils;

  let totalIn = 0;
  let totalOut = 0;

  const log = (s) => {
    const logEl = $("log");
    if (logEl) {
      logEl.textContent += s + "\n";
      logEl.scrollTop = logEl.scrollHeight;
    }
  };

  const toast = (s) => {
    const statusEl = $("status");
    if (statusEl) {
      statusEl.textContent = s;
      statusEl.className = "status-badge" + (s === "connected" ? " connected" : "");
    }
  };

  const setControls = (state) => {
    const connected = state === "connected";
    const connect = $("connect");
    const hangup = $("hangup");
    const send = $("send");
    const text = $("text");
    const listen = $("listen");

    if (connect) connect.disabled = connected;
    if (hangup) hangup.disabled = !connected;
    if (send) send.disabled = !connected;
    if (text) text.disabled = !connected;
    if (listen) listen.disabled = !connected;
  };

  const addExchange = (role, text, inTok, outTok) => {
    const exWrap = $("exchanges");
    if (!exWrap) return;

    // Remove empty state if present
    const emptyState = exWrap.querySelector(".empty-state");
    if (emptyState) {
      emptyState.remove();
    }

    const row = document.createElement("div");
    row.className = "ex" + (role === "user" ? " user" : "");

    const msg = document.createElement("div");
    msg.className = "msg";
    const displayRole = role === "assistant" ? "assistant" : "you";
    const roleClass = role === "assistant" ? "assistant" : "user";
    msg.innerHTML = `<span class="role ${roleClass}">${displayRole}</span>${escapeHtml(text || "")}`;

    const tok = document.createElement("div");
    tok.className = "tok";
    const inS = inTok || 0;
    const outS = outTok || 0;
    tok.textContent = `in: ${inS} | out: ${outS} | turn: ${inS + outS}`;

    row.appendChild(msg);
    row.appendChild(tok);

    exWrap.prepend(row);
    exWrap.scrollTop = 0;

    totalIn += inS;
    totalOut += outS;
    const totInEl = $("totIn");
    const totOutEl = $("totOut");
    if (totInEl) totInEl.textContent = totalIn;
    if (totOutEl) totOutEl.textContent = totalOut;
  };

  const updateRateLimit = (limit) => {
    // Rate limit display removed from UI
  };

  const setTranscript = (text, state) => {
    const el = $("transcript");
    if (el) {
      el.textContent = text;
      el.className = "transcript-area" + (state ? " " + state : "");
    }
  };

  // Dynamic provider field visibility
  const updateProviderFields = () => {
    const llmProvider = $("llmProvider");
    const ttsProvider = $("ttsProvider");

    if (llmProvider) {
      const llmOpenAI = $("llm-openai-fields");
      const llmLocal = $("llm-local-fields");
      if (llmOpenAI) llmOpenAI.style.display = llmProvider.value === "openai" ? "flex" : "none";
      if (llmLocal) llmLocal.style.display = llmProvider.value === "local" ? "flex" : "none";
    }

    if (ttsProvider) {
      const ttsElevenLabs = $("tts-elevenlabs-fields");
      const ttsLocal = $("tts-local-fields");
      if (ttsElevenLabs) ttsElevenLabs.style.display = ttsProvider.value === "elevenlabs" ? "flex" : "none";
      if (ttsLocal) ttsLocal.style.display = ttsProvider.value === "local" ? "flex" : "none";
    }
  };

  return {
    log,
    toast,
    setControls,
    addExchange,
    updateRateLimit,
    setTranscript,
    updateProviderFields
  };
})();
