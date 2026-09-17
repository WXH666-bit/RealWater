import * as THREE from 'three';
import { FIXED_DT, GRAVITY, PROFILES, initialParticles, randomSequence, type Quality } from '../config';
import * as shader from './shaders';

type Uniforms = Record<string, THREE.IUniform>;
export interface FluidStats { active: number; initial: number; injected: number; exited: number; capacity: number; invalid: number; minY: number; maxY: number; meanY: number; meanX:number; rmsSpeed:number; }

export class FluidSolver {
  readonly profile;
  readonly particleSize: THREE.Vector2;
  readonly radius: number;
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
  private accum: THREE.WebGLRenderTarget;
  private original: THREE.WebGLRenderTarget;
  private originalNext: THREE.WebGLRenderTarget;
  private forced: THREE.WebGLRenderTarget;
  private projected: THREE.WebGLRenderTarget;
  private projectedNext: THREE.WebGLRenderTarget;
  private divergence: THREE.WebGLRenderTarget;
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
      uPreviousCenter: { value: new THREE.Vector3() }, uRotation: { value: new THREE.Matrix3() },
      uInverse: { value: new THREE.Matrix3() }, uPreviousInverse: { value: new THREE.Matrix3() },
      uLinear: { value: new THREE.Vector3() }, uAngular: { value: new THREE.Vector3() },
      uPositions: { value: null }, uVelocities: { value: null }, uGridVelocity: { value: null },
      uOriginalVelocity: { value: null }, uWeights: { value: null }, uPressure: { value: null },
      uDivergence: { value: null }, uSeeds: { value: this.seeds }, uMomentum: { value: null },
      uParticleSize: { value: this.particleSize }, uLayer: { value: 0 }, uSource: { value: null },
      uViewProjection: { value: new THREE.Matrix4() }, uInjectOnly: { value: false }, uEmissionVelocity: { value: 0 },
    };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geometry);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const fragments = { normalize: shader.normalizeFragment, extrapolate: shader.extrapolateFragment, force: shader.forceFragment, divergence: shader.divergenceFragment, pressure: shader.pressureFragment, project: shader.projectFragment, particle: shader.particleFragment, copy: shader.copyFragment };
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
    this.pressure = this.target(w, h);
    this.pressureNext = this.target(w, h);
    this.particles = this.target(this.particleSize.x, this.particleSize.y, 2, THREE.FloatType);
    this.particlesNext = this.target(this.particleSize.x, this.particleSize.y, 2, THREE.FloatType);
    const initialTexture = this.dataTexture(initial.positions);
    this.uniforms.uSeeds.value = initialTexture;
    this.uniforms.uPositions.value = this.seeds;
    this.uniforms.uVelocities.value = this.seeds;
    this.uniforms.uInjectOnly.value = true;
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
  private swapParticles() {
    [this.particles, this.particlesNext] = [this.particlesNext, this.particles];
    this.bindParticles();
  }

  emit(center: THREE.Vector3, radius: number): boolean {
    const count = Math.max(12, Math.round(4 / 3 * Math.PI * radius ** 3 / (this.profile.cell * .55) ** 3));
    if (this.free.length < count) return false;
    for (let i = 0; i < count; i++) {
      let x = 0, y = 0, z = 0;
      do { x = this.random() * 2 - 1; y = this.random() * 2 - 1; z = this.random() * 2 - 1; } while (x * x + y * y + z * z > 1);
      const id = this.free.pop()!;
      this.invalidIds.delete(id);
      this.seedData.set([center.x + x * radius, center.y + y * radius, center.z + z * radius, 1], id * 4);
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
    this.pass('particle', this.particlesNext);
    this.swapParticles();
    this.previousPosition.copy(position);this.previousQuaternion.copy(quaternion);
    this.revision++;
    this.renderer.setRenderTarget(null);
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
