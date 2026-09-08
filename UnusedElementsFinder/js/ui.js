// Maneja toda la interacción de la interfaz: selección de carpetas,
// disparo del análisis y renderizado de resultados.
window.UEF = window.UEF || {};

UEF.UI = (function () {
  const { escapeHtml, download, csvCell } = UEF.Utils;

  let semanticModelInput = null;
  let reportInputs = []; // puede haber más de un .Report conectado al mismo modelo
  let lastResult = null;

  // Estado del modo edición, uno por sección.
  const sectionEditMode = { section1: false, section2: false };
  const selectedIds = { section1: new Set(), section2: new Set() };
  // Se activa después de un borrado: hay que volver a analizar antes de
  // poder borrar de nuevo, porque los rangos de línea del resto de los
  // elementos de un archivo tocado pueden haberse corrido.
  let editingLocked = false;

  // Estado de la sección "Páginas ocultas". Acá no hace falta un lock como
  // el de arriba: borrar una carpeta de página no invalida los rangos de
  // línea de ninguna otra (cada una es un borrado independiente y
  // autocontenido).
  let pagesEditMode = false;
  let selectedPageIds = new Set();
  let pagesDeletedSinceAnalysis = false;

  // Papelera de la sesión: entradas { trashId, type: 'element'|'page', restored, ... }.
  // Vive fuera de lastResult a propósito, para sobrevivir a un "Analizar" de
  // nuevo — pero se vacía si el usuario elige otra carpeta (los handles de
  // archivo de la carpeta anterior dejan de tener sentido).
  let trash = [];
  const newTrashId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const TRASH_TYPE_LABEL = { measure: 'Medida', calculatedColumn: 'Columna calculada', column: 'Columna', page: 'Página' };
  const TRASH_TYPE_LABEL_PLURAL = { measure: 'medida(s)', calculatedColumn: 'columna(s) calculada(s)', column: 'columna(s)', page: 'página(s)' };

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
    btn.disabled = !(semanticModelInput && semanticModelInput.valid && reportInputs.some(r => r.valid));
  }

  function reportEntryNote(r) {
    if (!r.valid) return 'no parece una carpeta .Report válida (no se encontraron páginas en definition/pages ni un report.json)';
    const modeNote = r.writable ? '✏️ modo edición de páginas disponible' : 'solo lectura (sin borrado de páginas)';
    if (r.format === 'legacy') return `formato clásico (legacy) · ${modeNote}`;
    return `${r.jsonFiles.length} archivo(s) JSON · ${modeNote}`;
  }

  function renderReportList() {
    const container = document.getElementById('reportList');
    container.innerHTML = reportInputs.map(r => `
      <div class="report-entry">
        <div class="report-entry-info">
          <span class="${r.valid ? 'status-ok' : 'status-error'}">${r.valid ? '✓' : '✗'} "${escapeHtml(r.rootName)}"</span>
          <span class="hint">${escapeHtml(reportEntryNote(r))}</span>
        </div>
        <div class="report-entry-actions">
          <button type="button" class="link-btn" data-change-report="${r.reportId}">🔁 Cambiar</button>
          <button type="button" class="link-btn" data-remove-report="${r.reportId}">✕ Quitar</button>
        </div>
      </div>
    `).join('');
  }

  function initReportPicker() {
    const btn = document.getElementById('reportPickerBtn');
    const fallbackInput = document.getElementById('reportPickerFallback');
    const listEl = document.getElementById('reportList');
    const supportsHandlePicker = typeof window.showDirectoryPicker === 'function';

    async function pickFolder() {
      if (supportsHandlePicker) {
        try {
          const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          return await UEF.FolderReader.readReportFolderFromHandle(dirHandle);
        } catch (err) {
          if (err && err.name === 'AbortError') return null; // el usuario cerró el diálogo
          console.error(err);
          alert('No se pudo obtener permiso sobre la carpeta. Probá de nuevo, o si el problema persiste actualizá Edge/Chrome a la última versión.');
          return null;
        }
      }
      return new Promise((resolve) => {
        const handler = () => {
          fallbackInput.removeEventListener('change', handler);
          const files = fallbackInput.files;
          fallbackInput.value = '';
          if (!files || files.length === 0) { resolve(null); return; }
          resolve(UEF.FolderReader.readReportFolder(files));
        };
        fallbackInput.addEventListener('change', handler);
        fallbackInput.click();
      });
    }

    function forgetTrashFor(oldInput) {
      if (!oldInput) return;
      const before = trash.length;
      trash = trash.filter(t => t.reportInput !== oldInput);
      if (trash.length !== before) renderTrash();
    }

    btn.addEventListener('click', async () => {
      const input = await pickFolder();
      if (!input) return;
      input.reportId = newTrashId();
      reportInputs.push(input);
      renderReportList();
      updateAnalyzeButtonState();
      updatePagesEditModeAvailability();
    });

    listEl.addEventListener('click', async (e) => {
      const changeBtn = e.target.closest('[data-change-report]');
      const removeBtn = e.target.closest('[data-remove-report]');
      if (changeBtn) {
        const id = changeBtn.getAttribute('data-change-report');
        const oldInput = reportInputs.find(r => r.reportId === id);
        const input = await pickFolder();
        if (!input) return;
        input.reportId = id;
        const idx = reportInputs.findIndex(r => r.reportId === id);
        if (idx !== -1) reportInputs[idx] = input;
        forgetTrashFor(oldInput);
        renderReportList();
        updateAnalyzeButtonState();
        updatePagesEditModeAvailability();
      } else if (removeBtn) {
        const id = removeBtn.getAttribute('data-remove-report');
        const oldInput = reportInputs.find(r => r.reportId === id);
        reportInputs = reportInputs.filter(r => r.reportId !== id);
        forgetTrashFor(oldInput);
        renderReportList();
        updateAnalyzeButtonState();
        updatePagesEditModeAvailability();
      }
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
      trash = [];
      renderTrash();
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
      ? `<td>${item.referencedBy.map(r => {
          // Las medidas viven en una tabla especial ("Measure") que no
          // aporta nada — la etiqueta de al lado ya dice "Medida". Para
          // columnas sí conviene mostrar de qué tabla vienen.
          const label = r.kind === 'measure' ? escapeHtml(r.name) : `${escapeHtml(r.table)}.${escapeHtml(r.name)}`;
          return `${label} <span class="kind-tag kind-${r.kind}">${KIND_LABEL[r.kind]}</span>`;
        }).join('<br>')}</td>`
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

    // Guardamos, por id, en qué sección estaba cada uno y con qué "item"
    // completo (incluye referencedBy si era de la sección 2) — así, si el
    // usuario lo restaura después, lo podemos reinsertar tal cual estaba
    // sin tener que analizar de nuevo.
    const originalById = new Map();
    for (const item of lastResult.section1) originalById.set(item.element.id, { section: 'section1', item });
    for (const item of lastResult.section2) originalById.set(item.element.id, { section: 'section2', item });

    const statusEl = document.getElementById(`${sectionKey}DeleteStatus`);
    document.getElementById(`${sectionKey}DeleteBtn`).disabled = true;
    setStatus(statusEl, true, 'Borrando…');

    try {
      const result = await UEF.TmdlWriter.deleteElements(elements, lastResult.model);
      trash.unshift(...result.removedBlocks.map(b => {
        const original = originalById.get(`${b.table}::${b.name}`);
        return {
          trashId: newTrashId(),
          type: 'element',
          restored: false,
          originalSection: original ? original.section : null,
          originalItem: original ? original.item : null,
          ...b,
        };
      }));
      renderTrash();
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

  // ---- Sección "Páginas ocultas candidatas a borrar" ----
  // (El análisis interno igual calcula las "en uso" — Drillthrough, Tooltip,
  // referenciadas — porque hace falta para excluirlas de las candidatas,
  // pero ya no se listan en la interfaz.)

  function updatePagesCount() {
    const el = document.getElementById('pagesHiddenCount');
    if (el && lastResult) el.textContent = lastResult.pages.candidates.length;
  }

  function updateStalePagesNotice() {
    document.getElementById('stalePagesNotice').style.display = pagesDeletedSinceAnalysis ? 'block' : 'none';
  }

  function renderPagesCandidates(pages) {
    const tbody = document.getElementById('pagesCandidatesBody');
    const items = pages.candidates;
    const showReportCol = reportInputs.filter(r => r.valid).length > 1;
    document.getElementById('pagesReportHeader').style.display = showReportCol ? '' : 'none';
    if (items.length === 0) {
      const colspan = (pagesEditMode ? 3 : 2) + (showReportCol ? 1 : 0);
      tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-row">Sin páginas candidatas a borrar. 🎉</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(p => {
      const checkboxHtml = pagesEditMode
        ? `<td class="check-col"><input type="checkbox" class="page-check" data-id="${escapeHtml(p.name)}"${selectedPageIds.has(p.name) ? ' checked' : ''}></td>`
        : '';
      const reportHtml = showReportCol ? `<td>${escapeHtml(p.reportLabel || '')}</td>` : '';
      return `<tr>${checkboxHtml}<td>${escapeHtml(p.displayName)}</td>${reportHtml}<td><code>${escapeHtml(p.name)}</code></td></tr>`;
    }).join('');
    if (pagesEditMode) updatePagesDeleteBarState();
  }

  function updatePagesDeleteBarState() {
    const countEl = document.getElementById('pagesSelectedCount');
    const btn = document.getElementById('pagesDeleteBtn');
    const selectAll = document.getElementById('pagesSelectAllCheckbox');
    countEl.textContent = selectedPageIds.size;
    btn.disabled = selectedPageIds.size === 0;
    const visibleChecks = Array.from(document.querySelectorAll('#pagesCandidatesBody .page-check'));
    const anyChecked = visibleChecks.some(c => c.checked);
    selectAll.checked = visibleChecks.length > 0 && visibleChecks.every(c => c.checked);
    selectAll.indeterminate = anyChecked && !selectAll.checked;
  }

  function setPagesMode(mode) {
    pagesEditMode = mode === 'edit';
    document.getElementById('pagesViewModeBtn').classList.toggle('mode-btn-active', !pagesEditMode);
    document.getElementById('pagesEditModeBtn').classList.toggle('mode-btn-active', pagesEditMode);
    document.getElementById('pagesCheckHeader').style.display = pagesEditMode ? '' : 'none';
    document.getElementById('pagesDeleteBar').style.display = pagesEditMode ? 'flex' : 'none';
    if (!pagesEditMode) selectedPageIds.clear();
    if (lastResult) renderPagesCandidates(lastResult.pages);
  }

  function updatePagesEditModeAvailability() {
    const canEdit = reportInputs.some(r => r.writable);
    const hint = document.getElementById('pagesEditModeHint');
    document.getElementById('pagesEditModeBtn').disabled = !canEdit;
    if (!canEdit && reportInputs.length > 0) {
      hint.textContent = 'Ninguno de los reportes agregados tiene permiso de escritura: solo se puede ver.';
    } else {
      hint.textContent = '';
    }
    if (!canEdit && pagesEditMode) setPagesMode('view');
  }

  async function handleDeletePages() {
    if (!lastResult || selectedPageIds.size === 0) return;
    const pagesToDelete = lastResult.pages.candidates.filter(p => selectedPageIds.has(p.name));
    if (pagesToDelete.length === 0) return;

    const preview = pagesToDelete.slice(0, 8).map(p => `• ${p.displayName}`).join('\n');
    const more = pagesToDelete.length > 8 ? `\n… y ${pagesToDelete.length - 8} más` : '';
    const confirmed = window.confirm(
      `Se van a borrar ${pagesToDelete.length} página(s) completas (con todos sus visuales):\n\n${preview}${more}\n\nEsta acción escribe sobre los archivos en disco (no hay deshacer desde la herramienta). ¿Confirmás?`
    );
    if (!confirmed) return;

    const statusEl = document.getElementById('pagesDeleteStatus');
    document.getElementById('pagesDeleteBtn').disabled = true;
    setStatus(statusEl, true, 'Borrando…');

    // Puede haber páginas tildadas de más de un .Report a la vez — hay que
    // borrar cada grupo con su propio reportInput.
    const byReport = new Map(); // reportInput -> [páginas]
    for (const p of pagesToDelete) {
      if (!byReport.has(p.reportInput)) byReport.set(p.reportInput, []);
      byReport.get(p.reportInput).push(p);
    }

    let totalDeleted = 0;
    let lastError = null;
    for (const [reportInputForGroup, pagesInGroup] of byReport) {
      const isLegacy = reportInputForGroup.format === 'legacy';
      try {
        const ids = pagesInGroup.map(p => p.name);
        const result = isLegacy
          ? await UEF.LegacyReportAdapter.deleteSections(ids, reportInputForGroup)
          : await UEF.PageWriter.deletePages(ids, reportInputForGroup);
        totalDeleted += result.deletedCount;
        const originalByName = new Map(pagesInGroup.map(p => [p.name, p]));
        trash.unshift(...result.snapshots.map(s => ({
          trashId: newTrashId(),
          type: 'page',
          format: isLegacy ? 'legacy' : 'modern',
          restored: false,
          pageName: isLegacy ? s.sectionName : s.pageName,
          displayName: (originalByName.get(isLegacy ? s.sectionName : s.pageName) || {}).displayName || (isLegacy ? s.sectionName : s.pageName),
          originalPage: originalByName.get(isLegacy ? s.sectionName : s.pageName) || null,
          reportInput: reportInputForGroup,
          files: s.files,
          section: s.section,
          originalIndex: s.originalIndex,
        })));
        const deletedSet = new Set(ids);
        lastResult.pages.candidates = lastResult.pages.candidates.filter(p => !deletedSet.has(p.name));
      } catch (err) {
        console.error(err);
        lastError = err;
        // Seguimos con el resto de los grupos: lo que ya se borró en otros
        // reportes queda reflejado igual, no se pierde de la papelera.
      }
    }

    renderTrash();
    selectedPageIds.clear();
    if (totalDeleted > 0) {
      pagesDeletedSinceAnalysis = true;
      updateStalePagesNotice();
    }
    renderPagesCandidates(lastResult.pages);
    updatePagesCount();

    if (lastError) {
      setStatus(statusEl, false, `Se borraron ${totalDeleted} de ${pagesToDelete.length}. Falló el resto: ${lastError.message}`);
    } else {
      setStatus(statusEl, true, `✓ Se borraron ${totalDeleted} página(s). Mirá el aviso arriba de "Elementos que no se usan": puede convenir volver a analizar.`);
    }
    updatePagesDeleteBarState();
  }

  function initPagesEditMode() {
    document.getElementById('pagesViewModeBtn').addEventListener('click', () => setPagesMode('view'));
    document.getElementById('pagesEditModeBtn').addEventListener('click', () => setPagesMode('edit'));
    document.getElementById('pagesSelectAllCheckbox').addEventListener('change', (e) => {
      const checked = e.target.checked;
      document.querySelectorAll('#pagesCandidatesBody .page-check').forEach(cb => {
        cb.checked = checked;
        const id = cb.getAttribute('data-id');
        if (checked) selectedPageIds.add(id); else selectedPageIds.delete(id);
      });
      updatePagesDeleteBarState();
    });
    document.getElementById('pagesDeleteBtn').addEventListener('click', handleDeletePages);
    updatePagesEditModeAvailability();
  }

  document.addEventListener('change', (e) => {
    const cb = e.target.closest('.page-check');
    if (!cb) return;
    const id = cb.getAttribute('data-id');
    if (cb.checked) selectedPageIds.add(id); else selectedPageIds.delete(id);
    updatePagesDeleteBarState();
  });

  // ---- Papelera ----

  function renderTrash() {
    const active = trash.filter(t => !t.restored);
    document.getElementById('trashCount').textContent = active.length;
    document.getElementById('trashWidget').style.display = active.length > 0 ? 'block' : 'none';

    const counts = {};
    for (const t of active) counts[t.type === 'page' ? 'page' : t.kind] = (counts[t.type === 'page' ? 'page' : t.kind] || 0) + 1;
    document.getElementById('trashSummary').textContent = Object.entries(counts)
      .map(([k, n]) => `${n} ${TRASH_TYPE_LABEL_PLURAL[k] || k}`)
      .join(' · ');

    const tbody = document.getElementById('trashBody');
    if (active.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-row">La papelera está vacía.</td></tr>`;
      return;
    }
    tbody.innerHTML = active.map(t => {
      const isPage = t.type === 'page';
      const typeLabel = isPage ? TRASH_TYPE_LABEL.page : TRASH_TYPE_LABEL[t.kind];
      const kindClass = isPage ? 'kind-column' : `kind-${t.kind}`;
      const name = isPage ? t.displayName : `${t.table}.${t.name}`;
      const pageDetail = t.format === 'legacy' ? '1 sección' : `${(t.files || []).length} archivo(s)`;
      const showReportName = reportInputs.filter(r => r.valid).length > 1;
      const detail = isPage
        ? `${pageDetail}${showReportName && t.reportInput && t.reportInput.rootName ? ' · ' + t.reportInput.rootName : ''}`
        : t.table;
      return `
        <tr>
          <td><span class="kind-tag ${kindClass}">${escapeHtml(typeLabel)}</span></td>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(detail)}</td>
          <td><button type="button" class="link-btn" data-restore="${t.trashId}">↩ Restaurar</button></td>
        </tr>`;
    }).join('');
  }

  async function restoreTrashEntry(trashId) {
    const entry = trash.find(t => t.trashId === trashId && !t.restored);
    if (!entry || !lastResult) return;
    try {
      if (entry.type === 'element') {
        await UEF.TmdlWriter.restoreElement(entry, lastResult.model);
        entry.restored = true;
        // Insertar el bloque de vuelta corre las líneas del resto del
        // archivo — igual que al borrar, hay que analizar de nuevo antes
        // de volver a borrar algo de esa misma carpeta para no usar rangos
        // de línea desactualizados.
        editingLocked = true;
        updateDeleteBarState('section1');
        updateDeleteBarState('section2');
        // La reinsertamos en la lista tal cual estaba, sin esperar a un
        // nuevo análisis (si en el medio se borró también lo que la
        // referenciaba, el análisis completo la va a reclasificar bien).
        if (entry.originalItem && entry.originalSection === 'section1') {
          lastResult.section1.push(entry.originalItem);
          lastResult.summary.unusedSection1 = lastResult.section1.length;
          refreshSection('section1', lastResult.section1, false);
        } else if (entry.originalItem && entry.originalSection === 'section2') {
          lastResult.section2.push(entry.originalItem);
          lastResult.summary.unusedSection2 = lastResult.section2.length;
          refreshSection('section2', lastResult.section2, true);
        }
        renderSummary(lastResult);
      } else {
        if (entry.format === 'legacy') {
          await UEF.LegacyReportAdapter.restoreSection(entry, entry.reportInput);
        } else {
          await UEF.PageWriter.restorePage(entry, entry.reportInput);
        }
        entry.restored = true;
        if (entry.originalPage) {
          lastResult.pages.candidates.push(entry.originalPage);
          renderPagesCandidates(lastResult.pages);
          updatePagesCount();
        }
      }
      renderTrash();
    } catch (err) {
      console.error(err);
      alert('No se pudo restaurar: ' + err.message);
    }
  }

  async function restoreAllTrash() {
    for (const entry of trash.filter(t => !t.restored)) {
      await restoreTrashEntry(entry.trashId);
    }
  }

  function clearTrash() {
    if (trash.filter(t => !t.restored).length === 0) return;
    if (!window.confirm('¿Vaciar la papelera? Esto no deshace nada en los archivos — solo olvida la posibilidad de restaurar desde acá.')) return;
    trash = [];
    renderTrash();
  }

  function initTrash() {
    document.getElementById('trashToggleBtn').addEventListener('click', () => {
      const panel = document.getElementById('trashPanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('trashRestoreAllBtn').addEventListener('click', restoreAllTrash);
    document.getElementById('trashClearBtn').addEventListener('click', clearTrash);
    renderTrash();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-restore]');
    if (!btn) return;
    btn.disabled = true;
    restoreTrashEntry(btn.getAttribute('data-restore'));
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
      const result = await UEF.Analyzer.analyze(semanticModelInput, reportInputs);
      lastResult = result;
      editingLocked = false;
      selectedIds.section1.clear();
      selectedIds.section2.clear();
      selectedPageIds.clear();
      pagesDeletedSinceAnalysis = false;
      updateStalePagesNotice();
      updateEditModeAvailability();
      updatePagesEditModeAvailability();
      renderSummary(result);
      refreshSection('section1', result.section1, false);
      refreshSection('section2', result.section2, true);
      renderPagesCandidates(result.pages);
      updatePagesCount();
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
    initPagesEditMode();
    initTrash();

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
