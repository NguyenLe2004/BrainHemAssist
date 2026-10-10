import {fragSliceMMShader} from "@niivue-slice-source";

const states=new WeakMap();
const maps=new WeakMap();
const keyOf=region=>region.key??String(region.number);
const clamp=value=>Math.max(0,Math.min(1,Number(value)));

// A separate GPU ID texture makes display settings independent from the
// binary annotation, undo history, exported mask and inference probabilities.
const source=fragSliceMMShader
  .replace("uniform float drawOpacity;",`uniform float drawOpacity;
uniform highp usampler3D componentIds;
uniform highp sampler2D componentStyles;
uniform int componentFocus;
uniform vec3 componentCenter, componentRadius;`)
  .replace("vec4 dcolor = drawColor(drawV, drawOpacity);",`vec4 dcolor = drawColor(drawV, drawOpacity);
int componentId = int(texture(componentIds, texPos).r);
vec2 componentStyle = texelFetch(componentStyles, ivec2(componentId % 256, componentId / 256), 0).rg;
if (drawOpacity > 0.0 && drawV > 0.0) {
  float lutAlpha = dcolor.a / max(drawOpacity, 0.001);
  dcolor.a = lutAlpha * max(componentStyle.r, componentStyle.g > 0.0 ? 0.0001 : 0.0);
}`)
  .replace("if (drawRimOpacity >= 0.0)","if (componentStyle.g > 0.0)")
  .replace("dcolor.a = drawRimOpacity;","dcolor.a = componentStyle.g;")
  .replace(/\}\s*$/,`if (componentFocus > 0) {
  vec3 distanceFromCenter = abs((texPos - componentCenter) / componentRadius);
  float outside = max(distanceFromCenter.x, max(distanceFromCenter.y, distanceFromCenter.z));
  color.rgb *= mix(1.0, 0.16, smoothstep(0.9, 1.4, outside));
}
}`);

export function updateComponentDisplay(viewer,regions,styles={},focusKey=null,fill=.65,rim=.95) {
  const gl=viewer?.gl, dims=viewer?.volumes?.[0]?.dimsRAS;
  if(!gl||!dims||!viewer.drawBitmap||!regions.length)return;
  let state=states.get(viewer);
  if(!state){
    viewer.setCustomSliceShader(source);
    state={ids:gl.createTexture(),styles:gl.createTexture(),data:null,shader:viewer.customSliceShader};
    states.set(viewer,state);
    const original=viewer.drawScene.bind(viewer);
    viewer.drawScene=(...args)=>{
      gl.activeTexture(gl.TEXTURE0+14);gl.bindTexture(gl.TEXTURE_3D,state.ids);
      gl.activeTexture(gl.TEXTURE0+15);gl.bindTexture(gl.TEXTURE_2D,state.styles);
      return original(...args);
    };
  }
  let data=maps.get(regions);
  if(!data||data.bitmap.length!==viewer.drawBitmap.length){
    data={bitmap:new Uint16Array(viewer.drawBitmap.length),ids:new Map()};
    regions.forEach((region,index)=>{
      if(index>=65535)return;
      data.ids.set(keyOf(region),index+1);
      for(const voxel of region.voxels)data.bitmap[voxel]=index+1;
    });
    maps.set(regions,data);
  }
  if(state.data!==data){
    gl.activeTexture(gl.TEXTURE0+14);gl.bindTexture(gl.TEXTURE_3D,state.ids);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    for(const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T,gl.TEXTURE_WRAP_R])gl.texParameteri(gl.TEXTURE_3D,axis,gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D,0,gl.R16UI,dims[1],dims[2],dims[3],0,gl.RED_INTEGER,gl.UNSIGNED_SHORT,data.bitmap);
    state.data=data;
  }
  const height=Math.ceil((Math.min(regions.length,65535)+1)/256);
  const lookup=new Uint8Array(256*height*2);
  for(let index=0;index<lookup.length;index+=2){lookup[index]=Math.round(clamp(fill)*255);lookup[index+1]=Math.round(clamp(rim)*255);}
  regions.forEach(region=>{
    const id=data.ids.get(keyOf(region));if(!id)return;
    const custom=styles[keyOf(region)]||{};
    lookup[id*2]=Math.round(clamp(custom.fill??fill)*255);
    lookup[id*2+1]=Math.round(clamp(custom.rim??rim)*255);
  });
  gl.activeTexture(gl.TEXTURE0+15);gl.bindTexture(gl.TEXTURE_2D,state.styles);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,256,height,0,gl.RG,gl.UNSIGNED_BYTE,lookup);
  const shader=state.shader;shader.use(gl);
  const uniform=name=>gl.getUniformLocation(shader.program,name);
  gl.uniform1i(uniform("componentIds"),14);gl.uniform1i(uniform("componentStyles"),15);
  const focusKeys=new Set(Array.isArray(focusKey)?focusKey:focusKey?[focusKey]:[]);
  const focused=regions.filter(region=>focusKeys.has(keyOf(region)));
  const focus=focused.length?focused.reduce((combined,region)=>({
    center:[0,1,2].map(axis=>(Math.min(combined.bounds[`min${"XYZ"[axis]}`],region.bounds[`min${"XYZ"[axis]}`])+Math.max(combined.bounds[`max${"XYZ"[axis]}`],region.bounds[`max${"XYZ"[axis]}`]))/2),
    bounds:{
      minX:Math.min(combined.bounds.minX,region.bounds.minX),maxX:Math.max(combined.bounds.maxX,region.bounds.maxX),
      minY:Math.min(combined.bounds.minY,region.bounds.minY),maxY:Math.max(combined.bounds.maxY,region.bounds.maxY),
      minZ:Math.min(combined.bounds.minZ,region.bounds.minZ),maxZ:Math.max(combined.bounds.maxZ,region.bounds.maxZ),
    },
  }),focused[0]):null;
  gl.uniform1i(uniform("componentFocus"),focus?1:0);
  if(focus){
    const b=focus.bounds;
    gl.uniform3fv(uniform("componentCenter"),focus.center.map((v,i)=>(v+.5)/dims[i+1]));
    gl.uniform3fv(uniform("componentRadius"),[b.maxX-b.minX,b.maxY-b.minY,b.maxZ-b.minZ].map((v,i)=>(v/2+12)/dims[i+1]));
  }
  viewer.drawScene();
}

export function clearComponentDisplay(viewer) {
  const state=states.get(viewer);if(!state)return;
  // Keep the installed shader/textures valid for future draws, but remove focus
  // and restore global appearance when a mask becomes empty.
  state.shader.use(viewer.gl);
  viewer.gl.uniform1i(viewer.gl.getUniformLocation(state.shader.program,"componentFocus"),0);
  viewer.drawScene();
}

export function focusComponentCamera(viewer,region) {
  const dims=viewer?.volumes?.[0]?.dimsRAS;if(!dims||!region)return;
  const before={pan:[...viewer.scene.pan2Dxyzmm],crosshair:[...viewer.scene.crosshairPos]};
  viewer.scene.crosshairPos=region.center.map((v,i)=>(v+.5)/dims[i+1]);
  const mm=viewer.frac2mm(viewer.scene.crosshairPos);
  const b=region.bounds;
  const zoom=Math.max(1.5,Math.min(5,Math.min(dims[1],dims[2])/Math.max(b.maxX-b.minX+40,b.maxY-b.minY+40)));
  // NiiVue pan uses mm offsets from the image's world-space center.
  const center=viewer.frac2mm([.5,.5,.5]);
  viewer.setPan2Dxyzmm(Array.from(center).slice(0,3).map((v,i)=>v-mm[i]*zoom).concat(zoom));
  viewer.createOnLocationChange();viewer.drawScene();
  return before;
}
