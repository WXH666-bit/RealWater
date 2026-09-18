import * as THREE from 'three';
import { PROFILES, type Quality } from '../config';
import { fullscreenVertex } from './shaders';
import { dielectricOptics, fieldCommon, surfaceTracing, interiorRadiance } from './implicit-shaders';

/** Development-only GPU checks of the exact tracing functions used by water.
 * Analytic slabs/spheres provide independent exit positions and Snell angles. */
export function validateOptics(renderer:THREE.WebGLRenderer){
  const scene=new THREE.Scene(),camera=new THREE.Camera();
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const uniforms:Record<string,THREE.IUniform>={
    uFieldGrid:{value:new THREE.Vector3()},uFieldOrigin:{value:new THREE.Vector3(-2,-2,-2)},
    uVoxel:{value:0},uColumns:{value:0},uFieldSize:{value:new THREE.Vector2()},uSupport:{value:.2},
    uField:{value:null},uFieldMetadata:{value:null},uMoments:{value:null},uFixture:{value:0},uEntry:{value:new THREE.Vector3(0,.3,0)},
    uClipToTank:{value:false},uCenter:{value:new THREE.Vector3()},uInverse:{value:new THREE.Matrix3()},uRotation:{value:new THREE.Matrix3()},
    uRay:{value:new THREE.Vector3(0,-1,0)},uTestMode:{value:0},uEta:{value:1/1.333},uInterior:{value:0},
  };
  const make=(fragmentShader:string)=>new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const field=make(fieldCommon+`
    uniform int uFixture;uniform float uInterior;
    layout(location=0)out vec4 phi;layout(location=1)out vec4 moments;
    void main(){
      vec3 p=voxelWorld(fieldCoord(gl_FragCoord.xy));
      float distance=uFixture==2?-uInterior:uFixture==0?abs(p.y)-.3:length(p)-.12;
      // Match the bounded interior magnitude of particle reconstruction.
      phi=vec4(max(distance,-uInterior),8,0,1);moments=vec4(0,0,0,8);
    }`);
  const probe=make(fieldCommon+dielectricOptics+surfaceTracing+`
    vec3 transmittedBackground(vec3 point,vec3 direction,vec3 cameraPosition,float height){return vec3(1);}
  `+interiorRadiance+`
    uniform vec3 uEntry;uniform vec3 uRay;uniform int uTestMode;uniform float uEta;
    out vec4 result;
    void main(){
      if(uTestMode==1){vec3 t=refract(uRay,vec3(0,1,0),uEta);result=vec4(t,dielectricFresnel(-uRay.y,uEta));return;}
      if(uTestMode==2){vec3 end;float path;bool found=waterExit(uEntry,uRay,end,path);result=vec4(found?1.:0.,0,0,0);return;}
      if(uTestMode==4){vec3 end;float path;bool found=waterExit(uEntry,uRay,end,path);result=vec4(end,found?path:-1.);return;}
      if(uTestMode==3){
        vec3 status;float path;
        vec3 color=traceInterior(uEntry,refract(uRay,vec3(0,1,0),1./1.333),vec3(0,2,3),720.,path,status);
        result=vec4(color,path);return;
      }
      vec3 inside=refract(uRay,vec3(0,1,0),1./1.333),exitPoint;float distance;
      bool found=waterExit(uEntry,inside,exitPoint,distance);
      vec3 n=surfaceNormal(exitPoint);
      if(dot(n,inside)<0.)n=-n;
      result=vec4(refract(inside,-n,1.333),found?distance:-1.);
    }`);
  const quad=new THREE.Mesh(geometry,field);quad.frustumCulled=false;scene.add(quad);
  const output=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
  const previousTarget=renderer.getRenderTarget(),previousAutoClear=renderer.autoClear;
  const results:{name:string;pass:boolean;directionError:number;pathError:number;actual:number[];expected:number[]}[]=[];
  const read=new Float32Array(4);
  let volume:THREE.WebGLRenderTarget|null=null;
  const refract=(i:THREE.Vector3,n:THREE.Vector3,eta:number)=>{
    const cosine=-i.dot(n),k=1-eta*eta*(1-cosine*cosine);
    return k<0?new THREE.Vector3():i.clone().multiplyScalar(eta).addScaledVector(n,eta*cosine-Math.sqrt(k));
  };
  const inspect=(name:string,expected:number[],tolerance:number)=>{
    quad.material=probe;renderer.setRenderTarget(output);renderer.render(scene,camera);
    renderer.readRenderTargetPixels(output,0,0,1,1,read);
    const directionError=Math.hypot(...expected.slice(0,3).map((v,i)=>v-read[i]));
    const pathError=Math.abs(expected[3]-read[3]);
    results.push({name,pass:[...read].every(Number.isFinite)&&directionError<tolerance&&pathError<.012,directionError,pathError,actual:[...read],expected});
  };
  try{
    renderer.autoClear=false;
    for(const quality of ['low','medium','high'] as Quality[]){
      const cell=PROFILES[quality].cell,voxel=cell*(quality==='low'?.38:.35),count=Math.ceil(4/voxel),columns=Math.ceil(Math.sqrt(count));
      const width=count*columns,height=count*Math.ceil(count/columns);
      volume=new THREE.WebGLRenderTarget(width,height,{count:2,type:THREE.HalfFloatType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
      uniforms.uFieldGrid.value.set(count,count,count);uniforms.uFieldSize.value.set(width,height);
      uniforms.uColumns.value=columns;uniforms.uVoxel.value=voxel;uniforms.uInterior.value=cell*.55*.89;
      uniforms.uField.value=volume.textures[0];uniforms.uFieldMetadata.value=volume.textures[0];uniforms.uMoments.value=volume.textures[1];
      for(let shape=0;shape<2;shape++){
        uniforms.uFixture.value=shape;quad.material=field;renderer.setRenderTarget(volume);renderer.render(scene,camera);
        const entry=new THREE.Vector3(0,shape===0?.3:.12,0);uniforms.uEntry.value.copy(entry);
        for(const angle of [0,30,60]){
          const theta=angle*Math.PI/180,ray=new THREE.Vector3(Math.sin(theta),-Math.cos(theta),0);
          uniforms.uRay.value.copy(ray);
          const inside=refract(ray,new THREE.Vector3(0,1,0),1/1.333);
          const distance=shape===0?.6/-inside.y:-2*entry.dot(inside);
          const exit=entry.clone().addScaledVector(inside,distance);
          const normal=shape===0?new THREE.Vector3(0,-1,0):exit.clone().normalize();
          const outgoing=refract(inside,normal.negate(),1.333);
          inspect(`${quality}/${shape===0?'slab':'sphere'}/${angle}deg`,[...outgoing.toArray(),distance],shape===0?.006:.06);
          if(shape===0){
            // Independent infinite-series solution for a parallel slab in a
            // uniform white environment, including absorption and scattering.
            const c=Math.cos(theta),ct=-inside.y,eta=1/1.333;
            const f=.5*(((eta*c-ct)/(eta*c+ct))**2+((c-eta*ct)/(c+eta*ct))**2);
            const expected=[.065,.015,.008].map((sigma,i)=>{
              const a=Math.exp(-sigma*distance),scatter=[.008,.025,.032][i];
              return (scatter*(1-a)+a*(1-f))/(1-a*f);
            });
            uniforms.uTestMode.value=3;
            inspect(`${quality}/slab radiance/${angle}deg`,[...expected,distance],.003);
            uniforms.uTestMode.value=0;
          }
        }
        if(shape===1){
          uniforms.uTestMode.value=2;uniforms.uRay.value.set(0,1,0);
          inspect(`${quality}/sphere/outward ray must not invent an exit`,[0,0,0,0],1e-5);
          uniforms.uTestMode.value=0;
        }
      }
      uniforms.uFixture.value=2;quad.material=field;renderer.setRenderTarget(volume);renderer.render(scene,camera);
      uniforms.uClipToTank.value=true;uniforms.uTestMode.value=4;uniforms.uRay.value.set(1,0,0);
      for(const [name,y,z] of [['bottom grazing',-.7195,0],['side grazing',-.4,.6495]] as const){
        uniforms.uEntry.value.set(-1,y,z);
        inspect(`${quality}/${name}/opposite wall exit`,[1,y,z,2],.002);
      }
      // A shallow negative implicit value is legal throughout the liquid; it
      // is not a signed distance to its far boundary. Exercise the worst step.
      uniforms.uInterior.value=.0005;quad.material=field;renderer.setRenderTarget(volume);renderer.render(scene,camera);
      uniforms.uEntry.value.set(-1,-.4,0);
      inspect(`${quality}/shallow implicit field/opposite wall exit`,[1,-.4,0,2],.002);
      uniforms.uClipToTank.value=false;uniforms.uTestMode.value=0;
      volume.dispose();volume=null;uniforms.uField.value=null;uniforms.uMoments.value=null;uniforms.uFieldMetadata.value=null;
    }
    uniforms.uTestMode.value=1;
    uniforms.uRay.value.set(0,-1,0);uniforms.uEta.value=1/1.333;
    inspect('normal incidence Fresnel',[0,-1,0,((1.333-1)/(1.333+1))**2],1e-5);
    const angle=55*Math.PI/180;uniforms.uRay.value.set(Math.sin(angle),-Math.cos(angle),0);uniforms.uEta.value=1.333;
    inspect('total internal reflection',[0,0,0,1],1e-5);
    return {passed:results.every(r=>r.pass),checks:results};
  }finally{
    renderer.setRenderTarget(previousTarget);renderer.autoClear=previousAutoClear;
    volume?.dispose();output.dispose();field.dispose();probe.dispose();geometry.dispose();
  }
}
