// Borra elementos (medidas/columnas) de sus archivos .tmdl originales, y
// permite restaurarlos (papelera) reinsertando el bloque de texto exacto
// que se borró.
//
// El borrado trabaja sobre el texto crudo capturado en el momento del
// análisis (model.tableSources) y los rangos de línea que tmdl-parser.js
// calculó para cada elemento. Por eso, después de borrar, hay que volver a
// analizar antes de poder borrar de nuevo: los rangos de línea de lo que
// quedó sin tocar podrían haberse corrido si se borró algo antes en el
// mismo archivo. La restauración, en cambio, siempre relee el archivo tal
// como está en disco en ese momento, así que es segura sin importar qué más
// haya pasado mientras tanto.
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

  // Inserta de vuelta un bloque de texto (una medida/columna completa) justo
  // antes de la línea "partition ..." de la tabla — a TMDL no le importa el
  // orden de los miembros, así que no hace falta (ni conviene, por lo
  // frágil) intentar volver a la línea exacta de origen.
  function insertElementBlock(text, blockText) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingEol = /\r\n$|\r$|\n$/.test(text);
    const lines = text.split(/\r\n|\r|\n/);

    let insertAt = lines.findIndex(l => /^\tpartition\s/.test(l));
    if (insertAt === -1) {
      insertAt = lines.length;
      if (insertAt > 0 && lines[insertAt - 1] === '') insertAt -= 1;
    }

    const blockLines = blockText.split(/\r\n|\r|\n/);
    const newLines = [...lines.slice(0, insertAt), ...blockLines, '', ...lines.slice(insertAt)];
    let out = newLines.join(eol);
    if (hadTrailingEol && !/\r\n$|\r$|\n$/.test(out)) out += eol;
    return out;
  }

  // elements: elementos del modelo (con .table, .startLine, .endLine) a
  // borrar. Devuelve { deletedCount, tables, removedBlocks } — removedBlocks
  // trae, por cada elemento borrado, el texto exacto que ocupaba en el
  // archivo (para poder restaurarlo después).
  async function deleteElements(elements, model) {
    if (!model.writable) {
      throw new Error('Esta carpeta se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    if (!elements.length) return { deletedCount: 0, tables: [], removedBlocks: [] };

    const byTable = new Map(); // tabla -> [elementos]
    for (const el of elements) {
      if (!byTable.has(el.table)) byTable.set(el.table, []);
      byTable.get(el.table).push(el);
    }

    const touchedTables = [];
    const removedBlocks = [];
    for (const [table, els] of byTable) {
      const source = model.tableSources.get(table);
      if (!source || !source.file || !source.file.handle) {
        throw new Error(`No se encontró el archivo de origen de la tabla "${table}".`);
      }
      const validEls = els.filter(el => Number.isInteger(el.startLine) && Number.isInteger(el.endLine));
      if (!validEls.length) continue;

      const eol = source.rawText.includes('\r\n') ? '\r\n' : '\n';
      const lines = source.rawText.split(/\r\n|\r|\n/);
      for (const el of validEls) {
        const blockLines = lines.slice(el.startLine, el.endLine + 1);
        while (blockLines.length && blockLines[blockLines.length - 1].trim() === '') blockLines.pop();
        removedBlocks.push({ table, name: el.name, kind: el.kind, text: blockLines.join(eol) });
      }

      const ranges = validEls.map(el => [el.startLine, el.endLine]);
      const newText = removeLineRanges(source.rawText, ranges);
      const writable = await source.file.handle.createWritable();
      await writable.write(newText);
      await writable.close();
      touchedTables.push(table);
    }

    return { deletedCount: elements.length, tables: touchedTables, removedBlocks };
  }

  // Reinserta un bloque previamente borrado (ver removedBlocks arriba) en su
  // tabla de origen. Relee el archivo tal cual está ahora en disco, así que
  // es seguro llamarla en cualquier momento.
  async function restoreElement(block, model) {
    if (!model.writable) {
      throw new Error('Esta carpeta se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    const source = model.tableSources.get(block.table);
    if (!source || !source.file || !source.file.handle) {
      throw new Error(`No se encontró el archivo de origen de la tabla "${block.table}".`);
    }
    const currentFile = await source.file.handle.getFile();
    const currentText = await currentFile.text();
    const newText = insertElementBlock(currentText, block.text);
    const writable = await source.file.handle.createWritable();
    await writable.write(newText);
    await writable.close();
  }

  return { removeLineRanges, insertElementBlock, deleteElements, restoreElement };
})();
