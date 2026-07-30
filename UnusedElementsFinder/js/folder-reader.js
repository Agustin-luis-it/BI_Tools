// Clasifica los archivos entregados por <input webkitdirectory> según
// pertenezcan a una carpeta .SemanticModel o .Report, y valida que la
// carpeta elegida sea del tipo esperado.
window.UEF = window.UEF || {};

UEF.FolderReader = (function () {

  function relPath(file) {
    return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  }

  function readSemanticModelFolder(fileList) {
    const files = Array.from(fileList);
    const tableFiles = files.filter(f => /definition\/tables\/[^/]+\.tmdl$/i.test(relPath(f)));
    const relationshipsFile = files.find(f => /definition\/relationships\.tmdl$/i.test(relPath(f))) || null;
    const rootName = files.length ? relPath(files[0]).split('/')[0] : '';
    return {
      rootName,
      tableFiles,
      relationshipsFile,
      valid: tableFiles.length > 0,
    };
  }

  function readReportFolder(fileList) {
    const files = Array.from(fileList);
    const jsonFiles = files
      .filter(f => /definition\/.*\.json$/i.test(relPath(f)))
      .map(f => ({ file: f, relativePath: relPath(f).replace(/^[^/]+\//, '') }));
    const rootName = files.length ? relPath(files[0]).split('/')[0] : '';
    const hasPages = jsonFiles.some(f => /pages\/[^/]+\/page\.json$/i.test(f.relativePath));
    return {
      rootName,
      jsonFiles,
      valid: hasPages,
    };
  }

  return { readSemanticModelFolder, readReportFolder };
})();
