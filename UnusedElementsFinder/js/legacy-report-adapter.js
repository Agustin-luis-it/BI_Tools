// Adapta el formato "clásico" de .Report (un solo report.json con
// "sections"/"visualContainers", donde varios campos como config/filters/
// query vienen codificados como texto JSON dentro de un string, en vez de
// JSON anidado de verdad) para poder reutilizar, sin cambios, el mismo
// motor de análisis que ya usamos para el formato moderno (PBIR):
// report-scanner.js y page-scanner.js.
//
// AVISO: esto se construyó a partir del esquema clásico documentado en la
// comunidad de Power BI (el mismo que usaba el "Report/Layout" de los
// .pbix), sin un archivo real de este formato para probar. El escaneo de
// campos usados reutiliza el mismo buscador genérico "Entity/Property" que
// ya funciona en el formato moderno, así que debería ser confiable — pero
// no podemos confirmar con certeza cómo se marca una página como Tooltip o
// Drill through en este formato, así que esa detección específica no se
// hace acá (ver buildPseudoFiles). Probar con cuidado antes de confiar en
// el borrado.
window.UEF = window.UEF || {};

UEF.LegacyReportAdapter = (function () {

  // Recorre un valor cualquiera y, para cada string que "parece" JSON
  // (arranca con { o [ y cierra igual), intenta parsearlo — recursivamente,
  // por si el resultado tiene a su vez más strings-JSON adentro. Se usa
  // SOLO para el camino de análisis/escaneo: nunca hay que escribir de
  // vuelta al disco el resultado de esto (ver deleteSections/restoreSection,
  // que trabajan sobre una relectura del archivo sin desempaquetar).
  function deepParseStringifiedJson(node) {
    if (Array.isArray(node)) {
      return node.map(deepParseStringifiedJson);
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) out[key] = deepParseStringifiedJson(node[key]);
      return out;
    }
    if (typeof node === 'string') {
      const trimmed = node.trim();
      const looksLikeJson = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
      if (!looksLikeJson) return node;
      try {
        return deepParseStringifiedJson(JSON.parse(trimmed));
      } catch (e) {
        return node;
      }
    }
    return node;
  }

  // Arma, a partir de un report.json ya "desempaquetado", una lista de
  // pseudo-archivos con la misma forma de rutas que usa el formato moderno
  // (pages/<id>/page.json, pages/<id>/visuals/<id>/visual.json) para que
  // report-scanner.js y page-scanner.js —que buscan por forma/estructura,
  // no por nombre de archivo específico— los puedan procesar sin cambios.
  function buildPseudoFiles(unpackedReport) {
    const files = [];
    const sections = Array.isArray(unpackedReport.sections) ? unpackedReport.sections : [];

    sections.forEach((section, sIdx) => {
      const pageId = section.name || `section_${sIdx}`;
      const isHidden = section.visibility === 1 || section.visibility === 'HiddenInViewMode';
      files.push({
        relativePath: `pages/${pageId}/page.json`,
        json: {
          name: pageId,
          displayName: section.displayName || pageId,
          // Formato clásico: 1 = oculta, ausente/0 = visible. No hay (que
          // sepamos con certeza) un equivalente confiable a "type":
          // "Drillthrough"/"Tooltip" — por eso no se completa acá; una
          // página oculta de ese tipo puede aparecer como candidata a
          // borrar si nada más la referencia. Revisar con criterio.
          visibility: isHidden ? 'HiddenInViewMode' : 'AlwaysVisible',
          filters: section.filters,
          config: section.config,
        },
      });

      const visualContainers = Array.isArray(section.visualContainers) ? section.visualContainers : [];
      visualContainers.forEach((vc, vIdx) => {
        const cfg = vc.config || {};
        const visualId = cfg.name || `${pageId}_visual_${vIdx}`;
        files.push({
          relativePath: `pages/${pageId}/visuals/${visualId}/visual.json`,
          json: {
            name: visualId,
            // "singleVisual" tiene el visualType (para la etiqueta linda de
            // contexto) y las referencias a campos/botones de navegación.
            // "rawConfig" repite todo el config por si algo relevante
            // quedó fuera de singleVisual en este formato.
            visual: cfg.singleVisual || cfg,
            rawConfig: cfg,
            filters: vc.filters,
            query: vc.query,
          },
        });
      });
    });

    return files;
  }

  // Lee el report.json actual, arma los pseudo-archivos para análisis, y
  // de paso devuelve el objeto ya desempaquetado (no usar este objeto para
  // escribir de vuelta al disco).
  async function readAndUnpack(reportInput) {
    const text = await reportInput.legacyReportFile.text();
    const raw = JSON.parse(text);
    const unpacked = deepParseStringifiedJson(raw);
    return { jsonFiles: buildPseudoFiles(unpacked) };
  }

  // Borra secciones (páginas) completas del report.json — a diferencia del
  // formato moderno, acá no hay carpetas: es un splice sobre el array
  // "sections" del único archivo, reescribiéndolo entero. Trabaja siempre
  // sobre una relectura fresca del archivo tal cual está en disco (con los
  // campos config/filters todavía como string), nunca sobre la versión
  // "desempaquetada" de arriba.
  async function deleteSections(sectionNames, reportInput) {
    if (!reportInput.writable) {
      throw new Error('Esta carpeta .Report se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    if (!reportInput.legacyReportFile || !reportInput.legacyReportFile.handle) {
      throw new Error('No se encontró report.json.');
    }
    if (!sectionNames.length) return { deletedCount: 0, snapshots: [] };

    const currentText = await reportInput.legacyReportFile.handle.getFile().then(f => f.text());
    const json = JSON.parse(currentText);
    const removed = new Set(sectionNames);
    const sections = Array.isArray(json.sections) ? json.sections : [];

    const snapshots = [];
    const kept = [];
    sections.forEach((section, idx) => {
      if (removed.has(section.name)) {
        snapshots.push({ sectionName: section.name, section, originalIndex: idx });
      } else {
        kept.push(section);
      }
    });
    json.sections = kept;

    const writable = await reportInput.legacyReportFile.handle.createWritable();
    await writable.write(JSON.stringify(json, null, 2));
    await writable.close();

    return { deletedCount: snapshots.length, snapshots };
  }

  // Reinserta una sección previamente borrada (ver deleteSections arriba),
  // lo más cerca posible de su posición original.
  async function restoreSection(snapshot, reportInput) {
    if (!reportInput.writable) {
      throw new Error('Esta carpeta .Report se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    if (!reportInput.legacyReportFile || !reportInput.legacyReportFile.handle) {
      throw new Error('No se encontró report.json.');
    }
    const currentText = await reportInput.legacyReportFile.handle.getFile().then(f => f.text());
    const json = JSON.parse(currentText);
    const sections = Array.isArray(json.sections) ? json.sections : [];
    const insertAt = Number.isInteger(snapshot.originalIndex) && snapshot.originalIndex >= 0
      ? Math.min(snapshot.originalIndex, sections.length)
      : sections.length;
    sections.splice(insertAt, 0, snapshot.section);
    json.sections = sections;

    const writable = await reportInput.legacyReportFile.handle.createWritable();
    await writable.write(JSON.stringify(json, null, 2));
    await writable.close();
  }

  return { deepParseStringifiedJson, buildPseudoFiles, readAndUnpack, deleteSections, restoreSection };
})();
