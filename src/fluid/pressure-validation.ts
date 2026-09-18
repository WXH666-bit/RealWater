import * as THREE from 'three';
import { fullscreenVertex, pressureFragment, projectFragment } from './shaders';

/** Hydrostatic column with an analytic free surface between grid centres. */
export function validateFreeSurfacePressure(renderer:THREE.WebGLRenderer){
  const size=8,g=.2,textures:THREE.Texture[]=[],targets:THREE.WebGLRenderTarget[]=[];
  const data=(fn:(i:number)=>number[])=>{
    const t=new THREE.DataTexture(new Float32Array(Array.from({length:size},(_,i)=>fn(i)).flat()),1,size,THREE.RGBAFormat,THREE.FloatType);
    t.needsUpdate=true;textures.push(t);return t;
  };
  const target=(type:THREE.TextureDataType=THREE.FloatType)=>{const t=new THREE.WebGLRenderTarget(1,size,{type,depthBuffer:false});targets.push(t);return t;};
  const projected=target();
  const weights=data(()=>[0,0,0,0]);
  const uniforms={uGrid:{value:new THREE.Vector3(1,size,1)},uOrigin:{value:new THREE.Vector3()},uCell:{value:1},uRestDensity:{value:1},
    uBoundary:{value:data(i=>[0,i===0?0:1,0,1])},uWeights:{value:weights},uPressure:{value:projected.texture},
    uDivergence:{value:data(i=>[i===0?-g:0,0,0,1])},uGridVelocity:{value:data(()=>[0,-g,0,7])},
    uCenter:{value:new THREE.Vector3()},uLinear:{value:new THREE.Vector3()},uAngular:{value:new THREE.Vector3()}};
  const make=(fragmentShader:string)=>new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const solve=make(pressureFragment),project=make(projectFragment);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,solve);quad.frustumCulled=false;scene.add(quad);
  const oldTarget=renderer.getRenderTarget(),oldClear=renderer.autoClear,oldColor=renderer.getClearColor(new THREE.Color()),oldAlpha=renderer.getClearAlpha();
  const read=new Float32Array(size*4),halfRead=new Uint16Array(size*4),checks:{precision:string;fraction:number;pressureError:number;maxSpeed:number;pass:boolean}[]=[];
  try{
    renderer.autoClear=false;renderer.setClearColor(0,0);
    for(const type of [THREE.FloatType,THREE.HalfFloatType]){
    let pressure=target(type),next=target(type);
    for(const fraction of [.1,.25,.5,.75,1]){
      for(let i=0;i<size;i++)weights.image.data[i*4+3]=i<5?2:i===5?.5+.4*fraction:.5-.4*(1-fraction);
      weights.needsUpdate=true;
      renderer.setRenderTarget(pressure);renderer.clear();renderer.setRenderTarget(next);renderer.clear();quad.material=solve;
      for(let iteration=0;iteration<350;iteration++){
        uniforms.uPressure.value=pressure.texture;renderer.setRenderTarget(next);renderer.render(scene,camera);[pressure,next]=[next,pressure];
      }
      if(type===THREE.HalfFloatType){
        renderer.readRenderTargetPixels(pressure,0,0,1,size,halfRead);
        read.set(Array.from(halfRead,value=>THREE.DataUtils.fromHalfFloat(value)));
      }else renderer.readRenderTargetPixels(pressure,0,0,1,size,read);
      const pressureError=Math.max(...Array.from({length:6},(_,i)=>Math.abs(read[i*4]-g*(5-i+fraction))));
      uniforms.uPressure.value=pressure.texture;quad.material=project;renderer.setRenderTarget(projected);renderer.render(scene,camera);
      renderer.readRenderTargetPixels(projected,0,0,1,size,read);
      const maxSpeed=Math.max(...Array.from({length:7},(_,i)=>Math.abs(read[i*4+1])));
      // Half precision accumulates rounding in the production pressure targets.
      const tolerance=type===THREE.HalfFloatType?.006:.001;
      checks.push({precision:type===THREE.HalfFloatType?'float16':'float32',fraction,pressureError,maxSpeed,pass:pressureError<tolerance&&maxSpeed<tolerance});
    }
    }
    return {passed:checks.every(c=>c.pass),checks};
  }finally{
    renderer.setRenderTarget(oldTarget);renderer.autoClear=oldClear;renderer.setClearColor(oldColor,oldAlpha);
    textures.forEach(t=>t.dispose());targets.forEach(t=>t.dispose());geometry.dispose();solve.dispose();project.dispose();
  }
}
