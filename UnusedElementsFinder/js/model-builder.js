// Construye el índice del modelo semántico a partir de las tablas parseadas:
// listas de elementos + mapas de búsqueda rápida por tabla/nombre.
window.UEF = window.UEF || {};

UEF.ModelBuilder = (function () {

  function build(parsedTables, relationships) {
    const elements = [];
    const columnsByTable = new Map();   // tabla -> Map(nombreColumna -> elemento)
    const measuresByTable = new Map();  // tabla -> Map(nombreMedida -> elemento)
    const measuresByName = new Map();   // nombreMedida -> elemento (global, únicos en el modelo)
    const elementsById = new Map();
    const hierarchyUsage = []; // {table, column}

    for (const pt of parsedTables) {
      if (!pt.tableName) continue;
      const colMap = new Map();
      const measMap = new Map();
      columnsByTable.set(pt.tableName, colMap);
      measuresByTable.set(pt.tableName, measMap);

      for (const el of pt.elements) {
        const id = `${pt.tableName}::${el.name}`;
        const element = {
          id,
          table: pt.tableName,
          name: el.name,
          kind: el.kind, // 'column' | 'calculatedColumn' | 'measure'
          expression: el.expression,
          isHidden: el.isHidden,
          displayFolder: el.displayFolder,
          dataType: el.dataType,
          sortByColumn: el.sortByColumn,
        };
        elements.push(element);
        elementsById.set(id, element);

        if (el.kind === 'measure') {
          measMap.set(el.name, element);
          measuresByName.set(el.name, element);
        } else {
          colMap.set(el.name, element);
        }
      }

      for (const colName of pt.hierarchyColumnRefs) {
        hierarchyUsage.push({ table: pt.tableName, column: colName });
      }
    }

    return {
      elements,
      elementsById,
      columnsByTable,
      measuresByTable,
      measuresByName,
      relationships: relationships || [],
      hierarchyUsage,
    };
  }

  function resolveColumn(model, table, field) {
    const cols = model.columnsByTable.get(table);
    if (cols && cols.has(field)) return cols.get(field).id;
    const meas = model.measuresByTable.get(table);
    if (meas && meas.has(field)) return meas.get(field).id;
    return null;
  }

  function resolveTableColumn(model, table, column) {
    const cols = model.columnsByTable.get(table);
    if (cols && cols.has(column)) return cols.get(column).id;
    return null;
  }

  return { build, resolveColumn, resolveTableColumn };
})();
