// Storage Module - LocalStorage abstraction
const Storage = (function() {
  const store = {
    get apiKey() { 
      return localStorage.getItem("OPENAI_API_KEY") || ""; 
    },
    set apiKey(v) { 
      localStorage.setItem("OPENAI_API_KEY", v); 
    },
    get model() { 
      return localStorage.getItem("REALTIME_MODEL") || "gpt-realtime"; 
    },
    set model(v) { 
      localStorage.setItem("REALTIME_MODEL", v); 
    },
    get voice() { 
      return localStorage.getItem("REALTIME_VOICE") || "alloy"; 
    },
    set voice(v) { 
      localStorage.setItem("REALTIME_VOICE", v); 
    }
  };

  return store;
})();