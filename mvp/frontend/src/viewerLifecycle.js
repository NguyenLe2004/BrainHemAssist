const attachments = new WeakMap();
const disposed = new WeakSet();

export function attachViewer(viewer, canvas) {
  if (disposed.has(viewer)) return Promise.resolve(null);
  if (!attachments.has(viewer)) {
    attachments.set(viewer, viewer.attachToCanvas(canvas).then(() => {
      if (disposed.has(viewer)) return null;
      return viewer;
    }).catch(error => {
      if (disposed.has(viewer)) return null;
      throw error;
    }));
  }
  return attachments.get(viewer);
}

export function disposeViewer(viewer) {
  if (!viewer || disposed.has(viewer)) return;
  disposed.add(viewer);
  viewer.onLocationChange = () => {};
  viewer.onDrawingChanged = () => {};
  viewer.onIntensityChange = () => {};
  viewer.cleanup();
  // NiiVue cleanup removes listeners, but leaves its WebGL context allocated.
  // Release it explicitly instead of waiting for detached canvases to be GC'd.
  viewer._gl?.getExtension('WEBGL_lose_context')?.loseContext();
  viewer.volumes = [];
  viewer.drawBitmap = null;
}
