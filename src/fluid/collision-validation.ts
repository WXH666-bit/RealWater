import * as THREE from 'three';
import {boxCollision,fullscreenVertex} from './shaders';

/** Run the production collision function with analytically known entry faces. */
export function validateCollisions(renderer:THREE.WebGLRenderer){
  const uniforms={uRadius:{value:0},uOld:{value:new THREE.Vector3()},uNew:{value:new THREE.Vector3()},uVelocity:{value:new THREE.Vector3()},uHalf:{value:new THREE.Vector3()}};
  const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:`
    precision highp float;
    uniform float uRadius;uniform vec3 uOld,uNew,uVelocity,uHalf;
    layout(location=0)out vec4 positionResult;layout(location=1)out vec4 velocityResult;
    ${boxCollision}
    void main(){vec3 p=uNew,v=uVelocity;collideBox(p,v,uOld,vec3(0),uHalf);positionResult=vec4(p,1);velocityResult=vec4(v,1);}
  `,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const target=new THREE.WebGLRenderTarget(1,1,{count:2,type:THREE.FloatType,depthBuffer:false});
  const previousTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear;
  const results=[];
  try{
    renderer.autoClear=false;
    for(let axis=0;axis<3;axis++)for(const sign of [-1,1])for(const start of [.2,.06])for(const endpoint of [.045,.2]){
      const old=new THREE.Vector3(),end=new THREE.Vector3(),velocity=new THREE.Vector3();
      old.setComponent(axis,-sign*start);end.setComponent(axis,sign*endpoint);velocity.setComponent(axis,sign*4);
      const tangent=(axis+1)%3;end.setComponent(tangent,.12);velocity.setComponent(tangent,.7);
      uniforms.uHalf.value.set(.72,.72,.72).setComponent(axis,.06);
      uniforms.uOld.value.copy(old);uniforms.uNew.value.copy(end);uniforms.uVelocity.value.copy(velocity);
      renderer.setRenderTarget(target);renderer.render(scene,camera);
      const p=new Float32Array(4),v=new Float32Array(4);
      renderer.readRenderTargetPixels(target,0,0,1,1,p,0,0);renderer.readRenderTargetPixels(target,0,0,1,1,v,0,1);
      const pass=sign*p[axis]<-.06&&Math.abs(p[tangent]-.12)<1e-5&&sign*v[axis]<=0&&Math.abs(v[tangent]-.7)<1e-5;
      results.push({axis,sign,start,endpoint,position:Array.from(p.slice(0,3)),velocity:Array.from(v.slice(0,3)),pass});
    }
    return {passed:results.every(result=>result.pass),checks:results};
  }finally{renderer.setRenderTarget(previousTarget);renderer.autoClear=autoClear;target.dispose();geometry.dispose();material.dispose();}
}
