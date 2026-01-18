// Utils Module - DOM helpers and utilities
const Utils = (function() {
  const $ = (id) => document.getElementById(id);

  const escapeHtml = (s) => {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[c]));
  };

  // Safe module method call - returns undefined if module/method doesn't exist
  // Usage: Utils.safeCall(Speech, 'setAssistantSpeaking', true)
  const safeCall = (module, methodName, ...args) => {
    if (module && typeof module[methodName] === 'function') {
      return module[methodName](...args);
    }
    return undefined;
  };

  // Check if a module method exists
  // Usage: if (Utils.hasMethod(Speech, 'setAssistantSpeaking')) { ... }
  const hasMethod = (module, methodName) => {
    return module && typeof module[methodName] === 'function';
  };

  // Fetch with timeout using AbortController
  // Returns { response, controller } on success, throws on timeout/error
  // Usage: const { response } = await Utils.fetchWithTimeout(url, options, 15000);
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      return { response, controller };
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        throw new Error('fetch timeout');
      }
      throw e;
    }
  };

  // Clear a timeout/interval and return null (for assignment pattern)
  // Usage: timerId = Utils.clearTimer(timerId) or timerId = Utils.clearTimer(timerId, true)
  const clearTimer = (timerId, isInterval = false) => {
    if (timerId) {
      (isInterval ? clearInterval : clearTimeout)(timerId);
    }
    return null;
  };

  // Safely stop an audio element
  // Usage: Utils.stopAudio(audioElement)
  const stopAudio = (audio) => {
    if (!audio) return;
    try { audio.pause(); } catch {}
    try { audio.currentTime = 0; } catch {}
  };

  // Stop all tracks in a MediaStream
  // Usage: Utils.stopMediaStream(stream)
  const stopMediaStream = (stream) => {
    if (!stream) return;
    stream.getTracks().forEach(track => {
      try { track.stop(); } catch {}
    });
  };

  // Calculate exponential backoff delay
  // Usage: const delay = Utils.backoffDelay(attempts, 1000, 30000)
  const backoffDelay = (attempts, baseDelay, maxDelay) => {
    return Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
  };

  // Set element display with null check
  // Usage: Utils.setDisplay(element, true) or Utils.setDisplay(element, false, "block")
  const setDisplay = (element, show, displayType = "flex") => {
    if (element) {
      element.style.display = show ? displayType : "none";
    }
  };

  // Populate a dropdown with items
  // Usage: Utils.populateDropdown(selectEl, items, selectedValue, "Select option")
  // items can be array of strings or array of {id, name} objects
  const populateDropdown = (element, items, selectedValue, emptyLabel = "Select") => {
    if (!element) return;
    element.innerHTML = `<option value="">-- ${emptyLabel} --</option>`;
    items.forEach(item => {
      const option = document.createElement("option");
      const isObject = typeof item === 'object';
      option.value = isObject ? (item.id || item.value || item.name) : item;
      option.textContent = isObject ? (item.name || item.label || item.id) : item;
      element.appendChild(option);
    });
    if (selectedValue && items.some(i => (typeof i === 'object' ? (i.id || i.value || i.name) : i) === selectedValue)) {
      element.value = selectedValue;
    }
  };

  // Extract text from various API response formats
  // Usage: const text = Utils.extractText(data, ['response', 'text', 'content'])
  const extractText = (data, fields = ['response', 'text', 'content']) => {
    const raw = fields.reduce((acc, field) => acc || data[field], "") || "";
    return (typeof raw === 'string' ? raw : String(raw)).trim();
  };

  // Trim array to max length (removes from front)
  // Usage: Utils.trimArray(history, 6)
  const trimArray = (array, maxLength) => {
    while (array.length > maxLength) {
      array.shift();
    }
  };

  return {
    $, escapeHtml, safeCall, hasMethod, fetchWithTimeout,
    clearTimer, stopAudio, stopMediaStream, backoffDelay,
    setDisplay, populateDropdown, extractText, trimArray
  };
})();
