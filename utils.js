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

  return { $, escapeHtml };
})();
