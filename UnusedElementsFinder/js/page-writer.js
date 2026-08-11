// Borra páginas completas del reporte: la carpeta definition/pages/<id>/
// entera (page.json + sus visuales) y actualiza definition/pages/pages.json
// (pageOrder y, si hacía falta, activePageName) para que no quede una
// referencia colgando a una página que ya no existe.
//
// Antes de borrar, guarda una "foto" en memoria de todos los archivos de la
// carpeta (texto completo de cada uno) — es lo que permite restaurarla
// después desde la papelera, ya que removeEntry() no deja rastro alguno una
// vez borrado.
window.UEF = window.UEF || {};

UEF.PageWriter = (function () {

  async function snapshotDir(dirHandle, prefix, out) {
    for await (const [name, handle] of dirHandle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await snapshotDir(handle, relativePath, out);
      } else {
        const file = await handle.getFile();
        const text = await file.text();
        out.push({ relativePath, text });
      }
    }
  }

  // Devuelve { deletedCount, snapshots } — snapshots trae, por cada página
  // borrada, todos sus archivos (para poder reconstruirla) y su posición
  // original en pageOrder (para restaurarla más o menos donde estaba).
  async function deletePages(pageNames, reportInput) {
    if (!reportInput.writable) {
      throw new Error('Esta carpeta .Report se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    if (!reportInput.pagesDirHandle || !reportInput.pagesJsonFile) {
      throw new Error('No se encontró la carpeta de páginas o el archivo pages.json.');
    }
    if (!pageNames.length) return { deletedCount: 0, snapshots: [] };

    const currentText = await reportInput.pagesJsonFile.text();
    const currentJson = JSON.parse(currentText);
    const currentOrder = currentJson.pageOrder || [];

    const snapshots = [];
    for (const pageName of pageNames) {
      try {
        const pageDirHandle = await reportInput.pagesDirHandle.getDirectoryHandle(pageName);
        const files = [];
        await snapshotDir(pageDirHandle, '', files);
        snapshots.push({ pageName, files, originalIndex: currentOrder.indexOf(pageName) });
      } catch (err) {
        throw new Error(`No se pudo leer la carpeta de la página "${pageName}" antes de borrarla: ${err.message}`);
      }
    }

    for (const pageName of pageNames) {
      try {
        await reportInput.pagesDirHandle.removeEntry(pageName, { recursive: true });
      } catch (err) {
        throw new Error(`No se pudo borrar la carpeta de la página "${pageName}": ${err.message}`);
      }
    }

    const removed = new Set(pageNames);
    const newPageOrder = currentOrder.filter(p => !removed.has(p));
    let newActivePageName = currentJson.activePageName;
    if (removed.has(newActivePageName)) {
      newActivePageName = newPageOrder[0] || null;
    }
    const newJson = { ...currentJson, pageOrder: newPageOrder };
    if (newActivePageName) newJson.activePageName = newActivePageName;
    else delete newJson.activePageName;

    const writable = await reportInput.pagesJsonFile.handle.createWritable();
    await writable.write(JSON.stringify(newJson, null, 2));
    await writable.close();

    return { deletedCount: pageNames.length, snapshots };
  }

  // Reconstruye una página a partir de su foto (ver deletePages arriba) y
  // la vuelve a insertar en pageOrder, lo más cerca posible de su posición
  // original.
  async function restorePage(snapshot, reportInput) {
    if (!reportInput.writable) {
      throw new Error('Esta carpeta .Report se abrió en modo solo lectura: no se puede escribir de vuelta al disco.');
    }
    if (!reportInput.pagesDirHandle || !reportInput.pagesJsonFile) {
      throw new Error('No se encontró la carpeta de páginas o el archivo pages.json.');
    }

    const pageDirHandle = await reportInput.pagesDirHandle.getDirectoryHandle(snapshot.pageName, { create: true });
    for (const file of snapshot.files) {
      const parts = file.relativePath.split('/');
      let dir = pageDirHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
      }
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(file.text);
      await writable.close();
    }

    const currentText = await reportInput.pagesJsonFile.text();
    const currentJson = JSON.parse(currentText);
    const pageOrder = (currentJson.pageOrder || []).filter(p => p !== snapshot.pageName);
    const insertAt = Number.isInteger(snapshot.originalIndex) && snapshot.originalIndex >= 0
      ? Math.min(snapshot.originalIndex, pageOrder.length)
      : pageOrder.length;
    pageOrder.splice(insertAt, 0, snapshot.pageName);
    const newJson = { ...currentJson, pageOrder };
    const writable2 = await reportInput.pagesJsonFile.handle.createWritable();
    await writable2.write(JSON.stringify(newJson, null, 2));
    await writable2.close();
  }

  return { deletePages, restorePage };
})();
