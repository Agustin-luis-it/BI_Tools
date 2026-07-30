// Funciones de utilidad compartidas por el resto de los módulos.
window.UEF = window.UEF || {};

UEF.Utils = (function () {

  function unquoteName(token) {
    if (token == null) return token;
    const t = token.trim();
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
      return t.slice(1, -1).replace(/''/g, "'");
    }
    return t;
  }

  // Separa "Tabla.Columna" (o 'Tabla con espacios'.'Columna con espacios')
  function parseQualifiedRef(text) {
    const m = text.trim().match(/^(?:'((?:[^']|'')+)'|([^.]+))\.(?:'((?:[^']|'')+)'|(.+))$/);
    if (!m) return null;
    const table = unquoteName(m[1] !== undefined ? `'${m[1]}'` : m[2]);
    const column = unquoteName(m[3] !== undefined ? `'${m[3]}'` : m[4]);
    return { table, column };
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvCell(value) {
    const s = value == null ? '' : String(value);
    if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  return { unquoteName, parseQualifiedRef, escapeHtml, download, csvCell };
})();
