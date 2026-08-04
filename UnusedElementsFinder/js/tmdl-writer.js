// Borra elementos (medidas/columnas) de sus archivos .tmdl originales.
//
// Trabaja sobre el texto crudo capturado en el momento del análisis
// (model.tableSources) y los rangos de línea que tmdl-parser.js calculó
// para cada elemento. Por eso, después de borrar, hay que volver a analizar
// antes de poder borrar de nuevo: los rangos de línea de lo que quedó sin
// tocar podrían haberse corrido si se borró algo antes en el mismo archivo.
window.UEF = window.UEF || {};

UEF.TmdlWriter = (function () {

  // Reconstruye el texto de un archivo quitando los rangos de línea
  // indicados (0-based, inclusive), preservando el estilo de fin de línea
  // (CRLF/LF) y si el archivo terminaba con salto de línea.
  function removeLineRanges(text, ranges) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingEol = /\r\n$|\r$|\n$/.test(text);
    const lines = text.split(/\r\n|\r|\n/);

    const remove = new Array(lines.length).fill(false);
    for (const [start, end] of ranges) {
      for (let i = Math.max(0, start); i <= end && i < lines.length; i++) remove[i] = true;
    }

    const kept = lines.filter((_, i) => !remove[i]);
    let out = kept.join(eol);
    if (hadTrailingEol && !/\r\n$|\r$|\n$/.test(out)) out += eol;
    return out;
  }

  // elements: elementos del modelo (con .table, .startLine, .endLine) a
  // borrar. Devuelve { deletedCount, tables: [nombresDeTabla] }.
  async function deleteElements(elements, model) {
    if (!model.writable) {
      throw new Error('Esta carpeta se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    if (!elements.length) return { deletedCount: 0, tables: [] };

    const byTable = new Map(); // tabla -> [elementos]
    for (const el of elements) {
      if (!byTable.has(el.table)) byTable.set(el.table, []);
      byTable.get(el.table).push(el);
    }

    const touchedTables = [];
    for (const [table, els] of byTable) {
      const source = model.tableSources.get(table);
      if (!source || !source.file || !source.file.handle) {
        throw new Error(`No se encontró el archivo de origen de la tabla "${table}".`);
      }
      const ranges = els
        .filter(el => Number.isInteger(el.startLine) && Number.isInteger(el.endLine))
        .map(el => [el.startLine, el.endLine]);
      if (!ranges.length) continue;

      const newText = removeLineRanges(source.rawText, ranges);
      const writable = await source.file.handle.createWritable();
      await writable.write(newText);
      await writable.close();
      touchedTables.push(table);
    }

    return { deletedCount: elements.length, tables: touchedTables };
  }

  return { removeLineRanges, deleteElements };
})();
