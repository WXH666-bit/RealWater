import * as THREE from 'three';
import {affineFragment,fullscreenVertex,splatVertex,splatFragment} from './shaders';

/** Exercise the actual GPU APIC gradient and scatter shaders against analytic
 * translation, rigid rotation and shear. No fluid timestep or renderer model
 * supplies the expected answer. Includes markers exactly on grid planes. */
export function validateTransfers(renderer:THREE.WebGLRenderer){
  const grid=5,width=grid*grid,height=grid;
  const points=[[1.1,1.2,1.3],[1.5,1.5,1.5],[2,2,2],[2.9,1.05,2.1],[1.00001,2.9999,1.7]];
  const positions=new Float32Array(points.length*4);
  points.forEach((p,i)=>positions.set([...p,1],i*4));
  const textures:THREE.DataTexture[]=[];
  const texture=(data:Float32Array,w:number,h:number)=>{
    const t=new THREE.DataTexture(data,w,h,THREE.RGBAFormat,THREE.FloatType);t.needsUpdate=true;textures.push(t);return t;
  };
  const velocity=texture(new Float32Array(width*height*4),width,height);
  const uniforms:Record<string,THREE.IUniform>={
    uGrid:{value:new THREE.Vector3(grid,grid,grid)},uOrigin:{value:new THREE.Vector3()},uCell:{value:1},
    uParticleSize:{value:new THREE.Vector2(points.length,1)},uPositions:{value:texture(positions,points.length,1)},
    uSeeds:{value:texture(new Float32Array(positions.length),points.length,1)},uGridVelocity:{value:velocity},
    uVelocities:{value:null},uInjectOnly:{value:false},uLayer:{value:0},
    uAffineX:{value:null},uAffineY:{value:null},uAffineZ:{value:null},
  };
  const affine=new THREE.WebGLRenderTarget(points.length,1,{count:3,type:THREE.FloatType,depthBuffer:false});
  const scatter=new THREE.WebGLRenderTarget(width,height,{count:2,type:THREE.FloatType,depthBuffer:false});
  const material=(vertexShader:string,fragmentShader:string)=>new THREE.RawShaderMaterial({vertexShader,fragmentShader,uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
  const gatherMaterial=material(fullscreenVertex,affineFragment),scatterMaterial=material(splatVertex,splatFragment);
  const quadGeometry=new THREE.BufferGeometry();quadGeometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
  const pointGeometry=new THREE.BufferGeometry();pointGeometry.setAttribute('position',new THREE.Float32BufferAttribute(new Float32Array(points.length*3),3));
  const gatherScene=new THREE.Scene(),scatterScene=new THREE.Scene(),camera=new THREE.Camera();
  const quad=new THREE.Mesh(quadGeometry,gatherMaterial),markers=new THREE.Points(pointGeometry,scatterMaterial);
  quad.frustumCulled=false;markers.frustumCulled=false;gatherScene.add(quad);scatterScene.add(markers);
  const previousTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear;
  const clearColor=renderer.getClearColor(new THREE.Color()),clearAlpha=renderer.getClearAlpha();
  const fixtures=[
    {name:'translation',a:[[0,0,0],[0,0,0],[0,0,0]],b:[.7,-.3,.2]},
    {name:'rigid rotation',a:[[0,-.6,.2],[.6,0,-.3],[-.2,.3,0]],b:[.1,.2,-.1]},
    {name:'shear and extension',a:[[.4,.3,-.2],[-.1,-.2,.5],[.3,.1,-.2]],b:[-.2,.3,.1]},
  ];
  const results=[];
  try{
    renderer.autoClear=false;renderer.setClearColor(0,0);
    for(const fixture of fixtures){
      const value=(p:number[],axis:number)=>fixture.b[axis]+fixture.a[axis].reduce((s,v,i)=>s+v*p[i],0);
      const data=velocity.image.data as Float32Array;
      for(let z=0;z<grid;z++)for(let y=0;y<grid;y++)for(let x=0;x<grid;x++)for(let axis=0;axis<3;axis++){
        const p=[x+.5,y+.5,z+.5];p[axis]-=.5;
        data[(y*width+x+z*grid)*4+axis]=value(p,axis);
      }
      velocity.needsUpdate=true;
      uniforms.uAffineX.value=null;uniforms.uAffineY.value=null;uniforms.uAffineZ.value=null;
      renderer.setRenderTarget(affine);renderer.render(gatherScene,camera);
      const read=new Float32Array(points.length*4);let gradientError=0;
      for(let axis=0;axis<3;axis++){
        renderer.readRenderTargetPixels(affine,0,0,points.length,1,read,0,axis);
        for(let p=0;p<points.length;p++)for(let j=0;j<3;j++)gradientError=Math.max(gradientError,Math.abs(read[p*4+j]-fixture.a[axis][j]));
      }
      uniforms.uAffineX.value=affine.textures[0];uniforms.uAffineY.value=affine.textures[1];uniforms.uAffineZ.value=affine.textures[2];
      const particleVelocity=new Float32Array(points.length*4);
      points.forEach((p,i)=>particleVelocity.set([value(p,0),value(p,1),value(p,2),1],i*4));
      uniforms.uVelocities.value=texture(particleVelocity,points.length,1);
      renderer.setRenderTarget(scatter);renderer.clear();
      // Every contribution must reproduce the same affine field. Overwriting
      // overlapping contributions avoids requiring optional float32 blending.
      for(let layer=-1;layer<=1;layer++){uniforms.uLayer.value=layer;renderer.render(scatterScene,camera);}
      const weights=new Float32Array(width*height*4),momentum=new Float32Array(weights.length);
      renderer.readRenderTargetPixels(scatter,0,0,width,height,weights,0,0);
      renderer.readRenderTargetPixels(scatter,0,0,width,height,momentum,0,1);
      let gridError=0,samples=0;
      for(let z=0;z<grid;z++)for(let y=0;y<grid;y++)for(let x=0;x<grid;x++)for(let axis=0;axis<3;axis++){
        const i=(y*width+x+z*grid)*4+axis;if(weights[i]<1e-4)continue;
        const p=[x+.5,y+.5,z+.5];p[axis]-=.5;samples++;
        gridError=Math.max(gridError,Math.abs(momentum[i]/weights[i]-value(p,axis)));
      }
      results.push({name:fixture.name,gradientError,gridError,samples,pass:gradientError<1e-5&&gridError<1e-5&&samples>0});
    }
    return {passed:results.every(r=>r.pass),checks:results};
  }finally{
    textures.forEach(t=>t.dispose());affine.dispose();scatter.dispose();gatherMaterial.dispose();scatterMaterial.dispose();quadGeometry.dispose();pointGeometry.dispose();
    renderer.setRenderTarget(previousTarget);renderer.autoClear=autoClear;renderer.setClearColor(clearColor,clearAlpha);
  }
}
