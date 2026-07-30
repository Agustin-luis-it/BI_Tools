// Maneja toda la interacción de la interfaz: selección de carpetas,
// disparo del análisis y renderizado de resultados.
window.UEF = window.UEF || {};

UEF.UI = (function () {
  const { escapeHtml, download, csvCell } = UEF.Utils;

  let semanticModelInput = null;
  let reportInput = null;
  let lastResult = null;

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

  function initFolderPicker(inputId, statusId, kind) {
    const input = document.getElementById(inputId);
    const statusEl = document.getElementById(statusId);
    input.addEventListener('change', () => {
      if (!input.files || input.files.length === 0) return;
      if (kind === 'model') {
        semanticModelInput = UEF.FolderReader.readSemanticModelFolder(input.files);
        if (semanticModelInput.valid) {
          setStatus(statusEl, true, `✓ "${semanticModelInput.rootName}" — ${semanticModelInput.tableFiles.length} tabla(s) encontrada(s)${semanticModelInput.relationshipsFile ? '' : ' (sin relationships.tmdl)'}`);
        } else {
          setStatus(statusEl, false, `✗ "${semanticModelInput.rootName}" no parece una carpeta .SemanticModel válida (no se encontraron .tmdl en definition/tables).`);
        }
      } else {
        reportInput = UEF.FolderReader.readReportFolder(input.files);
        if (reportInput.valid) {
          setStatus(statusEl, true, `✓ "${reportInput.rootName}" — ${reportInput.jsonFiles.length} archivo(s) JSON encontrado(s)`);
        } else {
          setStatus(statusEl, false, `✗ "${reportInput.rootName}" no parece una carpeta .Report válida (no se encontraron páginas en definition/pages).`);
        }
      }
      updateAnalyzeButtonState();
    });
  }

  function renderSummary(result) {
    const s = result.summary;
    const pctUnused = s.total ? Math.round(((s.unusedSection1 + s.unusedSection2) / s.total) * 100) : 0;
    $('#summaryStats').innerHTML = `
      <div class="stat-tile">
        <div class="stat-value">${s.total}</div>
        <div class="stat-label">Elementos totales</div>
      </div>
      <div class="stat-tile">
        <div class="stat-value">${s.used}</div>
        <div class="stat-label">En uso</div>
      </div>
      <div class="stat-tile stat-warn">
        <div class="stat-value">${s.unusedSection1}</div>
        <div class="stat-label">No se usan</div>
      </div>
      <div class="stat-tile stat-warn">
        <div class="stat-value">${s.unusedSection2}</div>
        <div class="stat-label">Referenciados en elementos no usados</div>
      </div>
      <div class="stat-tile">
        <div class="stat-value">${pctUnused}%</div>
        <div class="stat-label">Del modelo es candidato a revisión</div>
      </div>
    `;
  }

  function rowHtml(item, withReferencedBy) {
    const el = item.element;
    const hasExpr = !!el.expression;
    const referencedByHtml = withReferencedBy
      ? `<td>${item.referencedBy.map(r => `${escapeHtml(r.table)}.${escapeHtml(r.name)} <span class="kind-tag kind-${r.kind}">${KIND_LABEL[r.kind]}</span>`).join('<br>')}</td>`
      : '';
    const rowId = `row-${el.id.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const daxRow = hasExpr
      ? `<tr class="dax-row" id="${rowId}" style="display:none"><td colspan="${withReferencedBy ? 6 : 5}"><pre class="dax-code">${escapeHtml(el.expression)}</pre></td></tr>`
      : '';
    return `
      <tr>
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

  function renderSection(sectionKey, items, withReferencedBy) {
    const tbody = document.getElementById(`${sectionKey}Body`);
    const countEl = document.getElementById(`${sectionKey}Count`);
    countEl.textContent = items.length;
    if (items.length === 0) {
      const colspan = withReferencedBy ? 6 : 5;
      tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-row">Sin elementos en esta sección. 🎉</td></tr>`;
      return;
    }
    tbody.innerHTML = items.map(item => rowHtml(item, withReferencedBy)).join('');
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
    renderSection(prefix, filtered, withReferencedBy);
  }

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
      renderSummary(result);
      refreshSection('section1', result.section1, false);
      refreshSection('section2', result.section2, true);
      $('#resultsPanel').style.display = 'block';
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
    initFolderPicker('semanticModelPicker', 'semanticModelStatus', 'model');
    initFolderPicker('reportPicker', 'reportStatus', 'report');
    $('#analyzeBtn').addEventListener('click', runAnalysis);
    wireSectionControls('section1', () => lastResult.section1, false);
    wireSectionControls('section2', () => lastResult.section2, true);

    const helpToggle = $('#helpToggle');
    helpToggle.addEventListener('click', () => {
      const panel = $('#helpPanel');
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      helpToggle.textContent = isOpen ? 'Cómo usar esta herramienta ▾' : 'Cómo usar esta herramienta ▴';
    });
  }

  return { init };
})();
