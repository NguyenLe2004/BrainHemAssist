// Update a RAS drawing subvolume without copying/uploading the entire CT mask.
export function unionDrawingBounds(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function updateDrawingTextureBox(viewer, bitmap, bounds) {
  const gl = viewer?.gl;
  const dims = viewer?.back?.dims;
  if (!gl || gl.isContextLost() || !viewer.drawTexture || !dims || !bounds || viewer.opts.is2DSliceShader) return false;
  const width = dims[1], height = dims[2], depth = dims[3];
  if (bitmap.length !== width * height * depth) return false;
  const x = Math.max(0, bounds.minX), y = Math.max(0, bounds.minY), z = Math.max(0, bounds.minZ);
  const nx = Math.min(width - 1, bounds.maxX) - x + 1;
  const ny = Math.min(height - 1, bounds.maxY) - y + 1;
  const nz = Math.min(depth - 1, bounds.maxZ) - z + 1;
  if (![x, y, z, nx, ny, nz].every(Number.isInteger) || nx <= 0 || ny <= 0 || nz <= 0) return false;
  const active = gl.getParameter(gl.ACTIVE_TEXTURE);
  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
  const rowLength = gl.getParameter(gl.UNPACK_ROW_LENGTH);
  const imageHeight = gl.getParameter(gl.UNPACK_IMAGE_HEIGHT);
  gl.activeTexture(gl.TEXTURE0 + 7);
  const texture = gl.getParameter(gl.TEXTURE_BINDING_3D);
  try {
    gl.bindTexture(gl.TEXTURE_3D, viewer.drawTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, height);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, x, y, z, nx, ny, nz, gl.RED, gl.UNSIGNED_BYTE, bitmap, z * width * height + y * width + x);
    viewer.drawBitmap = bitmap;
  } finally {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLength);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, imageHeight);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.activeTexture(active);
  }
  return true;
}
