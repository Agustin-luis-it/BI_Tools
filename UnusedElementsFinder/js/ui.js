// Maneja toda la interacción de la interfaz: selección de carpetas,
// disparo del análisis y renderizado de resultados.
window.UEF = window.UEF || {};

UEF.UI = (function () {
  const { escapeHtml, download, csvCell } = UEF.Utils;

  let semanticModelInput = null;
  let reportInput = null;
  let lastResult = null;

  // Estado del modo edición, uno por sección.
  const sectionEditMode = { section1: false, section2: false };
  const selectedIds = { section1: new Set(), section2: new Set() };
  // Se activa después de un borrado: hay que volver a analizar antes de
  // poder borrar de nuevo, porque los rangos de línea del resto de los
  // elementos de un archivo tocado pueden haberse corrido.
  let editingLocked = false;

  const KIND_LABEL = {
    measure: 'Medida',
    calculatedColumn: 'Columna calculada',
    column: 'Columna',
  };

  function $(sel) { return document.querySelector(sel); }

  function setStatus(el, ok, message) {
    el.textContent = message;
    el.classList.toggle('status-ok', ok);
    el.classList.toggle('status-error', !ok);
  }

  function updateAnalyzeButtonState() {
    const btn = $('#analyzeBtn');
    btn.disabled = !(semanticModelInput && semanticModelInput.valid && reportInput && reportInput.valid);
  }

  function initReportPicker() {
    const input = document.getElementById('reportPicker');
    const statusEl = document.getElementById('reportStatus');
    input.addEventListener('change', () => {
      if (!input.files || input.files.length === 0) return;
      reportInput = UEF.FolderReader.readReportFolder(input.files);
      if (reportInput.valid) {
        setStatus(statusEl, true, `✓ "${reportInput.rootName}" — ${reportInput.jsonFiles.length} archivo(s) JSON encontrado(s)`);
      } else {
        setStatus(statusEl, false, `✗ "${reportInput.rootName}" no parece una carpeta .Report válida (no se encontraron páginas en definition/pages).`);
      }
      updateAnalyzeButtonState();
    });
  }

  function semanticModelStatusMessage(input) {
    const rolesNote = input.roleFiles.length ? ` · ${input.roleFiles.length} rol(es) de seguridad (RLS)` : '';
    const modeNote = input.writable ? ' · ✏️ modo edición disponible' : ' · solo lectura (sin modo edición)';
    return `✓ "${input.rootName}" — ${input.tableFiles.length} tabla(s) encontrada(s)${input.relationshipsFile ? '' : ' (sin relationships.tmdl)'}${rolesNote}${modeNote}`;
  }

  function initSemanticModelPicker() {
    const btn = document.getElementById('semanticModelPickerBtn');
    const fallbackInput = document.getElementById('semanticModelPickerFallback');
    const statusEl = document.getElementById('semanticModelStatus');
    const supportsHandlePicker = typeof window.showDirectoryPicker === 'function';

    function applyInput(input) {
      semanticModelInput = input;
      if (semanticModelInput.valid) {
        setStatus(statusEl, true, semanticModelStatusMessage(semanticModelInput));
      } else {
        setStatus(statusEl, false, `✗ "${semanticModelInput.rootName}" no parece una carpeta .SemanticModel válida (no se encontraron .tmdl en definition/tables).`);
      }
      updateAnalyzeButtonState();
      updateEditModeAvailability();
    }

    btn.addEventListener('click', async () => {
      if (!supportsHandlePicker) { fallbackInput.click(); return; }
      try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const input = await UEF.FolderReader.readSemanticModelFolderFromHandle(dirHandle);
        applyInput(input);
      } catch (err) {
        if (err && err.name === 'AbortError') return; // el usuario cerró el diálogo
        console.error(err);
        setStatus(statusEl, false, 'No se pudo obtener permiso sobre la carpeta. Probá de nuevo, o si el problema persiste actualizá Edge/Chrome a la última versión.');
      }
    });

    fallbackInput.addEventListener('change', () => {
      if (!fallbackInput.files || fallbackInput.files.length === 0) return;
      applyInput(UEF.FolderReader.readSemanticModelFolder(fallbackInput.files));
    });
  }

  function renderSummary(result) {
    const s = result.summary;
    const pctUnused = s.total ? Math.round(((s.unusedSection1 + s.unusedSection2) / s.total) * 100) : 0;
    $('#summaryStats').innerHTML = `
      <div class="stat-tile">
        <div class="stat-icon">📦</div>
        <div class="stat-value">${s.total}</div>
        <div class="stat-label">Elementos totales</div>
      </div>
      <div class="stat-tile stat-ok">
        <div class="stat-icon">✅</div>
        <div class="stat-value">${s.used}</div>
        <div class="stat-label">En uso</div>
      </div>
      <div class="stat-tile stat-warn">
        <div class="stat-icon">🧹</div>
        <div class="stat-value">${s.unusedSection1}</div>
        <div class="stat-label">No se usan</div>
      </div>
      <div class="stat-tile stat-warn">
        <div class="stat-icon">🔗</div>
        <div class="stat-value">${s.unusedSection2}</div>
        <div class="stat-label">Referenciados en elementos no usados</div>
      </div>
      <div class="stat-tile">
        <div class="stat-icon">📊</div>
        <div class="stat-value">${pctUnused}%</div>
        <div class="stat-label">Del modelo es candidato a revisión</div>
      </div>
    `;
  }

  // checkboxSectionKey: 'section1'/'section2' si esta fila debe mostrar
  // checkbox (y a qué set de selección pertenece), o null/undefined si no.
  function rowHtml(item, withReferencedBy, checkboxSectionKey) {
    const el = item.element;
    const hasExpr = !!el.expression;
    const referencedByHtml = withReferencedBy
      ? `<td>${item.referencedBy.map(r => `${escapeHtml(r.table)}.${escapeHtml(r.name)} <span class="kind-tag kind-${r.kind}">${KIND_LABEL[r.kind]}</span>`).join('<br>')}</td>`
      : '';
    const checkboxHtml = checkboxSectionKey
      ? `<td class="check-col"><input type="checkbox" class="row-check" data-section="${checkboxSectionKey}" data-id="${escapeHtml(el.id)}"${selectedIds[checkboxSectionKey].has(el.id) ? ' checked' : ''}></td>`
      : '';
    const rowId = `row-${el.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const colspan = (withReferencedBy ? 7 : 6) + (checkboxSectionKey ? 1 : 0);
    const daxRow = hasExpr
      ? `<tr class="dax-row" id="${rowId}" style="display:none"><td colspan="${colspan}"><pre class="dax-code">${escapeHtml(el.expression)}</pre></td></tr>`
      : '';
    return `
      <tr>
        ${checkboxHtml}
        <td>${escapeHtml(el.table)}</td>
        <td>${escapeHtml(el.name)}</td>
        <td><span class="kind-tag kind-${el.kind}">${KIND_LABEL[el.kind]}</span></td>
        <td>${el.isHidden ? 'Sí' : 'No'}</td>
        <td>${escapeHtml(el.displayFolder || '')}</td>
        ${referencedByHtml}
        <td>${hasExpr ? `<button class="link-btn" data-toggle="${rowId}">Ver DAX</button>` : ''}</td>
      </tr>
      ${daxRow}
    `;
  }

  function renderSection(sectionKey, items, withReferencedBy, withCheckbox) {
    const tbody = document.getElementById(`${sectionKey}Body`);
    const countEl = document.getElementById(`${sectionKey}Count`);
    countEl.textContent = items.length;
    if (items.length === 0) {
      const colspan = (withReferencedBy ? 7 : 6) + (withCheckbox ? 1 : 0);
      tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-row">Sin elementos en esta sección. 🎉</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(item => rowHtml(item, withReferencedBy, withCheckbox ? sectionKey : null)).join('');
  }

  function currentFilterState(prefix) {
    const search = document.getElementById(`${prefix}Search`).value.trim().toLowerCase();
    const kind = document.getElementById(`${prefix}KindFilter`).value;
    return { search, kind };
  }

  function applyFilters(items, filter) {
    return items.filter(item => {
      const el = item.element;
      if (filter.kind !== 'all' && el.kind !== filter.kind) return false;
      if (filter.search) {
        const haystack = `${el.table} ${el.name} ${el.displayFolder}`.toLowerCase();
        if (!haystack.includes(filter.search)) return false;
      }
      return true;
    });
  }

  function refreshSection(prefix, allItems, withReferencedBy) {
    const filter = currentFilterState(prefix);
    const filtered = applyFilters(allItems, filter);
    const withCheckbox = sectionEditMode[prefix];
    renderSection(prefix, filtered, withReferencedBy, withCheckbox);
    if (withCheckbox) updateDeleteBarState(prefix);
  }

  // ---- Modo edición (borrado directo de medidas/columnas sin uso) ----
  //
  // Borrar un elemento de la sección 2 sin borrar también lo que lo llama
  // dejaría una fórmula rota. Por eso, al calcular qué se borra, se agrega
  // automáticamente el "cierre" de todo lo que referencia (directa o
  // indirectamente) a lo tildado — que, por construcción del análisis, está
  // garantizado que también está sin uso real.
  function computeDeletionClosure(rootIds, graph) {
    const closure = new Set(rootIds);
    const queue = [...rootIds];
    while (queue.length) {
      const cur = queue.pop();
      const referencers = graph.incoming.get(cur);
      if (!referencers) continue;
      for (const r of referencers) {
        if (!closure.has(r)) { closure.add(r); queue.push(r); }
      }
    }
    return closure;
  }

  function updateDeleteBarState(sectionKey) {
    const countEl = document.getElementById(`${sectionKey}SelectedCount`);
    const btn = document.getElementById(`${sectionKey}DeleteBtn`);
    const selectAll = document.getElementById(`${sectionKey}SelectAllCheckbox`);
    const set = selectedIds[sectionKey];
    countEl.textContent = set.size;
    btn.disabled = set.size === 0 || editingLocked;
    const visibleChecks = Array.from(document.querySelectorAll(`#${sectionKey}Body .row-check`));
    const anyChecked = visibleChecks.some(c => c.checked);
    selectAll.checked = visibleChecks.length > 0 && visibleChecks.every(c => c.checked);
    selectAll.indeterminate = anyChecked && !selectAll.checked;
  }

  function setSectionMode(sectionKey, mode) {
    sectionEditMode[sectionKey] = mode === 'edit';
    const isEdit = sectionEditMode[sectionKey];
    document.getElementById(`${sectionKey}ViewModeBtn`).classList.toggle('mode-btn-active', !isEdit);
    document.getElementById(`${sectionKey}EditModeBtn`).classList.toggle('mode-btn-active', isEdit);
    document.getElementById(`${sectionKey}CheckHeader`).style.display = isEdit ? '' : 'none';
    document.getElementById(`${sectionKey}DeleteBar`).style.display = isEdit ? 'flex' : 'none';
    if (!isEdit) selectedIds[sectionKey].clear();
    if (lastResult) refreshSection(sectionKey, lastResult[sectionKey], sectionKey === 'section2');
  }

  function updateEditModeAvailability() {
    const canEdit = !!(semanticModelInput && semanticModelInput.writable);
    const hint = document.getElementById('editModeHint');
    if (!canEdit && semanticModelInput) {
      hint.textContent = 'Sin permiso de escritura sobre esta carpeta: solo se puede ver.';
    } else {
      hint.textContent = '';
    }
    for (const sectionKey of ['section1', 'section2']) {
      document.getElementById(`${sectionKey}EditModeBtn`).disabled = !canEdit;
      if (!canEdit && sectionEditMode[sectionKey]) setSectionMode(sectionKey, 'view');
    }
  }

  async function handleDeleteSelected(sectionKey) {
    if (!lastResult || editingLocked) return;
    const set = selectedIds[sectionKey];
    if (set.size === 0) return;

    const closureIds = computeDeletionClosure(set, lastResult.graph);
    const elements = [...closureIds].map(id => lastResult.model.elementsById.get(id)).filter(Boolean);
    if (elements.length === 0) return;

    const explicit = elements.filter(el => set.has(el.id));
    const extra = elements.filter(el => !set.has(el.id));

    let msg = `Se van a borrar ${elements.length} elemento(s) directamente de los archivos .tmdl:\n\n`;
    msg += explicit.slice(0, 8).map(el => `• ${el.table}.${el.name}`).join('\n');
    if (explicit.length > 8) msg += `\n… y ${explicit.length - 8} más`;
    if (extra.length) {
      msg += `\n\nAdemás se incluyen automáticamente ${extra.length} elemento(s) que dependen de los anteriores (para no dejar fórmulas rotas):\n`;
      msg += extra.slice(0, 8).map(el => `• ${el.table}.${el.name}`).join('\n');
      if (extra.length > 8) msg += `\n… y ${extra.length - 8} más`;
    }
    msg += '\n\nEsta acción escribe sobre los archivos en disco (no hay deshacer desde la herramienta). ¿Confirmás?';

    if (!window.confirm(msg)) return;

    const statusEl = document.getElementById(`${sectionKey}DeleteStatus`);
    document.getElementById(`${sectionKey}DeleteBtn`).disabled = true;
    setStatus(statusEl, true, 'Borrando…');

    try {
      const result = await UEF.TmdlWriter.deleteElements(elements, lastResult.model);
      lastResult.section1 = lastResult.section1.filter(item => !closureIds.has(item.element.id));
      lastResult.section2 = lastResult.section2
        .filter(item => !closureIds.has(item.element.id))
        .map(item => ({ ...item, referencedBy: item.referencedBy.filter(r => !closureIds.has(r.id)) }));
      lastResult.summary.unusedSection1 = lastResult.section1.length;
      lastResult.summary.unusedSection2 = lastResult.section2.length;
      selectedIds.section1.clear();
      selectedIds.section2.clear();
      editingLocked = true;
      refreshSection('section1', lastResult.section1, false);
      refreshSection('section2', lastResult.section2, true);
      setStatus(statusEl, true, `✓ Se borraron ${result.deletedCount} elemento(s) de ${result.tables.length} tabla(s). Volvé a analizar para refrescar el resto de los resultados.`);
    } catch (err) {
      console.error(err);
      setStatus(statusEl, false, 'No se pudo borrar: ' + err.message);
    } finally {
      updateDeleteBarState('section1');
      updateDeleteBarState('section2');
    }
  }

  function initEditMode() {
    for (const sectionKey of ['section1', 'section2']) {
      document.getElementById(`${sectionKey}ViewModeBtn`).addEventListener('click', () => setSectionMode(sectionKey, 'view'));
      document.getElementById(`${sectionKey}EditModeBtn`).addEventListener('click', () => setSectionMode(sectionKey, 'edit'));
      document.getElementById(`${sectionKey}SelectAllCheckbox`).addEventListener('change', (e) => {
        const checked = e.target.checked;
        document.querySelectorAll(`#${sectionKey}Body .row-check`).forEach(cb => {
          cb.checked = checked;
          const id = cb.getAttribute('data-id');
          if (checked) selectedIds[sectionKey].add(id); else selectedIds[sectionKey].delete(id);
        });
        updateDeleteBarState(sectionKey);
      });
      document.getElementById(`${sectionKey}DeleteBtn`).addEventListener('click', () => handleDeleteSelected(sectionKey));
    }
    updateEditModeAvailability();
  }

  document.addEventListener('change', (e) => {
    const cb = e.target.closest('.row-check');
    if (!cb) return;
    const sectionKey = cb.getAttribute('data-section');
    const id = cb.getAttribute('data-id');
    if (cb.checked) selectedIds[sectionKey].add(id); else selectedIds[sectionKey].delete(id);
    updateDeleteBarState(sectionKey);
  });

  function wireSectionControls(prefix, getItems, withReferencedBy) {
    document.getElementById(`${prefix}Search`).addEventListener('input', () => refreshSection(prefix, getItems(), withReferencedBy));
    document.getElementById(`${prefix}KindFilter`).addEventListener('change', () => refreshSection(prefix, getItems(), withReferencedBy));
    document.getElementById(`${prefix}ExportBtn`).addEventListener('click', () => {
      const filter = currentFilterState(prefix);
      const filtered = applyFilters(getItems(), filter);
      exportCsv(prefix, filtered, withReferencedBy);
    });
  }

  function exportCsv(prefix, items, withReferencedBy) {
    const headers = ['Tabla', 'Nombre', 'Tipo', 'Oculto', 'Carpeta de visualización'];
    if (withReferencedBy) headers.push('Referenciado por');
    headers.push('Expresión DAX');
    const rows = [headers];
    for (const item of items) {
      const el = item.element;
      const row = [el.table, el.name, KIND_LABEL[el.kind], el.isHidden ? 'Sí' : 'No', el.displayFolder || ''];
      if (withReferencedBy) {
        row.push(item.referencedBy.map(r => `${r.table}.${r.name}`).join(' | '));
      }
      row.push(el.expression || '');
      rows.push(row);
    }
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
    download(`${prefix}.csv`, csv);
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const row = document.getElementById(btn.getAttribute('data-toggle'));
    if (row) row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  });

  async function runAnalysis() {
    const analyzeBtn = $('#analyzeBtn');
    const errorBox = $('#analysisError');
    errorBox.textContent = '';
    errorBox.style.display = 'none';
    analyzeBtn.disabled = true;
    $('#analyzeSpinner').style.display = 'inline-block';
    $('#resultsPanel').style.display = 'none';

    try {
      const result = await UEF.Analyzer.analyze(semanticModelInput, reportInput);
      lastResult = result;
      editingLocked = false;
      selectedIds.section1.clear();
      selectedIds.section2.clear();
      updateEditModeAvailability();
      renderSummary(result);
      refreshSection('section1', result.section1, false);
      refreshSection('section2', result.section2, true);
      const resultsPanel = $('#resultsPanel');
      resultsPanel.classList.remove('fade-in');
      resultsPanel.style.display = 'block';
      void resultsPanel.offsetWidth; // reinicia la animación en cada análisis
      resultsPanel.classList.add('fade-in');
    } catch (err) {
      console.error(err);
      errorBox.textContent = 'Ocurrió un error analizando los archivos: ' + err.message;
      errorBox.style.display = 'block';
    } finally {
      updateAnalyzeButtonState();
      $('#analyzeSpinner').style.display = 'none';
    }
  }

  function init() {
    initSemanticModelPicker();
    initReportPicker();
    $('#analyzeBtn').addEventListener('click', runAnalysis);
    wireSectionControls('section1', () => lastResult.section1, false);
    wireSectionControls('section2', () => lastResult.section2, true);
    initEditMode();

    const helpToggle = $('#helpToggle');
    helpToggle.addEventListener('click', () => {
      const panel = $('#helpPanel');
      const isOpen = panel.style.display !== 'none';
      if (isOpen) {
        panel.style.display = 'none';
      } else {
        panel.classList.remove('fade-in');
        panel.style.display = 'block';
        void panel.offsetWidth;
        panel.classList.add('fade-in');
      }
      helpToggle.textContent = isOpen ? 'Cómo usar esta herramienta ▾' : 'Cómo usar esta herramienta ▴';
    });
  }

  return { init };
})();
