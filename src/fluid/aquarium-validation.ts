import * as THREE from 'three';
import {AquariumSystem,FISH_KINDS,FISH_LIMIT} from '../aquarium';
import {FIXED_DT,TANK} from '../config';
import type {FluidSolver} from './solver';
import {fullscreenVertex} from './shaders';
import {fishRayShader} from './fish-shaders';
import {dielectricOptics,interiorRadiance} from './implicit-shaders';

/** Real GPU kernels, deterministic water/velocity fixtures, no production water mutation. */
export function validateAquarium(renderer:THREE.WebGLRenderer){
  const results:{name:string;pass:boolean;detail?:unknown}[]=[];
  const check=(name:string,pass:boolean,detail?:unknown)=>results.push({name,pass,detail});
  const textures:THREE.DataTexture[]=[];
  const texture=(data:Float32Array,w:number,h:number)=>{
    const t=new THREE.DataTexture(data,w,h,THREE.RGBAFormat,THREE.FloatType);t.needsUpdate=true;textures.push(t);return t;
  };
  const water=new Float32Array(8*8*8*4);for(let i=3;i<water.length;i+=4)water[i]=1;
  const weights=texture(water,64,8),flow=texture(new Float32Array(water.length),64,8);
  const fixture={revision:1,uniforms:{
    uGrid:{value:new THREE.Vector3(8,8,8)},uOrigin:{value:new THREE.Vector3(-1.6,-1.6,-1.6)},uCell:{value:.4},uDt:{value:FIXED_DT},
    uCenter:{value:new THREE.Vector3()},uRotation:{value:new THREE.Matrix3()},uInverse:{value:new THREE.Matrix3()},
    uRestDensity:{value:1},uWeights:{value:weights},uGridVelocity:{value:flow},
  }} as unknown as FluidSolver;
  const aquarium=new AquariumSystem(renderer,fixture);
  const previous=renderer.getRenderTarget(),auto=renderer.autoClear;
  const scene=new THREE.Scene(),camera=new THREE.Camera();
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const positions=new Float32Array(48),headings=new Float32Array(48);
  positions.set([0,0,.3,1]);positions.set([0,0,-.3,2],4);headings.set([1,0,0,0]);headings.set([1,0,0,0],4);
  const p=texture(positions,12,1),h=texture(headings,12,1),v=texture(new Float32Array(48),12,1);
  const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,glslVersion:THREE.GLSL3,defines:{AQUARIUM:1},depthTest:false,depthWrite:false,
    uniforms:{uFishPosition:{value:p},uFishHeading:{value:h},uFishVelocity:{value:v},uFishCount:{value:2},uMode:{value:0},uRayOrigin:{value:new THREE.Vector3(0,0,1)}},
    fragmentShader:`precision highp float;precision highp int;`+fishRayShader+dielectricOptics+`
      bool waterExit(vec3 p,vec3 d,out vec3 end,out float distance){distance=(-1.-p.z)/d.z;end=p+d*distance;return true;}
      vec3 surfaceNormal(vec3 p){return vec3(0,0,-1);}
      vec3 transmittedBackground(vec3 p,vec3 d,vec3 camera,float height){return vec3(0);}
    `+interiorRadiance+`
      uniform int uMode;uniform vec3 uRayOrigin;out vec4 result;
      void main(){float distance;vec3 color,status;bool found=fishHit(uRayOrigin,vec3(0,0,-1),3.,distance,color);
        if(uMode==0)result=vec4(color,found?distance:-1.);
        else result=vec4(traceInterior(uRayOrigin,vec3(0,0,-1),uRayOrigin,720.,distance,status),distance);
      }`});
  const quad=new THREE.Mesh(geometry,material);quad.frustumCulled=false;scene.add(quad);
  const output=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
  const probe=()=>{renderer.setRenderTarget(output);renderer.render(scene,camera);const data=new Float32Array(4);renderer.readRenderTargetPixels(output,0,0,1,1,data);return Array.from(data);};
  try{
    for(let i=0;i<FISH_LIMIT;i++)check(`add ${i+1}`,aquarium.add(FISH_KINDS[i%3])==='added');
    check('capacity rejection',aquarium.add('blue')==='capacity'&&aquarium.count===12);
    const initial=aquarium.inspect();
    for(let i=0;i<90;i++)aquarium.step();
    const after=aquarium.inspect();
    check('finite and inside tank',after.length===12&&after.every(f=>f.position.every((x,i)=>Number.isFinite(x)&&Math.abs(x)<TANK.getComponent(i)-.19)));
    check('autonomous movement',after.some((f,i)=>new THREE.Vector3(...f.position).distanceTo(new THREE.Vector3(...initial[i].position))>.03));
    const saved=aquarium.snapshot();aquarium.clear();check('clear',aquarium.count===0);
    check('restore kinds',aquarium.restore(saved)===0&&aquarium.snapshot().join()===saved.join());
    fixture.revision=0;let fullRestore=true;
    for(let i=0;i<5;i++){aquarium.clear();fullRestore=aquarium.restore(saved)===0&&aquarium.count===12&&fullRestore;}
    check('repeat full half-tank restoration',fullRestore);fixture.revision=1;
    aquarium.clear();aquarium.add('clown');for(let i=0;i<45;i++)aquarium.step();const stillX=aquarium.inspect()[0].position[0];
    const current=flow.image.data as Float32Array;for(let i=0;i<current.length;i+=4)current[i]=.5;flow.needsUpdate=true;
    aquarium.clear();aquarium.add('clown');for(let i=0;i<45;i++)aquarium.step();
    check('one-way current drift',aquarium.inspect()[0].position[0]>stillX+.015);
    aquarium.clear();aquarium.restore(saved);
    water.fill(0);weights.needsUpdate=true;
    for(let i=0;i<30;i++)aquarium.step();check('dry grace period',aquarium.inspect().length===12);
    for(let i=0;i<20;i++)aquarium.step();check('dry collection after half second',aquarium.inspect().length===0);
    check('reject dry addition',aquarium.add('yellow')==='dry');
    for(let i=3;i<water.length;i+=4)water[i]=1;weights.needsUpdate=true;
    const rotation=new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.6,0,.7,'YXZ')));
    fixture.uniforms.uRotation.value.copy(rotation);fixture.uniforms.uInverse.value.copy(rotation).transpose();
    aquarium.clear();aquarium.add('clown');aquarium.add('blue');for(let i=0;i<90;i++)aquarium.step();
    const tilted=aquarium.inspect();check('rotated wall clearance',tilted.length===2&&tilted.every(f=>{
      const p=new THREE.Vector3(...f.position).applyMatrix3(fixture.uniforms.uInverse.value);
      return p.toArray().every((v,i)=>Math.abs(v)<TANK.getComponent(i)-.205);
    }));
    const near=probe();check('nearest body occludes rear fish',near[3]>.64&&near[3]<.7,near);
    positions[3]=0;p.needsUpdate=true;const far=probe();check('rear body revealed',far[3]>1.25&&far[3]<1.31,far);
    positions[3]=1;p.needsUpdate=true;headings[3]=.1;h.needsUpdate=true;const dry=probe();check('dry fish invisible',Math.abs(dry[3]-far[3])<1e-5);
    headings[3]=0;h.needsUpdate=true;material.uniforms.uMode.value=1;
    const optical=probe();const expected=near.slice(0,3).map((c,i)=>{const absorption=Math.exp(-[.065,.015,.008][i]*near[3]);return c*absorption+[.008,.025,.032][i]*(1-absorption);});
    check('water absorption uses fish depth',expected.every((c,i)=>Math.abs(c-optical[i])<1e-4),{optical,expected});
    material.uniforms.uMode.value=0;material.uniforms.uRayOrigin.value.x=1;check('ray miss',probe()[3]===-1);
    return {passed:results.every(r=>r.pass),checks:results};
  }finally{aquarium.dispose();textures.forEach(t=>t.dispose());geometry.dispose();material.dispose();output.dispose();renderer.autoClear=auto;renderer.setRenderTarget(previous);}
}
