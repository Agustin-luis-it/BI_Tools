// Orquesta el análisis completo: arma el modelo, el grafo de dependencias,
// escanea el reporte, y clasifica los elementos en:
//  - Sección 1: elementos que no se usan (sin ninguna referencia, directa
//    ni indirecta).
//  - Sección 2: elementos referenciados únicamente dentro de otros
//    elementos que no se usan (huérfanos "de segundo grado").
window.UEF = window.UEF || {};

UEF.Analyzer = (function () {

  // Lee cada archivo de tabla y devuelve, además del resultado parseado, un
  // mapa tabla -> {file, relativePath, rawText} para poder ubicar y borrar
  // el bloque de texto de un elemento más adelante (modo edición).
  async function readTmdlFiles(files) {
    const texts = await Promise.all(files.map(f => f.text()));
    const parsedTables = [];
    const sourceByTable = new Map();
    texts.forEach((t, idx) => {
      const parsed = UEF.TmdlParser.parseTable(t);
      parsedTables.push(parsed);
      if (parsed.tableName) {
        sourceByTable.set(parsed.tableName, {
          file: files[idx],
          relativePath: files[idx].relativePath || null,
          rawText: t,
        });
      }
    });
    return { parsedTables, sourceByTable };
  }

  async function readJsonFiles(fileEntries) {
    const out = [];
    for (const entry of fileEntries) {
      try {
        const text = await entry.file.text();
        out.push({ relativePath: entry.relativePath, json: JSON.parse(text) });
      } catch (e) {
        console.warn('No se pudo parsear JSON:', entry.relativePath, e);
      }
    }
    return out;
  }

  // reportInputs: array de carpetas .Report ya leídas (puede haber más de
  // una conectada al mismo modelo). Se combina el uso de todas, pero las
  // páginas se analizan una por una (cada .Report tiene su propio
  // pages.json) y quedan marcadas con a qué reporte pertenecen.
  async function analyze(semanticModelInput, reportInputs) {
    const { parsedTables, sourceByTable } = await readTmdlFiles(semanticModelInput.tableFiles);
    const relationshipsText = semanticModelInput.relationshipsFile
      ? await semanticModelInput.relationshipsFile.text()
      : '';
    const relationships = UEF.TmdlParser.parseRelationships(relationshipsText);
    const model = UEF.ModelBuilder.build(parsedTables, relationships, sourceByTable);
    model.writable = !!semanticModelInput.writable;
    const graph = UEF.DaxReferences.buildGraph(model);

    const usedDirect = new Map(); // id -> Set(contexto)
    function markUsed(id, context) {
      if (!id) return;
      if (!usedDirect.has(id)) usedDirect.set(id, new Set());
      usedDirect.get(id).add(context);
    }

    // 1) Uso en visuales/páginas/filtros/bookmarks de cada .Report
    const validReports = (reportInputs || []).filter(r => r.valid);
    const multiReport = validReports.length > 1;
    let usages = [];
    const pagesCandidates = [];
    const pagesInUse = [];
    for (const report of validReports) {
      const jsonFiles = await readJsonFiles(report.jsonFiles);
      const reportLabel = multiReport ? report.rootName : null;
      usages = usages.concat(UEF.ReportScanner.scan(jsonFiles, reportLabel));
      const pageResult = UEF.PageScanner.analyze(jsonFiles);
      for (const c of pageResult.candidates) pagesCandidates.push({ ...c, reportInput: report, reportLabel: report.rootName });
      for (const u of pageResult.inUse) pagesInUse.push({ ...u, reportInput: report, reportLabel: report.rootName });
    }
    const pages = {
      candidates: pagesCandidates,
      inUse: pagesInUse,
      writable: validReports.some(r => r.writable),
    };
    let unresolvedUsages = 0;
    for (const u of usages) {
      const id = UEF.ModelBuilder.resolveColumn(model, u.entity, u.property);
      if (id) markUsed(id, u.context);
      else unresolvedUsages++;
    }

    // 2) Uso como clave de relación
    for (const rel of model.relationships) {
      if (rel.fromColumn) {
        const id = UEF.ModelBuilder.resolveTableColumn(model, rel.fromColumn.table, rel.fromColumn.column);
        if (id) markUsed(id, `Relación "${rel.name}"`);
      }
      if (rel.toColumn) {
        const id = UEF.ModelBuilder.resolveTableColumn(model, rel.toColumn.table, rel.toColumn.column);
        if (id) markUsed(id, `Relación "${rel.name}"`);
      }
    }

    // 3) Uso como nivel de jerarquía
    for (const h of model.hierarchyUsage) {
      const id = UEF.ModelBuilder.resolveTableColumn(model, h.table, h.column);
      if (id) markUsed(id, 'Nivel de jerarquía');
    }

    // 4) Uso en roles de seguridad (RLS): cada tablePermission es una
    // expresión DAX de filtro sobre una tabla puntual; cualquier columna
    // (o medida) que mencione cuenta como usada.
    const roleTexts = await Promise.all((semanticModelInput.roleFiles || []).map(f => f.text()));
    const roles = roleTexts.map(t => UEF.TmdlParser.parseRole(t));
    for (const role of roles) {
      for (const tp of role.tablePermissions) {
        if (!tp.expression) continue;
        const refs = UEF.DaxReferences.extractReferences(tp.expression, model, tp.table);
        for (const id of refs) {
          markUsed(id, `Rol de seguridad "${role.roleName}" (tabla "${tp.table}")`);
        }
      }
    }

    // 5) Cierre transitivo: todo lo que un elemento usado necesita (vía DAX
    // o sortByColumn) también se considera usado.
    const alive = new Set(usedDirect.keys());
    const queue = [...alive];
    while (queue.length) {
      const cur = queue.pop();
      const deps = graph.outgoing.get(cur);
      if (!deps) continue;
      for (const d of deps) {
        if (!alive.has(d)) { alive.add(d); queue.push(d); }
      }
    }

    // 6) Clasificación final
    const section1 = [];
    const section2 = [];
    for (const el of model.elements) {
      if (alive.has(el.id)) continue;
      const incoming = graph.incoming.get(el.id);
      if (incoming && incoming.size > 0) {
        section2.push({
          element: el,
          referencedBy: [...incoming].map(id => model.elementsById.get(id)).filter(Boolean),
        });
      } else {
        section1.push({ element: el });
      }
    }

    const usedCount = model.elements.filter(el => alive.has(el.id)).length;

    return {
      model,
      graph,
      usedDirect,
      alive,
      section1,
      section2,
      pages,
      unresolvedUsages,
      totalUsages: usages.length,
      summary: {
        total: model.elements.length,
        used: usedCount,
        unusedSection1: section1.length,
        unusedSection2: section2.length,
      },
    };
  }

  return { analyze };
})();
