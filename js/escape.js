// XSS 转义：所有 innerHTML 拼接前先过一遍
window.escapeHtml = (function () {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  return function (v) {
    return String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => map[c]);
  };
})();
