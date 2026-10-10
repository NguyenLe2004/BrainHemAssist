import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Keep NiiVue's native drawing shader. A previous custom soft-outline shader
// made valid binary label 1 invisible in the clinical viewer.
const files = [
  "node_modules/@niivue/niivue/build/niivue/index.js",
  "node_modules/@niivue/niivue/dist/index.js",
  "node_modules/@niivue/niivue/dist/niivue.umd.js",
];
const startMarker = "\tfloat drawV = texture(drawing, texPos).r;";
const endMarker = "\tvec4 pcolor = texture(paqd, texPos);";
const replacement = `\tfloat drawV = texture(drawing, texPos).r;
\tvec4 dcolor = drawColor(drawV, drawOpacity);
\tif (dcolor.a > 0.0) {
\t\tif (drawRimOpacity >= 0.0) {
\t\t\tvec3 vx = 1.0 / vec3(textureSize(drawing, 0));
\t\t\t// 4 in-plane voxel neighbors
\t\t\tvec3 offsetX = dFdx(texPos);
\t\t\tvec3 offsetY = dFdy(texPos);
\t\t\tfloat L = texture(drawing, texPos - offsetX).r;
\t\t\tfloat R = texture(drawing, texPos + offsetX).r;
\t\t\tfloat T = texture(drawing, texPos - offsetY).r;
\t\t\tfloat B = texture(drawing, texPos + offsetY).r;
\t\t\tif (L != drawV || R != drawV || T != drawV || B != drawV)
\t\t\t\tdcolor.a = drawRimOpacity;
\t\t}
\t\tcolor.rgb = mix(color.rgb, dcolor.rgb, dcolor.a);
\t\tcolor.a = max(drawOpacity, color.a);
\t}
`;

for (const relative of files) {
  const path = resolve(relative);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, "utf8");
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    console.warn(`[niivue-outline] shader block not found in ${relative}`);
    continue;
  }
  let next = source.slice(0, start) + replacement + source.slice(end);
  next = next.replaceAll(
    "drawTexture: this.drawSmoothedTexture || this.drawTexture,",
    "drawTexture: this.drawTexture,",
  );
  next = next.replace(
    "this.blurDrawingGL(dims);\n      this.gl.activeTexture(TEXTURE_CONSTANTS.TEXTURE7_DRAW);\n      this.gl.bindTexture(this.gl.TEXTURE_3D, this.drawSmoothedTexture || this.drawTexture);\n    }\n    if (isForceRedraw)",
    "this.blurDrawingGL(dims);\n    }\n    if (isForceRedraw)",
  );
  if (next === source) continue;
  writeFileSync(path, next);
  console.log(`[niivue-outline] patched ${relative}`);
}
