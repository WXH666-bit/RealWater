import * as THREE from 'three';
import type { FluidSolver } from './solver';
import { fullscreenVertex } from './shaders';
import { surfaceLayout } from './surface-field';
import * as shader from './implicit-shaders';
import { FIXED_DT } from '../config';
import type {AquariumSystem} from '../aquarium';

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
  private history:THREE.WebGLRenderTarget;
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
  constructor(private renderer:THREE.WebGLRenderer,private solver:FluidSolver,studioUniforms:Record<string,THREE.IUniform>={}){
    this.timerExtension=import.meta.env.DEV?renderer.getContext().getExtension('EXT_disjoint_timer_query_webgl2'):null;
    this.layout=surfaceLayout(solver.profile.cell,solver.quality);
    const layout=this.layout;
    const target=(w:number,h:number,format:THREE.PixelFormat=THREE.RGBAFormat,count=1)=>{
      const rt=new THREE.WebGLRenderTarget(w,h,{count,type:THREE.HalfFloatType,format,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});this.targets.push(rt);return rt;
    };
    this.moments=target(layout.width,layout.height,THREE.RGBAFormat,2);
    this.moments.textures[1].format=THREE.RGFormat;
    this.field=target(layout.width,layout.height);
    this.smooth=target(layout.width,layout.height,THREE.RedFormat);
    this.history=target(layout.width,layout.height,THREE.RedFormat);
    this.bounds=target(1,1);
    const layers=Math.ceil(layout.support/layout.voxel);
    this.uniforms={uStudioLift:{value:0},uStudioCenter:{value:new THREE.Vector3()},uStudioHalf:{value:new THREE.Vector3()},...studioUniforms,
      uCenter:solver.uniforms.uCenter,uInverse:solver.uniforms.uInverse,uRotation:solver.uniforms.uRotation,uClipToTank:{value:true},
      uPositions:{value:solver.positions},uParticleSize:{value:solver.particleSize},
      uParticleVelocities:{value:solver.velocities},uHistory:{value:this.history.texture},uHistorySeconds:{value:0},uHasHistory:{value:false},
      uFieldGrid:{value:new THREE.Vector3(...layout.grid)},uFieldOrigin:{value:new THREE.Vector3(...layout.origin)},
      uVoxel:{value:layout.voxel},uColumns:{value:layout.columns},uFieldSize:{value:new THREE.Vector2(layout.width,layout.height)},
      uSupport:{value:layout.support},uSurfaceRadius:{value:layout.radius},uDropRadius:{value:layout.dropRadius},uSplatSize:{value:layers*2+1},uLayer:{value:0},
      uSpriteRadius:{value:layout.support},uOutsideOnly:{value:false},
      uMoments:{value:this.moments.textures[0]},uSpread:{value:this.moments.textures[1]},uField:{value:this.field.texture},uFieldMetadata:{value:this.field.texture},uBounds:{value:this.bounds.texture},
      uBackground:{value:null},uResolution:{value:new THREE.Vector2(1,1)},uHeight:{value:1},
      uFishPosition:{value:null},uFishVelocity:{value:null},uFishHeading:{value:null},uFishCount:{value:0},
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
    this.rayMaterial.defines={AQUARIUM:1};
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
  /** Read the visible isosurface, rather than treating the highest marker as water height.
   * World-space vertical probes are intended for the upright diagnostic tank. */
  inspectHeights(raw=false){
    const width=33,height=19;
    const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:shader.fieldCommon+`
      out vec4 result;
      void main(){
        vec2 xz=((gl_FragCoord.xy-.5)/vec2(32,18)*2.-1.)*tank.xz*.7;
        float above=tank.y-.07;
        for(int i=1;i<=96;i++){
          float below=tank.y-.07-float(i)*(2.*tank.y-.08)/96.;
          if(fieldAt(vec3(xz.x,below,xz.y))<0.){
            for(int j=0;j<12;j++){
              float mid=(above+below)*.5;
              if(fieldAt(vec3(xz.x,mid,xz.y))<0.)below=mid;else above=mid;
            }
            result=vec4((above+below)*.5,1,fieldAt(vec3(xz.x,-.68,xz.y)),fieldAt(vec3(xz.x,-.5,xz.y)));return;
          }
          above=below;
        }
        result=vec4(0);
      }
    `,uniforms:this.uniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
    const target=new THREE.WebGLRenderTarget(width,height,{type:THREE.FloatType,depthBuffer:false});
    const previousTarget=this.renderer.getRenderTarget(),previousMaterial=this.quad.material,previousField=this.uniforms.uField.value;
    const values=new Float32Array(width*height*4);
    try{
      if(raw)this.uniforms.uField.value=this.field.texture;
      this.quad.material=material;this.renderer.setRenderTarget(target);this.renderer.render(this.screenScene,this.screenCamera);
      this.renderer.readRenderTargetPixels(target,0,0,width,height,values);
      const interior=Array.from({length:width*height},(_,i)=>i).filter(i=>values[i*4+1]>.5&&values[i*4]>-.3);
      return {width,height,heights:Array.from({length:width*height},(_,i)=>values[i*4+1]>.5?values[i*4]:null),interior:{samples:interior.length,bottomVoids:interior.filter(i=>values[i*4+2]>0).length,middleVoids:interior.filter(i=>values[i*4+3]>0).length,maxBottomPhi:Math.max(...interior.map(i=>values[i*4+2]))}};
    }finally{this.uniforms.uField.value=previousField;this.quad.material=previousMaterial;this.renderer.setRenderTarget(previousTarget);target.dispose();material.dispose();}
  }
  inspectSurfaceFiltering(){
    const filtered=this.inspectHeights(),raw=this.inspectHeights(true);
    const summarize=(sample:typeof filtered)=>{
      const heights=sample.heights.filter((h):h is number=>h!==null);
      const mean=heights.reduce((sum,h)=>sum+h,0)/heights.length;
      const residuals:number[]=[];
      for(let z=1;z<sample.height-1;z++)for(let x=1;x<sample.width-1;x++){
        const i=z*sample.width+x,neighbors=[i,i-1,i+1,i-sample.width,i+sample.width].map(j=>sample.heights[j]);
        if(neighbors.every((h):h is number=>h!==null))residuals.push(neighbors[0]-(neighbors[1]+neighbors[2]+neighbors[3]+neighbors[4])/4);
      }
      return {samples:heights.length,mean,rms:Math.sqrt(heights.reduce((sum,h)=>sum+(h-mean)**2,0)/heights.length),localRms:Math.sqrt(residuals.reduce((sum,h)=>sum+h*h,0)/residuals.length)};
    };
    return {...filtered,comparison:{raw:summarize(raw),filtered:summarize(filtered)}};
  }
  /** Development probes read the reconstructed GPU field, not particle counts. */
  inspectField(points:THREE.Vector3[]){
    return this.inspectGeometry(points).map(value=>value[0]);
  }
  inspectNormals(points:THREE.Vector3[]){
    return this.inspectGeometry(points).map(value=>new THREE.Vector3(value[1],value[2],value[3]));
  }
  inspectSupport(points:THREE.Vector3[]){return this.inspectGeometry(points,true);}
  private inspectGeometry(points:THREE.Vector3[],metadata=false){
    const probeUniforms={...this.uniforms,uProbe:{value:new THREE.Vector3()},uInspectMetadata:{value:metadata}};
    const material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:shader.fieldCommon+shader.surfaceTracing+`
      uniform vec3 uProbe;uniform bool uInspectMetadata;out vec4 result;
      void main(){vec4 metadata=sampleFieldTexture(uFieldMetadata,uProbe);result=uInspectMetadata?vec4(fieldAt(uProbe),metadata.gb,metadata.r):vec4(fieldAt(uProbe),surfaceNormal(uProbe));}
    `,uniforms:probeUniforms,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false});
    const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false});
    const previousTarget=this.renderer.getRenderTarget(),previousMaterial=this.quad.material;
    const read=new Float32Array(4);
    try{
      this.quad.material=material;
      return points.map(point=>{
        probeUniforms.uProbe.value.copy(point);this.renderer.setRenderTarget(target);
        this.renderer.render(this.screenScene,this.screenCamera);
        this.renderer.readRenderTargetPixels(target,0,0,1,1,read);return Array.from(read);
      });
    }finally{this.quad.material=previousMaterial;this.renderer.setRenderTarget(previousTarget);target.dispose();material.dispose();}
  }
  render(camera:THREE.PerspectiveCamera,background:THREE.Texture,aquarium?:AquariumSystem){
    const r=this.renderer,u=this.uniforms;r.autoClear=false;r.setClearColor(0,0);
    u.uFishCount.value=aquarium?.count??0;
    if(aquarium){const textures=aquarium.textures;u.uFishPosition.value=textures[0];u.uFishVelocity.value=textures[1];u.uFishHeading.value=textures[2];}
    const gl=r.getContext() as WebGL2RenderingContext,timer=this.timerExtension;
    if(timer&&this.timerQuery&&gl.getQueryParameter(this.timerQuery,gl.QUERY_RESULT_AVAILABLE)){
      if(!gl.getParameter(timer.GPU_DISJOINT_EXT))this.gpuMilliseconds=gl.getQueryParameter(this.timerQuery,gl.QUERY_RESULT)/1e6;
      gl.deleteQuery(this.timerQuery);this.timerQuery=null;
    }
    let timeRender=false;
    if(timer&&!this.timerQuery&&performance.now()>this.nextTiming&&!gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)){
      this.timerQuery=gl.createQuery();
      if(this.timerQuery){gl.beginQuery(timer.TIME_ELAPSED_EXT,this.timerQuery);timeRender=true;}
      this.nextTiming=performance.now()+1000;
    }
    u.uPositions.value=this.solver.positions;
    u.uParticleVelocities.value=this.solver.velocities;
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);
    u.uViewProjection.value.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);u.uCameraPosition.value.copy(camera.position);u.uBackground.value=background;
    if(this.fieldRevision!==this.solver.revision){
      this.points.material=this.momentMaterial;r.setRenderTarget(this.moments);r.clear();
      const layers=Math.ceil(this.layout.support/this.layout.voxel);
      for(let layer=-layers;layer<=layers;layer++){u.uLayer.value=layer;r.render(this.pointScene,this.screenCamera);}
      this.quad.material=this.fieldMaterial;r.setRenderTarget(this.field);r.render(this.screenScene,this.screenCamera);
      u.uField.value=this.field.texture;
      u.uHistory.value=this.history.texture;
      u.uHasHistory.value=this.fieldRevision>=0;
      u.uHistorySeconds.value=(this.solver.revision-this.fieldRevision)*FIXED_DT;
      this.quad.material=this.smoothMaterial;r.setRenderTarget(this.smooth);r.render(this.screenScene,this.screenCamera);
      [this.history,this.smooth]=[this.smooth,this.history];
      this.fieldRevision=this.solver.revision;
    }
    u.uField.value=this.history.texture;
    u.uSpriteRadius.value=this.layout.support;u.uOutsideOnly.value=false;
    this.envelopes.material=this.boundsMaterial;r.setRenderTarget(this.bounds);r.clear();r.render(this.boundScene,camera);
    this.quad.material=this.rayMaterial;r.setRenderTarget(null);r.render(this.screenScene,this.screenCamera);
    u.uSpriteRadius.value=this.layout.dropRadius;u.uOutsideOnly.value=true;
    this.envelopes.material=this.sprayMaterial;r.render(this.boundScene,camera);
    if(timeRender)gl.endQuery(timer!.TIME_ELAPSED_EXT);
  }
  dispose(){if(this.timerQuery)(this.renderer.getContext() as WebGL2RenderingContext).deleteQuery(this.timerQuery);this.targets.forEach(t=>t.dispose());this.materials.forEach(m=>m.dispose());this.points.geometry.dispose();this.quad.geometry.dispose();this.envelopes.geometry.dispose();}
}
