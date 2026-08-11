// Detecta páginas ocultas del reporte y clasifica cada una en:
//  - "en uso": tiene un rol especial (Drillthrough/Tooltip) o algo la
//    referencia (botón de navegación, bookmark, u otra cosa detectada de
//    forma genérica).
//  - "candidata a borrar": está oculta, no tiene rol especial y no se
//    encontró ninguna referencia hacia ella en el resto del reporte.
//
// Las páginas visibles ("AlwaysVisible" o sin la propiedad) no entran en
// este análisis: son alcanzables por el usuario con solo hacer clic en la
// pestaña, así que el concepto de "obsoleta" no aplica.
window.UEF = window.UEF || {};

UEF.PageScanner = (function () {

  function unquoteLiteral(value) {
    if (typeof value !== 'string') return value;
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1);
    }
    return value;
  }

  // Recorre un nodo JSON buscando:
  //  1) el patrón estructural de un botón/imagen con "Ir a página"
  //     (visualLink con type 'PageNavigation' + navigationSection).
  //  2) cualquier string suelto que coincida exactamente con el nombre
  //     interno de una página conocida (heurística genérica: los nombres
  //     internos son ids opacos, así que un match exacto es confiable).
  function walk(node, ctx) {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, ctx);
      return;
    }
    if (node && typeof node === 'object') {
      const type = node?.properties?.type?.expr?.Literal?.Value;
      const navSection = node?.properties?.navigationSection?.expr?.Literal?.Value;
      if (type === "'PageNavigation'" && typeof navSection === 'string') {
        const target = unquoteLiteral(navSection);
        if (ctx.pageNames.has(target)) {
          const sourceLabel = ctx.sourcePageDisplayName
            ? `botón de navegación en la página "${ctx.sourcePageDisplayName}"`
            : `botón de navegación (${ctx.relativePath})`;
          ctx.addHit(target, sourceLabel, ctx.relativePath);
        }
      }
      for (const key of Object.keys(node)) walk(node[key], ctx);
      return;
    }
    if (typeof node === 'string' && ctx.pageNames.has(node) && node !== ctx.ownPageName) {
      ctx.addHit(node, `referenciada en ${ctx.relativePath}`, ctx.relativePath);
    }
  }

  // jsonFiles: [{relativePath, json}] — todos los .json bajo definition/
  // (igual que usa report-scanner.js).
  function analyze(jsonFiles) {
    const pagesJsonEntry = jsonFiles.find(f => /(^|\/)pages\/pages\.json$/i.test(f.relativePath));
    const pageOrder = pagesJsonEntry?.json?.pageOrder || [];
    const activePageName = pagesJsonEntry?.json?.activePageName || null;

    const pageMetaEntries = jsonFiles.filter(f => /(^|\/)pages\/[^/]+\/page\.json$/i.test(f.relativePath));
    const pagesByName = new Map();
    for (const entry of pageMetaEntries) {
      const j = entry.json || {};
      pagesByName.set(j.name, {
        name: j.name,
        displayName: j.displayName || j.name,
        isHidden: j.visibility === 'HiddenInViewMode',
        specialType: j.type === 'Drillthrough' || j.type === 'Tooltip' ? j.type : (j.pageBinding ? 'Drillthrough' : null),
        relativePath: entry.relativePath,
      });
    }
    // Por si algún nombre aparece en pageOrder pero no tiene page.json propio
    // (no debería pasar, pero no confiamos ciegamente en el registro).
    for (const name of pageOrder) {
      if (!pagesByName.has(name)) {
        pagesByName.set(name, { name, displayName: name, isHidden: false, specialType: null, relativePath: null });
      }
    }

    const pageNames = new Set(pagesByName.keys());
    const hits = new Map(); // pageName -> Map(relativePath -> label)  (dedupe por archivo)

    function addHit(pageName, label, relativePath) {
      if (!hits.has(pageName)) hits.set(pageName, new Map());
      const m = hits.get(pageName);
      if (!m.has(relativePath)) m.set(relativePath, label);
    }

    for (const file of jsonFiles) {
      // No nos interesa que el propio page.json de una página "se
      // autorreferencie" (su campo "name" es igual a sí mismo).
      const ownMatch = file.relativePath.match(/(^|\/)pages\/([^/]+)\/page\.json$/i);
      const ownPageName = ownMatch ? ownMatch[2] : null;
      // El registro pages.json no cuenta como "uso", es solo el índice.
      if (/(^|\/)pages\/pages\.json$/i.test(file.relativePath)) continue;

      // Para dar una etiqueta linda a los botones de navegación, resolvemos
      // desde qué página (por displayName) sale el visual.
      const visualPageMatch = file.relativePath.match(/(^|\/)pages\/([^/]+)\/visuals\//i);
      const sourcePageDisplayName = visualPageMatch ? (pagesByName.get(visualPageMatch[2])?.displayName || null) : null;

      // Bookmarks: etiqueta más linda que "referenciada en <archivo>".
      if (/\.bookmark\.json$/i.test(file.relativePath) && file.json?.explorationState) {
        const es = file.json.explorationState;
        const bookmarkName = file.json.displayName || file.json.name || 'bookmark';
        const candidates = new Set();
        if (typeof es.activeSection === 'string') candidates.add(es.activeSection);
        if (es.sections && typeof es.sections === 'object') {
          for (const k of Object.keys(es.sections)) candidates.add(k);
        }
        for (const pn of candidates) {
          if (pageNames.has(pn)) addHit(pn, `bookmark "${bookmarkName}"`, file.relativePath);
        }
      }

      walk(file.json, {
        pageNames,
        ownPageName,
        relativePath: file.relativePath,
        sourcePageDisplayName,
        addHit,
      });
    }

    const candidates = [];
    const inUse = [];
    for (const page of pagesByName.values()) {
      if (!page.isHidden) continue; // las visibles no entran en este análisis
      const refs = [...(hits.get(page.name)?.values() || [])];
      if (page.specialType) {
        inUse.push({ ...page, reason: page.specialType, references: refs });
      } else if (refs.length > 0) {
        inUse.push({ ...page, reason: 'Referenciada', references: refs });
      } else {
        candidates.push({ ...page, references: [] });
      }
    }

    return { pageOrder, activePageName, pagesByName, candidates, inUse };
  }

  return { analyze };
})();
