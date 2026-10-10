function clampVoxel(value, size) {
  return Math.max(0, Math.min(size - 1, Math.round(value)));
}

/**
 * Commit a pointer gesture as one dense 2D brush stroke in a 3D bitmap.
 *
 * Browser pointer events may be much farther apart than adjacent voxels on a
 * 512px CT image. Interpolating in voxel space makes the saved mask match the
 * continuous cursor trail that the editor shows. The fixed plane also prevents
 * a brush gesture from accidentally painting neighbouring slices.
 */
export function rasterizeBrushStroke(bitmap, dims, axis, fixed, points, penSize, value) {
  if (!bitmap || !Array.isArray(dims) || dims.length !== 3 || !points?.length) return false;
  if (![0, 1, 2].includes(axis) || dims.some(size => !Number.isFinite(size) || size < 1)) return false;

  const planeAxes = [0, 1, 2].filter(candidate => candidate !== axis);
  const fixedVoxel = clampVoxel(fixed, dims[axis]);
  const radius = Math.max(0, Math.floor(Math.max(1, penSize) / 2));
  const nextValue = value > 0 ? 1 : 0;
  let changed = false;

  const paint = (rawU, rawV) => {
    const centerU = clampVoxel(rawU, dims[planeAxes[0]]);
    const centerV = clampVoxel(rawV, dims[planeAxes[1]]);
    for (let dv = -radius; dv <= radius; dv += 1) {
      for (let du = -radius; du <= radius; du += 1) {
        // A circular stamp gives the physician an honest size preview and
        // avoids the blocky corners of NiiVue's default square pen.
        if (du * du + dv * dv > radius * radius) continue;
        const u = centerU + du;
        const v = centerV + dv;
        if (u < 0 || u >= dims[planeAxes[0]] || v < 0 || v >= dims[planeAxes[1]]) continue;
        const coordinate = [0, 0, 0];
        coordinate[axis] = fixedVoxel;
        coordinate[planeAxes[0]] = u;
        coordinate[planeAxes[1]] = v;
        const index = coordinate[0] + coordinate[1] * dims[0] + coordinate[2] * dims[0] * dims[1];
        if (bitmap[index] !== nextValue) {
          bitmap[index] = nextValue;
          changed = true;
        }
      }
    }
  };

  const normalized = points.map(point => [
    clampVoxel(point[planeAxes[0]], dims[planeAxes[0]]),
    clampVoxel(point[planeAxes[1]], dims[planeAxes[1]]),
  ]);
  paint(normalized[0][0], normalized[0][1]);
  for (let index = 1; index < normalized.length; index += 1) {
    const [fromU, fromV] = normalized[index - 1];
    const [toU, toV] = normalized[index];
    const steps = Math.max(Math.abs(toU - fromU), Math.abs(toV - fromV), 1);
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      paint(
        Math.round(fromU + (toU - fromU) * ratio),
        Math.round(fromV + (toV - fromV) * ratio),
      );
    }
  }
  return changed;
}

/** Fill the inside of a brush gesture when the physician closes the loop. */
export function fillClosedBrushStroke(bitmap, dims, axis, fixed, points, penSize) {
  if (!bitmap || !points || points.length < 3 || ![0, 1, 2].includes(axis)) return false;
  const planeAxes = [0, 1, 2].filter(candidate => candidate !== axis);
  const vertices = points.map(point => [point[planeAxes[0]], point[planeAxes[1]]]);
  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  const closeRadius = Math.max(3, Math.ceil(Math.max(1, penSize) * 1.5));
  if (Math.hypot(last[0] - first[0], last[1] - first[1]) > closeRadius) return false;

  const minU = Math.max(0, Math.floor(Math.min(...vertices.map(point => point[0]))));
  const maxU = Math.min(dims[planeAxes[0]] - 1, Math.ceil(Math.max(...vertices.map(point => point[0]))));
  const minV = Math.max(0, Math.floor(Math.min(...vertices.map(point => point[1]))));
  const maxV = Math.min(dims[planeAxes[1]] - 1, Math.ceil(Math.max(...vertices.map(point => point[1]))));
  // A click or tiny curl is still a brush dab, not a region contour.
  if (maxU - minU < Math.max(3, penSize) || maxV - minV < Math.max(3, penSize)) return false;

  const fixedVoxel = clampVoxel(fixed, dims[axis]);
  let changed = false;
  for (let v = minV; v <= maxV; v += 1) {
    const intersections = [];
    const scanV = v + 0.5;
    for (let index = 0, previous = vertices.length - 1; index < vertices.length; previous = index, index += 1) {
      const [u1, v1] = vertices[previous];
      const [u2, v2] = vertices[index];
      if ((v1 > scanV) === (v2 > scanV)) continue;
      intersections.push(u1 + ((scanV - v1) * (u2 - u1)) / (v2 - v1));
    }
    intersections.sort((a, b) => a - b);
    for (let pair = 0; pair + 1 < intersections.length; pair += 2) {
      const start = Math.max(minU, Math.ceil(intersections[pair]));
      const end = Math.min(maxU, Math.floor(intersections[pair + 1]));
      for (let u = start; u <= end; u += 1) {
        const coordinate = [0, 0, 0];
        coordinate[axis] = fixedVoxel;
        coordinate[planeAxes[0]] = u;
        coordinate[planeAxes[1]] = v;
        const voxelIndex = coordinate[0] + coordinate[1] * dims[0] + coordinate[2] * dims[0] * dims[1];
        if (bitmap[voxelIndex] === 0) {
          bitmap[voxelIndex] = 1;
          changed = true;
        }
      }
    }
  }
  return changed;
}
