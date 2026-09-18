import * as THREE from 'three';
import { fullscreenVertex } from './shaders';
import { smoothFieldFragment } from './implicit-shaders';

/** Exercise the production filter over a sequence, not a single paused frame. */
export function validateTemporalSurface(renderer:THREE.WebGLRenderer){
  const texture=(values:number[])=>{const t=new THREE.DataTexture(new Float32Array(values),1,1,THREE.RGBAFormat,THREE.FloatType);t.needsUpdate=true;return t;};
  const field=texture([.02,24,0,1]),moments=texture([0,0,0,24]),spread=texture([0,0,0,0]);
  let previous=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
  let next=previous.clone();
  const uniforms={uField:{value:field},uMoments:{value:moments},uSpread:{value:spread},uHistory:{value:previous.texture},
    uFieldGrid:{value:new THREE.Vector3(1,1,1)},uColumns:{value:1},uFieldSize:{value:new THREE.Vector2(1,1)},uVoxel:{value:.035},
    uHasHistory:{value:false},uHistorySeconds:{value:1/60}};
  const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:smoothFieldFragment,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const target=renderer.getRenderTarget(),autoClear=renderer.autoClear,read=new Float32Array(4);
  const step=(value:number,speed:number,hasHistory=true)=>{
    field.image.data[0]=value;field.image.data[2]=speed;field.needsUpdate=true;
    uniforms.uHistory.value=previous.texture;uniforms.uHasHistory.value=hasHistory;
    renderer.setRenderTarget(next);renderer.render(scene,camera);renderer.readRenderTargetPixels(next,0,0,1,1,read);
    [previous,next]=[next,previous];return read[0];
  };
  try{
    renderer.autoClear=false;
    const initial=step(.02,0,false),samples:number[]=[];
    for(let i=0;i<90;i++){const value=step(.02+(i%2?-.002:.002),.02);if(i>=30)samples.push(value);}
    const rms=Math.sqrt(samples.reduce((s,v)=>s+(v-.02)**2,0)/samples.length);
    const moving=step(.022,.3),jump=step(.08,0),reset=step(.01,0,false);
    const checks={initialUnchanged:Math.abs(initial-.02)<1e-6,quietNoiseReduced:rms<.0004,
      movingSurfaceUnchanged:Math.abs(moving-.022)<1e-6,largeChangeImmediate:Math.abs(jump-.08)<1e-6,resetHasNoTrail:Math.abs(reset-.01)<1e-6};
    return {passed:Object.values(checks).every(Boolean),checks,inputRms:.002,outputRms:rms,moving,jump,reset};
  }finally{
    renderer.setRenderTarget(target);renderer.autoClear=autoClear;
    previous.dispose();next.dispose();field.dispose();moments.dispose();spread.dispose();geometry.dispose();material.dispose();
  }
}
