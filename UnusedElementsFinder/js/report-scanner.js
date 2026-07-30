// Escanea los archivos JSON de la carpeta .Report (páginas, visuales,
// filtros, bookmarks) buscando toda referencia a un campo del modelo
// ("Entity"/"Property"), incluyendo alias de tabla usados en filtros
// avanzados (bloques "From"/"Source").
window.UEF = window.UEF || {};

UEF.ReportScanner = (function () {

  // Recorre recursivamente un nodo JSON, resolviendo alias de tabla
  // definidos en bloques "From" a medida que se desciende por el árbol.
  function walk(node, aliasMap, onField) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, aliasMap, onField);
      return;
    }
    if (node && typeof node === 'object') {
      let localAlias = aliasMap;
      if (Array.isArray(node.From)) {
        localAlias = new Map(aliasMap);
        for (const f of node.From) {
          if (f && f.Name && f.Entity) localAlias.set(f.Name, f.Entity);
        }
      }

      if (typeof node.Property === 'string' && node.Expression && typeof node.Expression === 'object' && node.Expression.SourceRef) {
        const sr = node.Expression.SourceRef;
        const entity = sr.Entity || (sr.Source ? localAlias.get(sr.Source) : null);
        if (entity) onField(entity, node.Property);
      }

      for (const key of Object.keys(node)) {
        if (key === 'From') continue;
        walk(node[key], localAlias, onField);
      }
    }
  }

  function classifyContext(relativePath, json, pageDisplayNames) {
    const norm = relativePath.replace(/\\/g, '/');
    let m = norm.match(/pages\/([^/]+)\/visuals\/[^/]+\/visual\.json$/i);
    if (m) {
      const pageName = pageDisplayNames.get(m[1]) || m[1];
      const visualType = (json.visual && json.visual.visualType) || 'visual';
      return `Página "${pageName}" — visual (${visualType})`;
    }
    m = norm.match(/pages\/([^/]+)\/page\.json$/i);
    if (m) {
      const pageName = pageDisplayNames.get(m[1]) || m[1];
      return `Página "${pageName}" — filtro de página`;
    }
    if (/(^|\/)report\.json$/i.test(norm)) {
      return 'Filtro de nivel de reporte';
    }
    m = norm.match(/bookmarks\/[^/]+\.bookmark\.json$/i);
    if (m) {
      const label = json.displayName || 'sin nombre';
      return `Bookmark "${label}"`;
    }
    return `Archivo: ${norm}`;
  }

  // files: array de {relativePath, json}
  // Devuelve array de {entity, property, context}
  function scan(files) {
    const pageDisplayNames = new Map();
    for (const f of files) {
      const norm = f.relativePath.replace(/\\/g, '/');
      const m = norm.match(/pages\/([^/]+)\/page\.json$/i);
      if (m && f.json && f.json.displayName) {
        pageDisplayNames.set(m[1], f.json.displayName);
      }
    }

    const usages = [];
    for (const f of files) {
      const context = classifyContext(f.relativePath, f.json, pageDisplayNames);
      walk(f.json, new Map(), (entity, property) => {
        usages.push({ entity, property, context });
      });
    }
    return usages;
  }

  return { scan };
})();
