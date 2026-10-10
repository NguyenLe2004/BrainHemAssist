// NIfTI buffers use native voxel order; NiiVue drawings use anatomical RAS.
// Matching voxel counts alone cannot detect mirrored or permuted masks.
export function alignedSam2Mask(image, background) {
  if (!image?.img || typeof image.img2RAS !== "function") {
    throw new Error("Không đọc được mask MedSAM2");
  }
  const shape = image.dimsRAS?.slice(1, 4);
  const expected = background?.dimsRAS?.slice(1, 4);
  if (shape?.length !== 3 || expected?.length !== 3 || shape.some((size, axis) => size !== expected[axis])) {
    throw new Error("Mask MedSAM2 không cùng kích thước với ảnh CT");
  }
  if (image.matRAS?.length !== 16 || background.matRAS?.length !== 16 ||
      Array.from(image.matRAS).some((value, index) => !Number.isFinite(value) ||
        !Number.isFinite(background.matRAS[index]) ||
        Math.abs(value - background.matRAS[index]) > 0.001)) {
    throw new Error("Mask MedSAM2 không cùng tọa độ với ảnh CT");
  }
  return image.img2RAS();
}
