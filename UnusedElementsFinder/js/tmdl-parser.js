// Parser de archivos .tmdl (formato de texto plano de Power BI / TMDL).
// Es un parser basado en indentación (tabs), no un parser TMDL completo,
// pero cubre lo necesario para inventariar tablas, columnas, columnas
// calculadas, medidas, jerarquías y relaciones.
window.UEF = window.UEF || {};

UEF.TmdlParser = (function () {
  const { unquoteName, parseQualifiedRef } = UEF.Utils;

  function indentOf(line) {
    let n = 0;
    while (n < line.length && line[n] === '\t') n++;
    return n;
  }

  function parseProperties(propLines) {
    const props = {};
    for (const l of propLines) {
      const t = l.trim();
      if (!t || t.startsWith('annotation ')) continue;
      if (t === 'isHidden') { props.isHidden = true; continue; }
      if (t === 'isNameInferred') continue;
      const m = t.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (m) props[m[1]] = m[2].trim();
    }
    return props;
  }

  // Parsea un archivo tabla completo: table X ... column/measure/hierarchy ...
  function parseTable(text) {
    const lines = text.split(/\r?\n/);
    let tableName = null;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === '') { i++; continue; }
      if (indentOf(line) === 0 && /^table\s+/.test(trimmed)) {
        tableName = unquoteName(trimmed.replace(/^table\s+/, ''));
        i++;
        break;
      }
      i++;
    }

    const rawElements = [];
    const hierarchyColumnRefs = [];

    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { i++; continue; }
      const indent = indentOf(line);
      if (indent !== 1) { i++; continue; }

      const trimmed = line.trim();
      const memberMatch = trimmed.match(/^(column|measure|hierarchy|partition|calculationGroup)\s+(.*)$/);
      if (!memberMatch) { i++; continue; }

      const kind = memberMatch[1];
      const rest = memberMatch[2];

      let j = i + 1;
      const bodyLines = [];
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') { bodyLines.push(l); j++; continue; }
        if (indentOf(l) <= 1) break;
        bodyLines.push(l);
        j++;
      }

      if (kind === 'column' || kind === 'measure') {
        const eqIdx = rest.indexOf('=');
        let namePart, exprStart;
        if (eqIdx === -1) {
          namePart = rest.trim();
          exprStart = null;
        } else {
          namePart = rest.slice(0, eqIdx).trim();
          exprStart = rest.slice(eqIdx + 1).trim();
        }
        const name = unquoteName(namePart);
        const isCalculated = kind === 'measure' || exprStart !== null;

        const exprLines = [];
        if (exprStart) exprLines.push(exprStart);
        const propLines = [];
        for (const l of bodyLines) {
          if (l.trim() === '') continue;
          const ind = indentOf(l);
          if (ind >= 3) exprLines.push(l.trim());
          else if (ind === 2) propLines.push(l);
        }
        const props = parseProperties(propLines);
        const expression = exprLines.length ? exprLines.join('\n') : null;

        rawElements.push({
          kind: kind === 'measure' ? 'measure' : (isCalculated ? 'calculatedColumn' : 'column'),
          name,
          expression,
          isHidden: !!props.isHidden,
          displayFolder: props.displayFolder || '',
          dataType: props.dataType || '',
          sourceColumn: props.sourceColumn || '',
          sortByColumn: props.sortByColumn ? unquoteName(props.sortByColumn) : null,
          // Rango de líneas (índices en el texto original, 0-based, inclusive)
          // que ocupa este elemento — incluye separadores en blanco previos al
          // siguiente miembro. Sirve para poder borrar el bloque del archivo
          // .tmdl original sin tocar el resto (ver js/tmdl-writer.js).
          startLine: i,
          endLine: j - 1,
        });
      } else if (kind === 'hierarchy') {
        for (const l of bodyLines) {
          const t = l.trim();
          const m = t.match(/^column:\s*(.+)$/);
          if (m) hierarchyColumnRefs.push(unquoteName(m[1]));
        }
      }

      i = j;
    }

    return { tableName, elements: rawElements, hierarchyColumnRefs };
  }

  // Parsea un archivo de rol de seguridad: definition/roles/*.tmdl
  // Extrae, por cada tablePermission, la tabla y la expresión DAX de filtro
  // (para poder detectar qué columnas usa esa regla de RLS).
  function parseRole(text) {
    const lines = text.split(/\r?\n/);
    let roleName = null;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === '') { i++; continue; }
      if (indentOf(line) === 0 && /^role\s+/.test(trimmed)) {
        roleName = unquoteName(trimmed.replace(/^role\s+/, ''));
        i++;
        break;
      }
      i++;
    }

    const tablePermissions = [];

    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { i++; continue; }
      if (indentOf(line) !== 1) { i++; continue; }

      const trimmed = line.trim();
      const m = trimmed.match(/^tablePermission\s+(.*)$/);
      if (!m) { i++; continue; }

      const rest = m[1];
      const eqIdx = rest.indexOf('=');
      let namePart, exprStart;
      if (eqIdx === -1) {
        namePart = rest.trim();
        exprStart = null;
      } else {
        namePart = rest.slice(0, eqIdx).trim();
        exprStart = rest.slice(eqIdx + 1).trim();
      }
      const table = unquoteName(namePart);

      let j = i + 1;
      const exprLines = [];
      if (exprStart) exprLines.push(exprStart);
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') { j++; continue; }
        if (indentOf(l) <= 1) break;
        exprLines.push(l.trim());
        j++;
      }

      tablePermissions.push({ table, expression: exprLines.length ? exprLines.join('\n') : null });
      i = j;
    }

    return { roleName, tablePermissions };
  }

  // Parsea definition/relationships.tmdl
  function parseRelationships(text) {
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const rels = [];
    let current = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (indentOf(line) === 0 && /^relationship\s+/.test(trimmed)) {
        if (current) rels.push(current);
        current = { name: trimmed.replace(/^relationship\s+/, ''), fromColumn: null, toColumn: null };
        continue;
      }
      if (!current) continue;
      let m = trimmed.match(/^fromColumn:\s*(.+)$/);
      if (m) { current.fromColumn = parseQualifiedRef(m[1]); continue; }
      m = trimmed.match(/^toColumn:\s*(.+)$/);
      if (m) { current.toColumn = parseQualifiedRef(m[1]); continue; }
    }
    if (current) rels.push(current);
    return rels;
  }

  return { parseTable, parseRelationships, parseRole };
})();
