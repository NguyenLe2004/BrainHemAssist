self.onmessage = (event) => {
  const { requestId, bitmap, dims, voxelVolumeMl = 0, minVoxelCount = 20 } = event.data || {};
  const [dimX, dimY, dimZ] = dims || [];
  const sliceStride = dimX * dimY;
  const total = sliceStride * dimZ;

  if (!(bitmap instanceof Uint8Array) || !dimX || !dimY || !dimZ || bitmap.length !== total) {
    self.postMessage({ requestId, error: "Dữ liệu mặt nạ 3D không hợp lệ" });
    return;
  }

  const visited = new Uint8Array(total);
  const regions = [];
  const markedSliceSet = new Set();

  for (let seed = 0; seed < total; seed += 1) {
    if (bitmap[seed] === 0 || visited[seed]) continue;

    const queue = [seed];
    const voxels = [];
    visited[seed] = 1;
    let head = 0;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    let minIndex = seed;
    let maxIndex = seed;
    let minZ = dimZ;
    let maxZ = 0;
    let minX = dimX;
    let maxX = 0;
    let minY = dimY;
    let maxY = 0;
    let hash = 2166136261;

    while (head < queue.length) {
      const index = queue[head++];
      voxels.push(index);
      const z = Math.floor(index / sliceStride);
      markedSliceSet.add(z);
      const inSlice = index - z * sliceStride;
      const y = Math.floor(inSlice / dimX);
      const x = inSlice - y * dimX;

      sumX += x;
      sumY += y;
      sumZ += z;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (index < minIndex) minIndex = index;
      if (index > maxIndex) maxIndex = index;
      hash ^= index;
      hash = Math.imul(hash, 16777619) >>> 0;

      // A hand-drawn diagonal is visually continuous even when consecutive
      // voxels only touch at an edge or corner. Use 26-neighbour connectivity
      // so one brush stroke is reported and highlighted as one solid 3D region.
      for (let dz = -1; dz <= 1; dz += 1) {
        const nz = z + dz;
        if (nz < 0 || nz >= dimZ) continue;
        for (let dy = -1; dy <= 1; dy += 1) {
          const ny = y + dy;
          if (ny < 0 || ny >= dimY) continue;
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= dimX) continue;
            visit(nx + ny * dimX + nz * sliceStride);
          }
        }
      }
    }

    function visit(next) {
      if (!visited[next] && bitmap[next] !== 0) {
        visited[next] = 1;
        queue.push(next);
      }
    }

    const meanX = sumX / voxels.length;
    const meanY = sumY / voxels.length;
    const meanZ = sumZ / voxels.length;
    let representative = voxels[0];
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const index of voxels) {
      const z = Math.floor(index / sliceStride);
      const inSlice = index - z * sliceStride;
      const y = Math.floor(inSlice / dimX);
      const x = inSlice - y * dimX;
      const distance = (x - meanX) ** 2 + (y - meanY) ** 2 + (z - meanZ) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        representative = index;
      }
    }

    const centerZ = Math.floor(representative / sliceStride);
    const centerInSlice = representative - centerZ * sliceStride;
    const centerY = Math.floor(centerInSlice / dimX);
    const centerX = centerInSlice - centerY * dimX;
    const voxelArray = Uint32Array.from(voxels);
    voxelArray.sort();

    if (voxels.length < minVoxelCount) continue;
    regions.push({
      key: `${voxels.length}:${minIndex}:${maxIndex}:${hash}`,
      voxelCount: voxels.length,
      volumeMl: voxels.length * voxelVolumeMl,
      sliceStart: minZ,
      sliceEnd: maxZ,
      bounds: { minX, maxX, minY, maxY, minZ, maxZ },
      center: [centerX, centerY, centerZ],
      voxels: voxelArray,
    });
  }

  regions.sort((a, b) => b.voxelCount - a.voxelCount);
  regions.forEach((region, index) => { region.number = index + 1; });
  const markedSlices = [...markedSliceSet].sort((a, b) => a - b);
  self.postMessage(
    { requestId, regions, markedSlices },
    regions.map((region) => region.voxels.buffer),
  );
};
