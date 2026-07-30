// Extrae referencias a columnas/medidas dentro de una expresión DAX,
// y arma el grafo de dependencias entre elementos del modelo.
//
// Reglas (heurística de texto, no un parser DAX real):
//  - 'Tabla'[Campo] o Tabla[Campo]  -> referencia calificada a columna
//    (o medida, si esa tabla no tiene una columna con ese nombre).
//  - [Campo] sin calificar          -> referencia a una medida (por nombre,
//    ya que los nombres de medida son únicos en todo el modelo).
window.UEF = window.UEF || {};

UEF.DaxReferences = (function () {
  const REF_RE = /(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_]*))?\[([^\[\]]+)\]/gu;

  function extractReferences(expression, model) {
    const refs = new Set();
    if (!expression) return refs;

    REF_RE.lastIndex = 0;
    let m;
    while ((m = REF_RE.exec(expression))) {
      const qualifier = m[1] !== undefined ? m[1].replace(/''/g, "'") : (m[2] !== undefined ? m[2] : null);
      const field = m[3];
      if (qualifier) {
        const id = UEF.ModelBuilder.resolveColumn(model, qualifier, field);
        if (id) refs.add(id);
      } else {
        const measure = model.measuresByName.get(field);
        if (measure) refs.add(measure.id);
      }
    }
    return refs;
  }

  function buildGraph(model) {
    const outgoing = new Map(); // id -> Set(id) (de qué depende este elemento)
    const incoming = new Map(); // id -> Set(id) (quién depende de este elemento)

    function addEdge(from, to) {
      if (from === to) return;
      if (!outgoing.has(from)) outgoing.set(from, new Set());
      outgoing.get(from).add(to);
      if (!incoming.has(to)) incoming.set(to, new Set());
      incoming.get(to).add(from);
    }

    for (const el of model.elements) {
      if (el.expression) {
        const refs = extractReferences(el.expression, model);
        for (const refId of refs) addEdge(el.id, refId);
      }
      if (el.sortByColumn) {
        const targetId = UEF.ModelBuilder.resolveTableColumn(model, el.table, el.sortByColumn);
        if (targetId) addEdge(el.id, targetId);
      }
    }

    return { outgoing, incoming };
  }

  return { extractReferences, buildGraph };
})();
