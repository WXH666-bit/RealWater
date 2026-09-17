import * as THREE from 'three';
import {common,fullscreenVertex,transportSampling} from './shaders';

/** A discretely solenoidal nonlinear fixture: u=x*y, v=-y*y/2, w=0.
 * Face differences cancel exactly, while ordinary MAC trilinear interpolation
 * has nonzero pointwise divergence between the y-face samples. */
export function validateTransport(renderer:THREE.WebGLRenderer){
  const grid=6,width=36,height=6,velocity=new Float32Array(width*height*4),boundary=new Float32Array(width*height*4).fill(1);
  const makeTexture=(data:Float32Array)=>{const t=new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);t.minFilter=t.magFilter=THREE.LinearFilter;t.needsUpdate=true;return t;};
  const flow=makeTexture(velocity),walls=makeTexture(boundary);
  const uniforms={uGrid:{value:new THREE.Vector3(6,6,6)},uOrigin:{value:new THREE.Vector3()},uCell:{value:1},uGridVelocity:{value:flow},uBoundary:{value:walls},uLinear:{value:new THREE.Vector3()},uAngular:{value:new THREE.Vector3()},uCenter:{value:new THREE.Vector3()},uProbe:{value:new THREE.Vector3()}};
  const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:common+transportSampling+`
    uniform vec3 uProbe;out vec4 result;
    void main(){
      float divergence=0.,h=.01;
      for(int axis=0;axis<3;axis++){vec3 d=vec3(0);d[axis]=h;divergence+=(transportVelocity(uProbe+d)[axis]-transportVelocity(uProbe-d)[axis])/(2.*h);}
      result=vec4(transportVelocity(uProbe),divergence);
    }
  `,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const scene=new THREE.Scene(),camera=new THREE.Camera(),quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
  const previousTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear,checks=[];
  const fixtures=[
    {name:'translation',value:(_x:number,_y:number,_z:number)=>[.7,-.3,.2]},
    {name:'rigid rotation',value:(x:number,y:number,z:number)=>[-.6*y+.2*z,.6*x-.3*z,-.2*x+.3*y]},
    {name:'shear and extension',value:(x:number,y:number,z:number)=>[.4*x+.3*y,-.1*y+.2*z,-.3*z]},
    {name:'nonlinear solenoidal',value:(x:number,y:number,_z:number)=>[x*y,-.5*y*y,0]},
  ];
  try{
    renderer.autoClear=false;
    for(const fixture of fixtures){
    for(let z=0;z<grid;z++)for(let y=0;y<grid;y++)for(let x=0;x<grid;x++)for(let axis=0;axis<3;axis++){
      const p=[x+.5,y+.5,z+.5];p[axis]-=.5;
      velocity[(y*width+x+z*grid)*4+axis]=fixture.value(p[0],p[1],p[2])[axis];
    }
    flow.needsUpdate=true;
    for(const x of [1.2,2,2.7])for(const y of [1.2,1.7,2.2,2.7]){
      uniforms.uProbe.value.set(x,y,2.1);renderer.setRenderTarget(target);renderer.render(scene,camera);
      const read=new Float32Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,read);
      const expected=fixture.value(x,y,2.1);
      const error=Math.max(...expected.map((value,i)=>Math.abs(read[i]-value)));
      checks.push({fixture:fixture.name,point:[x,y,2.1],divergence:read[3],velocityError:error,pass:Math.abs(read[3])<1e-4&&error<1e-5});
    }
    }
    return {passed:checks.every(c=>c.pass),checks};
  }finally{renderer.setRenderTarget(previousTarget);renderer.autoClear=autoClear;target.dispose();material.dispose();geometry.dispose();flow.dispose();walls.dispose();}
}
