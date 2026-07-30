// Orquesta el análisis completo: arma el modelo, el grafo de dependencias,
// escanea el reporte, y clasifica los elementos en:
//  - Sección 1: elementos que no se usan (sin ninguna referencia, directa
//    ni indirecta).
//  - Sección 2: elementos referenciados únicamente dentro de otros
//    elementos que no se usan (huérfanos "de segundo grado").
window.UEF = window.UEF || {};

UEF.Analyzer = (function () {

  async function readTmdlFiles(files) {
    const texts = await Promise.all(files.map(f => f.text()));
    return texts.map(t => UEF.TmdlParser.parseTable(t));
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

  async function analyze(semanticModelInput, reportInput) {
    const parsedTables = await readTmdlFiles(semanticModelInput.tableFiles);
    const relationshipsText = semanticModelInput.relationshipsFile
      ? await semanticModelInput.relationshipsFile.text()
      : '';
    const relationships = UEF.TmdlParser.parseRelationships(relationshipsText);
    const model = UEF.ModelBuilder.build(parsedTables, relationships);
    const graph = UEF.DaxReferences.buildGraph(model);

    const usedDirect = new Map(); // id -> Set(contexto)
    function markUsed(id, context) {
      if (!id) return;
      if (!usedDirect.has(id)) usedDirect.set(id, new Set());
      usedDirect.get(id).add(context);
    }

    // 1) Uso en visuales/páginas/filtros/bookmarks del .Report
    const jsonFiles = await readJsonFiles(reportInput.jsonFiles);
    const usages = UEF.ReportScanner.scan(jsonFiles);
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

    // 4) Cierre transitivo: todo lo que un elemento usado necesita (vía DAX
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

    // 5) Clasificación final
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
