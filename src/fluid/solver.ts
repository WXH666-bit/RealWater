import * as THREE from 'three';
import { FIXED_DT, GRAVITY, PROFILES, initialParticles, randomSequence, type Quality } from '../config';
import * as shader from './shaders';
import { dropOffsets, dropParticleCount } from './emission';

type Uniforms = Record<string, THREE.IUniform>;
export interface FluidStats { active: number; initial: number; injected: number; exited: number; capacity: number; invalid: number; minY: number; maxY: number; meanY: number; meanX:number; rmsSpeed:number; }

export class FluidSolver {
  readonly profile;
  readonly particleSize: THREE.Vector2;
  readonly radius: number;
  readonly markerVolume:number;
  readonly stats: FluidStats;
  readonly uniforms: Uniforms;
  revision=0;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private quad: THREE.Mesh;
  private splatScene = new THREE.Scene();
  private materials: Record<string, THREE.RawShaderMaterial> = {};
  private targets: THREE.WebGLRenderTarget[] = [];
  private particles: THREE.WebGLRenderTarget;
  private particlesNext: THREE.WebGLRenderTarget;
  private affine:THREE.WebGLRenderTarget;
  private affineNext:THREE.WebGLRenderTarget;
  private accum: THREE.WebGLRenderTarget;
  private original: THREE.WebGLRenderTarget;
  private originalNext: THREE.WebGLRenderTarget;
  private forced: THREE.WebGLRenderTarget;
  private projected: THREE.WebGLRenderTarget;
  private projectedNext: THREE.WebGLRenderTarget;
  private divergence: THREE.WebGLRenderTarget;
  private boundary: THREE.WebGLRenderTarget;
  private boundaryReady=false;
  private boundaryPosition=new THREE.Vector3();
  private boundaryQuaternion=new THREE.Quaternion();
  private pressure: THREE.WebGLRenderTarget;
  private pressureNext: THREE.WebGLRenderTarget;
  private seeds: THREE.DataTexture;
  private seedData: Float32Array;
  private seedDirty = false;
  private free: number[] = [];
  private pending = new Set<number>();
  private invalidIds = new Set<number>();
  private invalidTotal = 0;
  private readback: Float32Array;
  private random = randomSequence(2026);
  private splatGeometry: THREE.BufferGeometry;
  private previousPosition = new THREE.Vector3();
  private previousQuaternion = new THREE.Quaternion();
  private m4 = new THREE.Matrix4();
  private deltaQ = new THREE.Quaternion();

  constructor(private renderer: THREE.WebGLRenderer, readonly quality: Quality) {
    this.profile = PROFILES[quality];
    const cap = this.profile.capacity;
    this.particleSize = new THREE.Vector2(256, cap / 256);
    const initial = initialParticles(this.profile.cell, cap);
    this.radius = initial.spacing * 0.94;
    this.markerVolume=initial.markerVolume;
    this.stats = { active: initial.count, initial: initial.count, injected: 0, exited: 0, capacity: cap, invalid: 0, minY: -.72, maxY: 0, meanY: -.36, meanX:0, rmsSpeed:0 };
    this.readback = new Float32Array(cap * 4);
    this.seedData = new Float32Array(cap * 4);
    for (let i = cap - 1; i >= initial.count; i--) this.free.push(i);
    this.seeds = this.dataTexture(this.seedData);
    const grid = new THREE.Vector3(...this.profile.grid).addScalar(1);
    const origin = new THREE.Vector3(-grid.x * this.profile.cell / 2, -2.65, -grid.z * this.profile.cell / 2);
    this.uniforms = {
      uGrid: { value: grid }, uOrigin: { value: origin }, uCell: { value: this.profile.cell },
      uDt: { value: FIXED_DT }, uRadius: { value: this.radius }, uCenter: { value: new THREE.Vector3() },
      uGravity: { value: GRAVITY },
      uRestDensity:{value:this.profile.cell**3/this.markerVolume},
      uPreviousCenter: { value: new THREE.Vector3() }, uRotation: { value: new THREE.Matrix3() },
      uInverse: { value: new THREE.Matrix3() }, uPreviousInverse: { value: new THREE.Matrix3() },
      uLinear: { value: new THREE.Vector3() }, uAngular: { value: new THREE.Vector3() },
      uPositions: { value: null }, uVelocities: { value: null }, uGridVelocity: { value: null },
      uOriginalVelocity: { value: null }, uWeights: { value: null }, uPressure: { value: null },
      uDivergence: { value: null }, uSeeds: { value: this.seeds }, uMomentum: { value: null },
      uBoundary:{value:null},
      uAffineX:{value:null},uAffineY:{value:null},uAffineZ:{value:null},
      uParticleSize: { value: this.particleSize }, uLayer: { value: 0 }, uSource: { value: null },
      uViewProjection: { value: new THREE.Matrix4() }, uInjectOnly: { value: false }, uEmissionVelocity: { value: 0 },
    };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geometry);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const fragments = { affine:shader.affineFragment,boundary:shader.boundaryFragment, normalize: shader.normalizeFragment, extrapolate: shader.extrapolateFragment, force: shader.forceFragment, divergence: shader.divergenceFragment, pressure: shader.pressureFragment, project: shader.projectFragment, particle: shader.particleFragment, copy: shader.copyFragment };
    for (const [name, fragment] of Object.entries(fragments)) this.materials[name] = this.material(shader.fullscreenVertex, fragment);
    const splat = this.material(shader.splatVertex, shader.splatFragment);
    splat.blending = THREE.CustomBlending;
    splat.blendEquation = THREE.AddEquation;
    splat.blendSrc = THREE.OneFactor;
    splat.blendDst = THREE.OneFactor;
    this.materials.splat = splat;
    this.splatGeometry = new THREE.BufferGeometry();
    this.splatGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    const points = new THREE.Points(this.splatGeometry, splat);
    points.frustumCulled = false;
    this.splatScene.add(points);
    const w = grid.x * grid.z, h = grid.y;
    this.accum = this.target(w, h, 2, THREE.HalfFloatType, THREE.LinearFilter);
    this.original = this.target(w, h, 1, THREE.HalfFloatType, THREE.LinearFilter);
    this.originalNext = this.target(w, h, 1, THREE.HalfFloatType, THREE.LinearFilter);
    this.forced = this.target(w, h, 1, THREE.HalfFloatType, THREE.LinearFilter);
    this.projected = this.target(w, h, 1, THREE.HalfFloatType, THREE.LinearFilter);
    this.projectedNext = this.target(w, h, 1, THREE.HalfFloatType, THREE.LinearFilter);
    this.divergence = this.target(w, h);
    this.boundary = this.target(w,h);
    this.uniforms.uBoundary.value=this.boundary.texture;
    this.pressure = this.target(w, h);
    this.pressureNext = this.target(w, h);
    this.particles = this.target(this.particleSize.x, this.particleSize.y, 2, THREE.FloatType);
    this.particlesNext = this.target(this.particleSize.x, this.particleSize.y, 2, THREE.FloatType);
    this.affine=this.target(this.particleSize.x,this.particleSize.y,3);
    this.affineNext=this.target(this.particleSize.x,this.particleSize.y,3);
    const initialTexture = this.dataTexture(initial.positions);
    this.uniforms.uSeeds.value = initialTexture;
    this.uniforms.uPositions.value = this.seeds;
    this.uniforms.uVelocities.value = this.seeds;
    this.uniforms.uInjectOnly.value = true;
    this.pass('affine',this.affine);this.bindAffine();
    this.pass('particle', this.particles);
    this.uniforms.uInjectOnly.value = false;
    this.uniforms.uEmissionVelocity.value = -.5;
    this.uniforms.uSeeds.value = this.seeds;
    initialTexture.dispose();
    this.bindParticles();
    renderer.setRenderTarget(null);
  }

  get positions() { return this.particles.textures[0]; }
  private dataTexture(data: Float32Array) {
    const texture = new THREE.DataTexture(data, this.particleSize.x, this.particleSize.y, THREE.RGBAFormat, THREE.FloatType);
    texture.needsUpdate = true; return texture;
  }
  private target(w: number, h: number, count = 1, type: THREE.TextureDataType = THREE.HalfFloatType, filter: THREE.MagnificationTextureFilter = THREE.NearestFilter) {
    const target = new THREE.WebGLRenderTarget(w, h, { count, type, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: false, stencilBuffer: false });
    this.targets.push(target); return target;
  }
  private material(vertexShader: string, fragmentShader: string) {
    return new THREE.RawShaderMaterial({ vertexShader, fragmentShader, uniforms: this.uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false });
  }
  private pass(name: string, target: THREE.WebGLRenderTarget) {
    this.quad.material = this.materials[name];
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }
  private bindParticles() {
    this.uniforms.uPositions.value = this.particles.textures[0];
    this.uniforms.uVelocities.value = this.particles.textures[1];
  }
  private bindAffine(){
    this.uniforms.uAffineX.value=this.affine.textures[0];
    this.uniforms.uAffineY.value=this.affine.textures[1];
    this.uniforms.uAffineZ.value=this.affine.textures[2];
  }
  private updateAffine(){
    this.pass('affine',this.affineNext);
    [this.affine,this.affineNext]=[this.affineNext,this.affine];this.bindAffine();
  }
  private swapParticles() {
    [this.particles, this.particlesNext] = [this.particlesNext, this.particles];
    this.bindParticles();
  }

  emit(center: THREE.Vector3, radius: number): boolean {
    const count = dropParticleCount(radius,Math.cbrt(this.markerVolume));
    if(!count||this.free.length<count||![center.x,center.y,center.z].every(Number.isFinite))return false;
    const offsets=dropOffsets(count,radius,this.random);
    for (let i = 0; i < count; i++) {
      const id = this.free.pop()!;
      this.invalidIds.delete(id);
      this.seedData.set([center.x+offsets[i*3],center.y+offsets[i*3+1],center.z+offsets[i*3+2],1],id*4);
      this.pending.add(id);
    }
    this.seedDirty = true;
    this.stats.injected += count;
    this.stats.active += count;
    return true;
  }

  flushSeeds() {
    if (!this.seedDirty) return;
    this.seeds.needsUpdate = true;
    this.uniforms.uInjectOnly.value = true;
    this.updateAffine();
    this.pass('particle', this.particlesNext);
    this.swapParticles();
    this.uniforms.uInjectOnly.value = false;
    this.seedData.fill(0);
    this.seeds.needsUpdate = true;
    this.seedDirty = false;
    this.pending.clear();
    this.revision++;
  }

  step(position: THREE.Vector3, quaternion: THREE.Quaternion, viewProjection: THREE.Matrix4) {
    this.renderer.autoClear = false;
    this.flushSeeds();
    const u = this.uniforms;
    u.uPreviousCenter.value.copy(this.previousPosition);
    u.uCenter.value.copy(position);
    u.uPreviousInverse.value.setFromMatrix4(this.m4.makeRotationFromQuaternion(this.previousQuaternion)).transpose();
    u.uRotation.value.setFromMatrix4(this.m4.makeRotationFromQuaternion(quaternion));
    u.uInverse.value.copy(u.uRotation.value).transpose();
    u.uLinear.value.copy(position).sub(this.previousPosition).divideScalar(FIXED_DT).clampLength(0, 5);
    this.deltaQ.copy(quaternion).multiply(this.previousQuaternion.clone().invert());
    if (this.deltaQ.w < 0) this.deltaQ.set(-this.deltaQ.x, -this.deltaQ.y, -this.deltaQ.z, -this.deltaQ.w);
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(this.deltaQ.w, -1, 1));
    u.uAngular.value.set(this.deltaQ.x, this.deltaQ.y, this.deltaQ.z).normalize().multiplyScalar(angle / FIXED_DT).clampLength(0, 4);
    u.uViewProjection.value.copy(viewProjection);
    if(!this.boundaryReady||position.distanceToSquared(this.boundaryPosition)>1e-14||1-Math.abs(quaternion.dot(this.boundaryQuaternion))>1e-14){
      this.pass('boundary',this.boundary);this.boundaryReady=true;
      this.boundaryPosition.copy(position);this.boundaryQuaternion.copy(quaternion);
    }
    this.renderer.setRenderTarget(this.accum);
    this.renderer.setClearColor(0, 0);this.renderer.clear();
    for (let layer = -1; layer <= 1; layer++) { u.uLayer.value = layer; this.renderer.render(this.splatScene, this.camera); }
    u.uWeights.value = this.accum.textures[0];u.uMomentum.value = this.accum.textures[1];
    this.pass('normalize', this.original);
    for(let i=0;i<3;i++){
      u.uGridVelocity.value=this.original.texture;this.pass('extrapolate',this.originalNext);
      [this.original,this.originalNext]=[this.originalNext,this.original];
    }
    u.uOriginalVelocity.value = this.original.texture;
    this.pass('force', this.forced);
    u.uGridVelocity.value = this.forced.texture;
    this.pass('divergence', this.divergence);
    u.uDivergence.value = this.divergence.texture;
    // Warm-start pressure. Clearing every step under-converges hydrostatic
    // pressure and visibly compresses the tank as gravity accumulates.
    for (let i = 0; i < this.profile.pressure; i++) {
      u.uPressure.value = this.pressure.texture;
      this.pass('pressure', this.pressureNext);
      [this.pressure, this.pressureNext] = [this.pressureNext, this.pressure];
    }
    u.uPressure.value = this.pressure.texture;
    this.pass('project', this.projected);
    for(let i=0;i<3;i++){
      u.uGridVelocity.value=this.projected.texture;this.pass('extrapolate',this.projectedNext);
      [this.projected,this.projectedNext]=[this.projectedNext,this.projected];
    }
    u.uGridVelocity.value = this.projected.texture;
    this.updateAffine();
    this.pass('particle', this.particlesNext);
    this.swapParticles();
    this.previousPosition.copy(position);this.previousQuaternion.copy(quaternion);
    this.revision++;
    this.renderer.setRenderTarget(null);
  }

  /** Developer-only timing of complete fixed physics steps, excluding drawing. */
  async measureSteps(position:THREE.Vector3,quaternion:THREE.Quaternion,viewProjection:THREE.Matrix4){
    const gl=this.renderer.getContext() as WebGL2RenderingContext;
    const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!timer)return {available:false,reason:'GPU timer extension unavailable'};
    if(gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))return {available:false,reason:'Another timer query is active'};
    for(let i=0;i<8;i++)this.step(position,quaternion,viewProjection);
    const query=gl.createQuery();if(!query)return {available:false,reason:'Could not create GPU query'};
    const steps=90;
    try{
      const cpuStart=performance.now();
      gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
      try{for(let i=0;i<steps;i++)this.step(position,quaternion,viewProjection);}
      finally{gl.endQuery(timer.TIME_ELAPSED_EXT);}
      const cpuSubmissionMilliseconds=performance.now()-cpuStart;
      const active=this.inspect().active;
      gl.flush();const start=performance.now();
      while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
        if(gl.isContextLost()||performance.now()-start>10000)return {available:false,reason:'GPU query unavailable or timed out'};
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(gl.getParameter(timer.GPU_DISJOINT_EXT))return {available:false,reason:'Disjoint GPU clock; discard timing'};
      const milliseconds=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
      const info=gl.getExtension('WEBGL_debug_renderer_info');
      const device=gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
      return {available:true,device,quality:this.quality,active,steps,totalGpuMilliseconds:milliseconds,gpuMillisecondsPerStep:milliseconds/steps,cpuSubmissionMillisecondsPerStep:cpuSubmissionMilliseconds/steps,physicsGpuMillisecondsPerRealSecond:milliseconds/steps/FIXED_DT};
    }finally{gl.deleteQuery(query);}
  }
  /** Development-only readback of A*p-b on the actual pressure stencil. */
  inspectPressure(){
    const material=this.material(shader.fullscreenVertex,shader.common+`
      uniform bool uProbeEnergy;
      uniform sampler2D uBeforeProjection;
      uniform sampler2D uAfterProjection;
      out vec4 result;
      void main(){
        if(uProbeEnergy){
          ivec3 q=coord();vec3 before=at(uBeforeProjection,q).xyz,after=at(uAfterProjection,q).xyz;
          float a=0.,b=0.,weight=0.;
          for(int axis=0;axis<3;axis++){
            ivec3 off=ivec3(0);off[axis]=1;
            float open=at(uBoundary,q)[axis];
            if(open>0.&&(fluid(q)||fluid(q-off))){a+=open*before[axis]*before[axis];b+=open*after[axis]*after[axis];weight+=open;}
          }
          result=vec4(a,b,weight,fluid(q)?max(at(uWeights,q).a-uRestDensity,0.)*.25:0.);return;
        }
        ivec3 q=coord();if(!fluid(q)){result=vec4(0);return;}
        float sum=0.,n=0.;
        for(int axis=0;axis<3;axis++)for(int sign=-1;sign<=1;sign+=2){
          ivec3 off=ivec3(0);off[axis]=sign;ivec3 p=q+off;
          float weight=at(uBoundary,sign>0?p:q)[axis];n+=weight;sum+=weight*at(uPressure,p).r;
        }
        float rhs=at(uDivergence,q).r,residual=n*at(uPressure,q).r-sum+rhs;
        result=vec4(residual*residual,abs(residual),rhs*rhs,1);
      }
    `);
    material.uniforms={...material.uniforms,uProbeEnergy:{value:false},uBeforeProjection:{value:this.forced.texture},uAfterProjection:{value:this.projected.texture}};
    const target=new THREE.WebGLRenderTarget(this.pressure.width,this.pressure.height,{type:THREE.FloatType,depthBuffer:false});
    const previousTarget=this.renderer.getRenderTarget(),previousMaterial=this.quad.material;
    const data=new Float32Array(target.width*target.height*4);
    try{
      this.uniforms.uPressure.value=this.pressure.texture;
      this.quad.material=material;this.renderer.setRenderTarget(target);this.renderer.render(this.scene,this.camera);
      this.renderer.readRenderTargetPixels(target,0,0,target.width,target.height,data);
      let count=0,error=0,rhs=0,max=0;
      for(let i=0;i<data.length;i+=4)if(data[i+3]>.5){count++;error+=data[i];rhs+=data[i+2];max=Math.max(max,data[i+1]);}
      material.uniforms.uProbeEnergy.value=true;this.renderer.render(this.scene,this.camera);
      this.renderer.readRenderTargetPixels(target,0,0,target.width,target.height,data);
      let before=0,after=0,weight=0,crowding=0;
      for(let i=0;i<data.length;i+=4){before+=data[i];after+=data[i+1];weight+=data[i+2];crowding+=data[i+3];}
      return {fluidCells:count,rmsResidual:Math.sqrt(error/Math.max(count,1)),relativeResidual:Math.sqrt(error/Math.max(rhs,1e-20)),maxResidual:max,preProjectionRms:Math.sqrt(before/Math.max(weight,1)),postProjectionRms:Math.sqrt(after/Math.max(weight,1)),crowdingSourceTotal:crowding};
    }finally{this.quad.material=previousMaterial;this.renderer.setRenderTarget(previousTarget);material.dispose();target.dispose();}
  }
  /** Compare projected face flux with the velocity actually used to move markers. */
  inspectTransport(){
    const material=this.material(shader.fullscreenVertex,shader.common+`
      out vec4 result;
      void main(){
        vec4 particle=texelFetch(uPositions,ivec2(gl_FragCoord.xy),0);
        if(particle.a<.5||!inDomain(particle.xyz)){result=vec4(0);return;}
        vec3 p=particle.xyz;ivec3 q=ivec3(floor((p-uOrigin)/uCell));
        float interpolated=0.,flux=0.;
        for(int axis=0;axis<3;axis++){
          vec3 offset=vec3(.5);offset[axis]=0.;
          vec3 g=(p-uOrigin)/uCell-offset,f=fract(g);ivec3 base=ivec3(floor(g));
          for(int x=0;x<2;x++)for(int y=0;y<2;y++)for(int z=0;z<2;z++){
            vec3 side=vec3(x,y,z),w=mix(1.-f,f,side);
            interpolated+=at(uGridVelocity,base+ivec3(x,y,z))[axis]*(side[axis]*2.-1.)*w[(axis+1)%3]*w[(axis+2)%3]/uCell;
          }
          ivec3 step=ivec3(0);step[axis]=1;
          flux+=face(uGridVelocity,q+step,axis)-face(uGridVelocity,q,axis);
        }
        result=vec4(interpolated,flux/uCell,tankSdf(p)<uCell*1.5?1.:0.,1);
      }
    `);
    const target=new THREE.WebGLRenderTarget(this.particleSize.x,this.particleSize.y,{type:THREE.FloatType,depthBuffer:false});
    const previousTarget=this.renderer.getRenderTarget(),previousMaterial=this.quad.material;
    const data=new Float32Array(this.readback.length);
    const groups={interior:{count:0,interpolatedSquared:0,fluxSquared:0,compressing:0},nearWall:{count:0,interpolatedSquared:0,fluxSquared:0,compressing:0}};
    try{
      this.quad.material=material;this.renderer.setRenderTarget(target);this.renderer.render(this.scene,this.camera);
      this.renderer.readRenderTargetPixels(target,0,0,target.width,target.height,data);
      for(let i=0;i<data.length;i+=4)if(data[i+3]>.5){
        const group=data[i+2]>.5?groups.nearWall:groups.interior;
        group.count++;group.interpolatedSquared+=data[i]**2;group.fluxSquared+=data[i+1]**2;if(data[i]<-1)group.compressing++;
      }
      return Object.fromEntries(Object.entries(groups).map(([name,g])=>[name,{particles:g.count,trilinearDivergenceRms:Math.sqrt(g.interpolatedSquared/Math.max(g.count,1)),transportDivergenceRms:Math.sqrt(g.fluxSquared/Math.max(g.count,1)),trilinearCompressionAboveOnePerSecond:g.compressing}]));
    }finally{this.quad.material=previousMaterial;this.renderer.setRenderTarget(previousTarget);material.dispose();target.dispose();}
  }
  /** Developer diagnostics: retain IDs so successive snapshots reveal stuck markers. */
  inspectMarkers() {
    const positions=new Float32Array(this.readback.length),velocities=new Float32Array(this.readback.length);
    this.renderer.readRenderTargetPixels(this.particles,0,0,this.particleSize.x,this.particleSize.y,positions,0,0);
    this.renderer.readRenderTargetPixels(this.particles,0,0,this.particleSize.x,this.particleSize.y,velocities,0,1);
    const markers=[];
    for(let id=0;id<this.stats.capacity;id++)if(positions[id*4+3]>.5){
      markers.push({id,position:Array.from(positions.subarray(id*4,id*4+3)),velocity:Array.from(velocities.subarray(id*4,id*4+3))});
    }
    return markers;
  }
  /** Infrequent readback for slot recycling and honest mass accounting; never per frame. */
  inspect() {
    this.renderer.readRenderTargetPixels(this.particles, 0, 0, this.particleSize.x, this.particleSize.y, this.readback, 0, 0);
    let active = 0, minY=Infinity,maxY=-Infinity,sumY=0,sumX=0;
    this.free.length = 0;
    for (let i = this.stats.capacity - 1; i >= 0; i--) {
      if (this.readback[i * 4 + 3] > .5 || this.pending.has(i)) {
        active++;
        const y=this.readback[i*4+1];minY=Math.min(minY,y);maxY=Math.max(maxY,y);sumY+=y;sumX+=this.readback[i*4];
      } else {
        if(this.readback[i*4+3]<-.5&&!this.invalidIds.has(i)){this.invalidIds.add(i);this.invalidTotal++;}
        this.free.push(i);
      }
    }
    this.stats.active = active;this.stats.invalid = this.invalidTotal;
    this.stats.minY=active?minY:0;this.stats.maxY=active?maxY:0;this.stats.meanY=active?sumY/active:0;
    this.stats.meanX=active?sumX/active:0;
    this.stats.exited = this.stats.initial + this.stats.injected - active - this.invalidTotal;
    this.renderer.readRenderTargetPixels(this.particles, 0, 0, this.particleSize.x, this.particleSize.y, this.readback, 0, 1);
    let speedSquared=0;
    for(let i=0;i<this.stats.capacity;i++)if(this.readback[i*4+3]>.5){const x=this.readback[i*4],y=this.readback[i*4+1],z=this.readback[i*4+2];speedSquared+=x*x+y*y+z*z;}
    this.stats.rmsSpeed=active?Math.sqrt(speedSquared/active):0;
    return { ...this.stats };
  }

  dispose() {
    this.targets.forEach(target => target.dispose());
    Object.values(this.materials).forEach(material => material.dispose());
    this.quad.geometry.dispose();this.splatGeometry.dispose();this.seeds.dispose();
  }
}
