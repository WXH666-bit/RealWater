import * as THREE from 'three';
import { FIXED_DT, GRAVITY } from '../config';
import { fullscreenVertex, particleFragment } from './shaders';

/** Production particle integration in an upward grid field. Sparse spray must
 * fall despite that field; immersed markers must still follow the liquid. */
export function validateSpray(renderer:THREE.WebGLRenderer){
  const textures:THREE.DataTexture[]=[];
  const texture=(values:number[],w=1,h=1)=>{
    const data=new Float32Array(w*h*4);
    for(let i=0;i<w*h;i++)data.set(values,i*4);
    const t=new THREE.DataTexture(data,w,h,THREE.RGBAFormat,THREE.FloatType);
    t.needsUpdate=true;textures.push(t);return t;
  };
  const weights=texture([0,0,0,0],64,8);
  const uniforms={
    uGrid:{value:new THREE.Vector3(8,8,8)},uOrigin:{value:new THREE.Vector3(-4,-3,-4)},
    uCell:{value:1},uDt:{value:FIXED_DT},uGravity:{value:GRAVITY},uRadius:{value:.05},uRestDensity:{value:1000},
    uPositions:{value:texture([0,.3,0,1])},uVelocities:{value:texture([0,0,0,1])},
    uSeeds:{value:texture([0,0,0,0])},uWeights:{value:weights},
    uGridVelocity:{value:texture([0,2,0,7],64,8)},uBoundary:{value:texture([1,1,1,1],64,8)},
    uCenter:{value:new THREE.Vector3()},uPreviousCenter:{value:new THREE.Vector3()},
    uLinear:{value:new THREE.Vector3()},uAngular:{value:new THREE.Vector3()},
    uRotation:{value:new THREE.Matrix3()},uInverse:{value:new THREE.Matrix3()},uPreviousInverse:{value:new THREE.Matrix3()},
    uViewProjection:{value:new THREE.Matrix4()},uInjectOnly:{value:false},uEmissionVelocity:{value:0},
  };
  const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:particleFragment,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const target=new THREE.WebGLRenderTarget(1,1,{count:2,type:THREE.FloatType,depthBuffer:false});
  const previousTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear,checks=[];
  try{
    renderer.autoClear=false;
    for(const [name,support,coupling,x,y] of [['empty air',0,0,0,.3],['isolated marker',1,0,0,.3],['transition',1.375,.5,0,.3],['immersed',6,1,0,.3],['outside glass',6,0,1.46,.3],['above rim',6,0,0,1.5]] as const){
      uniforms.uPositions.value.image.data.set([x,y,0,1]);uniforms.uPositions.value.needsUpdate=true;
      for(let i=3;i<weights.image.data.length;i+=4)weights.image.data[i]=support;
      weights.needsUpdate=true;
      renderer.setRenderTarget(target);renderer.render(scene,camera);
      const p=new Float32Array(4),v=new Float32Array(4);
      renderer.readRenderTargetPixels(target,0,0,1,1,p,0,0);renderer.readRenderTargetPixels(target,0,0,1,1,v,0,1);
      const expected=-GRAVITY*FIXED_DT*(1-coupling)+2*coupling;
      checks.push({name,velocityY:v[1],expected,positionY:p[1],pass:Math.abs(v[1]-expected)<1e-5&&Math.abs(p[1]-(y+expected*FIXED_DT))<1e-5&&p[3]===1});
    }
    return {passed:checks.every(c=>c.pass),checks};
  }finally{renderer.setRenderTarget(previousTarget);renderer.autoClear=autoClear;textures.forEach(t=>t.dispose());target.dispose();geometry.dispose();material.dispose();}
}
