// UI Module - User interface operations
const UI = (function() {
  const { $, escapeHtml } = Utils;
  
  let totalIn = 0;
  let totalOut = 0;

  const log = (s) => {
    const logEl = $("log");
    logEl.textContent += s + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  };

  const toast = (s) => {
    $("status").textContent = s;
  };

  const setControls = (state) => {
    const connected = state === "connected";
    $("connect").disabled = connected;
    $("hangup").disabled = !connected;
    $("send").disabled = !connected;
    $("text").disabled = !connected;
  };

  const addExchange = (role, text, inTok, outTok) => {
    const row = document.createElement("div");
    row.className = "ex";
    
    const msg = document.createElement("div");
    msg.className = "msg";
    const displayRole = role === "assistant" ? Storage.voice : "you";
    msg.innerHTML = `<div><span class="role">${displayRole}:</span> ${escapeHtml(text || "")}</div>`;
    
    const tok = document.createElement("div");
    tok.className = "tok";
    const inS = inTok || 0;
    const outS = outTok || 0;
    tok.textContent = `in: ${inS} | out: ${outS} | turn: ${inS + outS}`;
    
    row.appendChild(msg);
    row.appendChild(tok);
    
    const exWrap = $("exchanges");
    exWrap.appendChild(row);
    exWrap.scrollTop = exWrap.scrollHeight;
    
    totalIn += inS;
    totalOut += outS;
    $("totIn").textContent = "In: " + totalIn;
    $("totOut").textContent = "Out: " + totalOut;
    $("totAll").textContent = "Total: " + (totalIn + totalOut);
  };

  const updateRateLimit = (limit) => {
    $("rate").textContent = `Rate remaining: ${limit.remaining}/${limit.limit}`;
  };

  const setTranscript = (text, state) => {
    const el = $("transcript");
    el.textContent = text;
    el.className = state || "";
  };

  return {
    log,
    toast,
    setControls,
    addExchange,
    updateRateLimit,
    setTranscript
  };
})();
