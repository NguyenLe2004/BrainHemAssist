export const CONFIDENCE_COLORMAP = "brainhem-confidence";

// Keep model probabilities untouched. Extra stops above 0.7 preserve visible
// differences inside a lesion instead of turning its high-confidence core white.
export const CONFIDENCE_LUT = {
  R: [80, 238, 255, 255, 240, 205],
  G: [24, 185, 116, 62, 34, 22],
  B: [42, 55, 48, 67, 105, 132],
  A: [0, 92, 148, 198, 230, 248],
  I: [0, 127, 178, 217, 242, 255],
};

export function installConfidenceColormap(viewer) {
  viewer?.addColormap?.(CONFIDENCE_COLORMAP, CONFIDENCE_LUT);
}
