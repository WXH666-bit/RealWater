import * as THREE from 'three';
import type { FluidSolver } from './solver';
import { fullscreenVertex } from './shaders';
import { surfaceLayout } from './surface-field';
import * as shader from './implicit-shaders';

/** GPU volume reconstruction followed by ray/isosurface intersection.
 * The visible geometry is a world-space surface, not camera-facing particles. */
export class FluidSurface {
  gpuMilliseconds:number|null=null;
  private timerExtension:{TIME_ELAPSED_EXT:number;GPU_DISJOINT_EXT:number}|null;
  private timerQuery:WebGLQuery|null=null;
  private nextTiming=0;
  private targets:THREE.WebGLRenderTarget[]=[];
  private materials:THREE.RawShaderMaterial[]=[];
  private moments:THREE.WebGLRenderTarget;
  private field:THREE.WebGLRenderTarget;
  private smooth:THREE.WebGLRenderTarget;
  private bounds:THREE.WebGLRenderTarget;
  private pointScene=new THREE.Scene();
  private boundScene=new THREE.Scene();
  private screenScene=new THREE.Scene();
  private screenCamera=new THREE.Camera();
  private points:THREE.Points;
  private quad:THREE.Mesh;
  private envelopes:THREE.Mesh;
  private momentMaterial:THREE.RawShaderMaterial;
  private fieldMaterial:THREE.RawShaderMaterial;
  private smoothMaterial:THREE.RawShaderMaterial;
  private boundsMaterial:THREE.RawShaderMaterial;
  private rayMaterial:THREE.RawShaderMaterial;
  private sprayMaterial:THREE.RawShaderMaterial;
  private uniforms:Record<string,THREE.IUniform>;
  private layout;
  private fieldRevision=-1;
  constructor(private renderer:THREE.WebGLRenderer,private solver:FluidSolver){
    this.timerExtension=import.meta.env.DEV?renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2'):null;
    this.layout=surfaceLayout(solver.profile.cell,solver.quality);
    const layout=this.layout;
    const target=(w:number,h:number,format:THREE.PixelFormat=THREE.RGBAFormat,count=1)=>{
      const rt=new THREE.WebGLRenderTarget(w,h,{count,type:THREE.HalfFloatType,format,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});this.targets.push(rt);return rt;
    };
    this.moments=target(layout.width,layout.height,THREE.RGBAFormat,2);
    this.moments.textures[1].format=THREE.RedFormat;
    this.field=target(layout.width,layout.height,THREE.RedFormat);
    this.smooth=target(layout.width,layout.height,THREE.RedFormat);
    this.bounds=target(1,1);
    const layers=Math.ceil(layout.support/layout.voxel);
    this.uniforms={
      uPositions:{value:solver.positions},uParticleSize:{value:solver.particleSize},
      uFieldGrid:{value:new THREE.Vector3(...layout.grid)},uFieldOrigin:{value:new THREE.Vector3(...layout.origin)},
      uVoxel:{value:layout.voxel},uColumns:{value:layout.columns},uFieldSize:{value:new THREE.Vector2(layout.width,layout.height)},
      uSupport:{value:layout.support},uSurfaceRadius:{value:layout.radius},uDropRadius:{value:layout.dropRadius},uSplatSize:{value:layers*2+1},uLayer:{value:0},
      uSpriteRadius:{value:layout.support},uOutsideOnly:{value:false},
      uMoments:{value:this.moments.textures[0]},uSpread:{value:this.moments.textures[1]},uField:{value:this.field.texture},uBounds:{value:this.bounds.texture},
      uBackground:{value:null},uResolution:{value:new THREE.Vector2(1,1)},uHeight:{value:1},
      uInverseProjection:{value:new THREE.Matrix4()},uCameraWorld:{value:new THREE.Matrix4()},uViewProjection:{value:new THREE.Matrix4()},uCameraPosition:{value:new THREE.Vector3()},uDebug:{value:0},
    };
    const material=(vertexShader:string,fragmentShader:string)=>{
      const m=new THREE.RawShaderMaterial({vertexShader,fragmentShader,uniforms:this.uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});this.materials.push(m);return m;
    };
    this.momentMaterial=material(shader.momentVertex,shader.momentFragment);
    this.momentMaterial.blending=THREE.CustomBlending;this.momentMaterial.blendSrc=THREE.OneFactor;this.momentMaterial.blendDst=THREE.OneFactor;this.momentMaterial.blendEquation=THREE.AddEquation;
    this.fieldMaterial=material(fullscreenVertex,shader.fieldFragment);
    this.smoothMaterial=material(fullscreenVertex,shader.smoothFieldFragment);
    this.boundsMaterial=material(shader.boundVertex,shader.boundFragment);
    this.boundsMaterial.blending=THREE.CustomBlending;this.boundsMaterial.blendSrc=THREE.OneFactor;this.boundsMaterial.blendDst=THREE.OneFactor;this.boundsMaterial.blendEquation=THREE.MaxEquation;
    this.rayMaterial=material(fullscreenVertex,shader.rayFragment);
    this.rayMaterial.depthWrite=true;this.rayMaterial.depthTest=true;this.rayMaterial.depthFunc=THREE.AlwaysDepth;
    this.sprayMaterial=material(shader.boundVertex,shader.sprayFragment);this.sprayMaterial.depthTest=true;this.sprayMaterial.depthWrite=true;
    const points=new THREE.BufferGeometry();points.setAttribute('position',new THREE.BufferAttribute(new Float32Array(solver.stats.capacity*3),3));
    this.points=new THREE.Points(points,this.momentMaterial);this.points.frustumCulled=false;this.pointScene.add(this.points);
    const envelopes=new THREE.InstancedBufferGeometry();envelopes.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,-1,1,0,1,-1,0,1,1,0,-1,1,0],3));envelopes.instanceCount=solver.stats.capacity;
    this.envelopes=new THREE.Mesh(envelopes,this.boundsMaterial);this.envelopes.frustumCulled=false;this.boundScene.add(this.envelopes);
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    this.quad=new THREE.Mesh(geometry);this.quad.frustumCulled=false;this.screenScene.add(this.quad);
  }
  resize(width:number,height:number){this.bounds.setSize(width,height);this.uniforms.uResolution.value.set(width,height);this.uniforms.uHeight.value=height;}
  setDebug(value:number){this.uniforms.uDebug.value=value;}
  render(camera:THREE.PerspectiveCamera,background:THREE.Texture){
    const r=this.renderer,u=this.uniforms;r.autoClear=false;r.setClearColor(0,0);
    const gl=r.getContext() as WebGL2RenderingContext,timer=this.timerExtension;
    if(timer&&this.timerQuery&&gl.getQueryParameter(this.timerQuery,gl.QUERY_RESULT_AVAILABLE)){
      if(!gl.getParameter(timer.GPU_DISJOINT_EXT))this.gpuMilliseconds=gl.getQueryParameter(this.timerQuery,gl.QUERY_RESULT)/1e6;
      gl.deleteQuery(this.timerQuery);this.timerQuery=null;
    }
    let timeRender=false;
    if(timer&&!this.timerQuery&&performance.now()>this.nextTiming){
      this.timerQuery=gl.createQuery();
      if(this.timerQuery){gl.beginQuery(timer.TIME_ELAPSED_EXT,this.timerQuery);timeRender=true;}
      this.nextTiming=performance.now()+1000;
    }
    u.uPositions.value=this.solver.positions;
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);
    u.uViewProjection.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);u.uCameraPosition.value.copy(camera.position);u.uBackground.value=background;
    if(this.fieldRevision!==this.solver.revision){
      this.points.material=this.momentMaterial;r.setRenderTarget(this.moments);r.clear();
      const layers=Math.ceil(this.layout.support/this.layout.voxel);
      for(let layer=-layers;layer<=layers;layer++){u.uLayer.value=layer;r.render(this.pointScene,this.screenCamera);}
      this.quad.material=this.fieldMaterial;r.setRenderTarget(this.field);r.render(this.screenScene,this.screenCamera);
      u.uField.value=this.field.texture;
      this.quad.material=this.smoothMaterial;r.setRenderTarget(this.smooth);r.render(this.screenScene,this.screenCamera);
      this.fieldRevision=this.solver.revision;
    }
    u.uField.value=this.smooth.texture;
    u.uSpriteRadius.value=this.layout.support;u.uOutsideOnly.value=false;
    this.envelopes.material=this.boundsMaterial;r.setRenderTarget(this.bounds);r.clear();r.render(this.boundScene,camera);
    this.quad.material=this.rayMaterial;r.setRenderTarget(null);r.render(this.screenScene,this.screenCamera);
    u.uSpriteRadius.value=this.layout.dropRadius;u.uOutsideOnly.value=true;
    this.envelopes.material=this.sprayMaterial;r.render(this.boundScene,camera);
    if(timeRender)gl.endQuery(timer!.TIME_ELAPSED_EXT);
  }
  dispose(){if(this.timerQuery)(this.renderer.getContext() as WebGL2RenderingContext).deleteQuery(this.timerQuery);this.targets.forEach(t=>t.dispose());this.materials.forEach(m=>m.dispose());this.points.geometry.dispose();this.quad.geometry.dispose();this.envelopes.geometry.dispose();}
}
