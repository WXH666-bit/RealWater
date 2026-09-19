import * as THREE from 'three';
import {common,fullscreenVertex} from './shaders';

/** Check the production volume source independently of pressure convergence:
 * quiet water has no source, crowded water expands at a bounded rate, and
 * only an interior stencil may contract underdense liquid. */
export function validateVolumeSource(renderer:THREE.WebGLRenderer){
  const width=64,height=8,cell=.105,rest=6;
  const weights=new THREE.DataTexture(new Float32Array(width*height*4),width,height,THREE.RGBAFormat,THREE.FloatType);
  const boundary=new THREE.DataTexture(new Float32Array(width*height*4).fill(1),width,height,THREE.RGBAFormat,THREE.FloatType);boundary.needsUpdate=true;
  const uniforms={uGrid:{value:new THREE.Vector3(8,8,8)},uCell:{value:cell},uRestDensity:{value:rest},uWeights:{value:weights},uBoundary:{value:boundary}};
  const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:common+'out vec4 result;void main(){result=vec4(volumeSource(ivec3(3)),0,0,1);}',uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
  const previous=renderer.getRenderTarget(),autoClear=renderer.autoClear,checks=[];
  const fixtures=[
    {name:'rest',density:6,air:false,expected:0},
    {name:'lattice noise band',density:6.3,air:false,expected:0},
    {name:'crowded expansion',density:18,air:false,expected:cell*1.5*1.9},
    {name:'extreme crowding is bounded',density:600,air:false,expected:cell*6},
    {name:'interior contraction',density:4.8,air:false,expected:-cell*.15},
    {name:'surface is not contracted',density:4.8,air:true,expected:0},
  ];
  try{
    renderer.autoClear=false;
    for(const f of fixtures){
      for(let i=3;i<weights.image.data.length;i+=4)weights.image.data[i]=f.density;
      if(f.air)weights.image.data[(3*width+4+3*8)*4+3]=0;
      weights.needsUpdate=true;renderer.setRenderTarget(target);renderer.render(scene,camera);
      const result=new Float32Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,result);
      checks.push({name:f.name,actual:result[0],expected:f.expected,pass:Math.abs(result[0]-f.expected)<1e-6});
    }
    return {passed:checks.every(c=>c.pass),checks};
  }finally{renderer.setRenderTarget(previous);renderer.autoClear=autoClear;weights.dispose();boundary.dispose();target.dispose();geometry.dispose();material.dispose();}
}
