// Clasifica los archivos de una carpeta .SemanticModel / .Report según su
// rol, y valida que la carpeta elegida sea del tipo esperado.
//
// Hay dos formas de leer la carpeta .SemanticModel:
//  - readSemanticModelFolder(fileList): a partir de <input webkitdirectory>,
//    solo lectura (no hay forma de escribir de vuelta al disco con esta API).
//  - readSemanticModelFolderFromHandle(dirHandle): a partir de
//    window.showDirectoryPicker(), con permiso de lectura y escritura — es
//    lo que permite el "modo edición" (borrar medidas/columnas del archivo
//    .tmdl real). Ambas devuelven la misma forma de objeto; los archivos
//    resultantes exponen un método .text() como los File nativos.
window.UEF = window.UEF || {};

UEF.FolderReader = (function () {

  function relPath(file) {
    return (file.webkitRelativePath || file.name).replace(/\\/g, '/');
  }

  function readSemanticModelFolder(fileList) {
    const files = Array.from(fileList);
    const tableFiles = files.filter(f => /definition\/tables\/[^/]+\.tmdl$/i.test(relPath(f)));
    const relationshipsFile = files.find(f => /definition\/relationships\.tmdl$/i.test(relPath(f))) || null;
    const roleFiles = files.filter(f => /definition\/roles\/[^/]+\.tmdl$/i.test(relPath(f)));
    const rootName = files.length ? relPath(files[0]).split('/')[0] : '';
    return {
      rootName,
      tableFiles,
      relationshipsFile,
      roleFiles,
      valid: tableFiles.length > 0,
      writable: false,
    };
  }

  // dirsOut (opcional): si se pasa, también junta {handle, relativePath} de
  // cada subcarpeta recorrida — hace falta para poder borrar carpetas de
  // página más adelante (hay que llamar removeEntry() desde el handle de su
  // carpeta padre, no desde la carpeta en sí).
  async function walkHandle(dirHandle, prefix, filesOut, dirsOut) {
    if (dirsOut) dirsOut.push({ handle: dirHandle, relativePath: prefix });
    for await (const [name, handle] of dirHandle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await walkHandle(handle, relativePath, filesOut, dirsOut);
      } else {
        filesOut.push({ handle, relativePath });
      }
    }
  }

  function wrapFileHandle(entry) {
    return {
      text: () => entry.handle.getFile().then(f => f.text()),
      handle: entry.handle,
      relativePath: entry.relativePath,
    };
  }

  async function readSemanticModelFolderFromHandle(dirHandle) {
    const entries = [];
    await walkHandle(dirHandle, '', entries, null);
    const tableFiles = entries
      .filter(e => /definition\/tables\/[^/]+\.tmdl$/i.test(e.relativePath))
      .map(wrapFileHandle);
    const relationshipsEntry = entries.find(e => /definition\/relationships\.tmdl$/i.test(e.relativePath));
    const relationshipsFile = relationshipsEntry ? wrapFileHandle(relationshipsEntry) : null;
    const roleFiles = entries
      .filter(e => /definition\/roles\/[^/]+\.tmdl$/i.test(e.relativePath))
      .map(wrapFileHandle);
    return {
      rootName: dirHandle.name,
      tableFiles,
      relationshipsFile,
      roleFiles,
      valid: tableFiles.length > 0,
      writable: true,
      dirHandle,
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
      writable: false,
      pagesDirHandle: null,
      pagesJsonFile: null,
    };
  }

  // Versión con permiso de lectura y escritura, necesaria para poder borrar
  // carpetas de página completas (page.json + sus visuales) y actualizar
  // pages.json.
  async function readReportFolderFromHandle(dirHandle) {
    const files = [];
    const dirs = [];
    await walkHandle(dirHandle, '', files, dirs);
    const jsonFiles = files
      .filter(e => /definition\/.*\.json$/i.test(e.relativePath))
      .map(e => ({ file: wrapFileHandle(e), relativePath: e.relativePath }));
    const rootName = dirHandle.name;
    const hasPages = jsonFiles.some(f => /pages\/[^/]+\/page\.json$/i.test(f.relativePath));
    const pagesDirEntry = dirs.find(d => /(^|\/)definition\/pages$/i.test(d.relativePath));
    const pagesJsonEntry = files.find(e => /definition\/pages\/pages\.json$/i.test(e.relativePath));
    return {
      rootName,
      jsonFiles,
      valid: hasPages,
      writable: true,
      dirHandle,
      pagesDirHandle: pagesDirEntry ? pagesDirEntry.handle : null,
      pagesJsonFile: pagesJsonEntry ? wrapFileHandle(pagesJsonEntry) : null,
    };
  }

  return {
    readSemanticModelFolder,
    readSemanticModelFolderFromHandle,
    readReportFolder,
    readReportFolderFromHandle,
  };
})();
