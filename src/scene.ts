import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FluidSolver } from './fluid/solver';
import { FluidSurface } from './fluid/implicit-surface';
import { backdropShader } from './fluid/backdrop';
import { TANK, WALL, TANK_TRAVEL, FIXED_DT, MAX_TILT, PROFILES, StepClock, clamp, type Quality } from './config';

import {AquariumSystem,type FishKind,FISH_NAMES} from './aquarium';

export class WaterScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(34, 1, .05, 50);
  readonly controls: OrbitControls;
  readonly targetPosition = new THREE.Vector3();
  readonly targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly canvas: HTMLCanvasElement;
  solver: FluidSolver;
  private aquarium: AquariumSystem;
  paused = false;
  quality: Quality;
  pendingQuality: Quality | null = null;
  fps = 0;
  simulationRate = 0;
  resolutionScale: number;
  onUpdate?: () => void;
  onWarning?: (text: string) => void;
  /** An empty message clears the error after a successful reset. */
  onError?: (text: string) => void;
  private scene = new THREE.Scene();
  private glass = new THREE.Group();
  private frontScene = new THREE.Scene();
  private frontGlass = new THREE.Group();
  private surface: FluidSurface;
  private background: THREE.WebGLRenderTarget;
  private clock = new StepClock();
  private vp = new THREE.Matrix4();
  private targetQ = new THREE.Quaternion();
  private raf = 0;
  private last = 0;
  private reportTime = 0;
  private reportSimulatedTime = 0;
  private frames = 0;
  private statsTime = 0;
  private slowTime = 0;
  private resizeObserver: ResizeObserver;
  private pouring: THREE.Vector3 | null = null;
  private continuousPour=false;
  dropRadius = .12;
  private pourTime = 0;
  private warmup = 0;
  private hidden = false;
  private lost = false;
  private running = true;
  private qaScenario: { kind: string; elapsed: number; duration: number; start: number } | null = null;
  qaResult = '未运行';
  private qaSamples:{time:number;offsetX:number;speed:number;surfaceY:number;meanY:number}[]=[];
  private qaMarkerSamples:{time:number;active:number;maxY:number;rmsSpeed:number;coincidentMarkers:number;markers:ReturnType<FluidSolver['inspectMarkers']>}[]=[];

  constructor(private host: HTMLElement, preferred?: Quality) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor('#12191c');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '可交互的三维玻璃缸与水');
    this.canvas.tabIndex = 0;
    const gl = this.renderer.getContext();
    if (!this.renderer.capabilities.isWebGL2 || !gl.getExtension('EXT_color_buffer_float')) {
      this.renderer.dispose();throw new Error('当前浏览器无法运行三维水体，请使用支持 WebGL2 和浮点纹理的较新版 Chrome、Edge 或 Safari，并开启硬件加速。');
    }
    const mobile = matchMedia('(pointer: coarse)').matches;
    this.quality = preferred ?? (mobile || navigator.hardwareConcurrency <= 4 ? 'low' : 'medium');
    this.resolutionScale = PROFILES[this.quality].scale;
    this.background = new THREE.WebGLRenderTarget(1,1, { type: THREE.HalfFloatType, depthBuffer: true });
    // Composite in linear light; encode once in the fluid screen pass.
    this.background.texture.colorSpace = THREE.LinearSRGBColorSpace;
    this.createScene();
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;this.controls.dampingFactor = .08;
    this.controls.enablePan = false;this.controls.minDistance = 3.7;this.controls.maxDistance = 8;
    this.controls.minPolarAngle = .035;this.controls.maxPolarAngle = Math.PI-.035;
    this.controls.minAzimuthAngle=-Infinity;this.controls.maxAzimuthAngle=Infinity;
    this.controls.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: null as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.resetCamera();
    this.solver = new FluidSolver(this.renderer, this.quality);
    this.surface = new FluidSurface(this.renderer, this.solver);
    this.aquarium = new AquariumSystem(this.renderer,this.solver);
    host.append(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());this.resizeObserver.observe(host);
    document.addEventListener('visibilitychange', this.visibility);
    this.canvas.addEventListener('webglcontextlost', this.contextLost);
    this.canvas.addEventListener('webglcontextrestored', this.contextRestored);
    this.renderer.debug.onShaderError = (_gl, _program, vertex, fragment) => {
      const message = `${gl.getShaderInfoLog(vertex)} ${gl.getShaderInfoLog(fragment)}`;
      console.error('RealWater shader error', message);
      this.running = false;this.onError?.('水体着色器未能编译，请刷新或更换浏览器。');
    };
    this.resize();this.raf = requestAnimationFrame(this.frame);
  }

  private createScene() {
    this.scene.background = new THREE.Color('#151d20');
    this.scene.add(new THREE.HemisphereLight('#effdff', '#132128', 2.4));
    this.frontScene.add(new THREE.HemisphereLight('#effdff', '#132128', 2.4));
    for (const scene of [this.scene,this.frontScene]) {
      const key = new THREE.DirectionalLight('#e4ffff', 4);key.position.set(-3,5,4);scene.add(key);
      const rim = new THREE.DirectionalLight('#7bb3c7', 2);rim.position.set(4,1,-2);scene.add(rim);
    }
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShaderMaterial({
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vUv;${backdropShader}void main(){vec2 p=(vUv-.5)*80.;gl_FragColor=vec4(backdropColor(p,fwidth(p*1.6)),1.);}`,
      depthWrite: false,
    }));
    backdrop.position.z = -5;this.scene.add(backdrop);
    this.scene.add(this.glass);this.frontScene.add(this.frontGlass);
    const {x,y,z}=TANK,w=WALL;
    const walls: [number[],number[]][] = [
      [[2*x+4*w,2*w,2*z+4*w],[0,-y-w,0]],
      [[2*w,2*y,2*z+4*w],[-x-w,0,0]],[[2*w,2*y,2*z+4*w],[x+w,0,0]],
      [[2*x,2*y,2*w],[0,0,-z-w]],[[2*x,2*y,2*w],[0,0,z+w]],
    ];
    const rear = new THREE.MeshPhysicalMaterial({ color: '#f1f6f6', roughness: .03, metalness: 0, transparent: true, opacity: .005, depthWrite: false, side: THREE.BackSide });
    const front = new THREE.MeshPhysicalMaterial({ color: '#f5f9f9', roughness: .025, metalness: 0, transparent: true, opacity: .007, depthWrite: false, side: THREE.FrontSide });
    for (const [size, pos] of walls) {
      const geometry = new THREE.BoxGeometry(...size as [number,number,number]);
      const back = new THREE.Mesh(geometry,rear);back.position.fromArray(pos);this.glass.add(back);
      const face = new THREE.Mesh(geometry,front);face.position.fromArray(pos);this.frontGlass.add(face);
    }
    const lineMat = new THREE.LineBasicMaterial({ color: '#b9dedf', transparent: true, opacity: .22, depthWrite: false });
    const points: THREE.Vector3[] = [];
    const line = (a: number[],b:number[]) => {points.push(new THREE.Vector3().fromArray(a),new THREE.Vector3().fromArray(b));};
    for (const height of [-y-w,y]) {
      line([-x-w,height,-z-w],[x+w,height,-z-w]);line([x+w,height,-z-w],[x+w,height,z+w]);
      line([x+w,height,z+w],[-x-w,height,z+w]);line([-x-w,height,z+w],[-x-w,height,-z-w]);
    }
    for (const xx of [-x-w,x+w])for(const zz of [-z-w,z+w])line([xx,-y-w,zz],[xx,y,zz]);
    this.frontGlass.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),lineMat));
    const ticks: THREE.Vector3[] = [];
    for(let i=0;i<=6;i++){const height=(-.6+i*.2)*y/.72;ticks.push(new THREE.Vector3(x-.16,height,z+2*w+.003),new THREE.Vector3(x-(i%3===0?.02:.08),height,z+2*w+.003));}
    this.frontGlass.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks),new THREE.LineBasicMaterial({color:'#d4e5e8',transparent:true,opacity:.26,depthWrite:false})));
  }

  private resetCamera() {
    // Consume orbit inertia before setting the front view, so reset cannot
    // drift back towards the previous angle. A small elevation reveals the water.
    const damping=this.controls.enableDamping;this.controls.enableDamping=false;this.controls.update();
    this.camera.position.set(0,1.2,5.8);this.controls.target.set(0,-.04,0);this.controls.update();this.controls.saveState();
    this.controls.enableDamping=damping;
  }
  private resize() {
    const {width,height}=this.host.getBoundingClientRect();
    if(width<1||height<1)return;
    const ratio=Math.min(window.devicePixelRatio,1.75)*this.resolutionScale;
    this.renderer.setPixelRatio(ratio);this.renderer.setSize(width,height);
    this.camera.aspect=width/height;
    this.camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(17))*Math.max(1,(TANK.x+.12)*.75/this.camera.aspect)));
    this.camera.updateProjectionMatrix();
    const size=this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.background.setSize(size.x,size.y);this.surface.resize(size.x,size.y);
  }
  setPose(x: number,z: number,tiltX=this.targetEuler.x,tiltZ=this.targetEuler.z) {
    if (![x,z,tiltX,tiltZ].every(Number.isFinite))return;
    this.targetPosition.set(clamp(x,-TANK_TRAVEL.x,TANK_TRAVEL.x),0,clamp(z,-TANK_TRAVEL.z,TANK_TRAVEL.z));
    this.targetEuler.set(clamp(tiltX,-MAX_TILT,MAX_TILT),0,clamp(tiltZ,-MAX_TILT,MAX_TILT));
  }
  setQuality(quality: Quality) { this.pendingQuality=quality===this.quality?null:quality;this.onUpdate?.(); }
  setPaused(value: boolean) {this.paused=value;this.clock.reset();this.stopAllPour();this.onUpdate?.();}
  private dropOrigin(){return new THREE.Vector3(0,TANK.y,0).applyQuaternion(this.quaternion).add(this.position).add(new THREE.Vector3(0,.65,0));}
  emitWater(point?: THREE.Vector3) {
    if(this.paused||this.hidden||this.lost)return false;
    const p=point??this.dropOrigin();
    const ok=this.solver.emit(p,this.dropRadius);
    if(!ok){this.stopAllPour();this.onWarning?.('水量已达到当前画质上限。让一些水流出，或重置后继续。');}
    return ok;
  }
  startPour(point: THREE.Vector3) {this.pouring=point.clone();this.pourTime=0;this.emitWater(point);}
  updatePour(point: THREE.Vector3) {this.pouring?.copy(point);}
  stopPour() {this.pouring=null;}
  get isContinuouslyPouring(){return this.continuousPour;}
  setContinuousPour(value:boolean){
    this.continuousPour=value&&!this.paused&&!this.hidden&&!this.lost;
    if(this.continuousPour){this.pourTime=0;this.emitWater();}
    this.onUpdate?.();
  }
  private stopAllPour(){this.pouring=null;this.continuousPour=false;}
  get fishCount(){return this.aquarium.count;}
  addFish(kind:FishKind){
    if(this.hidden||this.lost)return false;
    const result=this.aquarium.add(kind);
    this.onWarning?.(result==='added'?'已加入'+FISH_NAMES[kind]:result==='capacity'?'最多可容纳 12 条小鱼。':'当前没有足够的水域，请加水或重置后再添加。');
    this.onUpdate?.();return result==='added';
  }
  clearFish(){this.aquarium.clear();this.onUpdate?.();}
  inspectFish(){return this.aquarium.inspect();}
  reset(preserveFish=true) {
    const fish=preserveFish?this.aquarium.savedKinds():[];
    this.stopAllPour();this.clock.reset();this.position.set(0,0,0);this.targetPosition.set(0,0,0);
    this.targetEuler.set(0,0,0);this.quaternion.identity();
    this.aquarium.dispose();this.surface.dispose();this.solver.dispose();
    this.quality=this.pendingQuality??this.quality;this.pendingQuality=null;
    this.resolutionScale=PROFILES[this.quality].scale;
    this.solver=new FluidSolver(this.renderer,this.quality);this.surface=new FluidSurface(this.renderer,this.solver);
    this.aquarium=new AquariumSystem(this.renderer,this.solver);
    const rejected=this.aquarium.restore(fish);
    if(rejected)this.onWarning?.(`水域不足，已收回 ${rejected} 条小鱼。`);
    this.paused=false;this.warmup=0;this.qaScenario=null;this.qaResult='未运行';this.resetCamera();this.resize();
    if(!this.lost&&this.running)this.onError?.('');
    this.onUpdate?.();
  }
  startScenario(kind:string) {
    this.reset(false);
    this.qaSamples=[];
    this.qaMarkerSamples=[];
    if(kind==='capacity'){
      const before={...this.solver.stats};
      const radius=Math.cbrt((before.capacity+1)*this.solver.markerVolume/(4/3*Math.PI));
      const accepted=this.solver.emit(new THREE.Vector3(0,1,0),radius);
      this.qaResult=JSON.stringify({scenario:kind,accepted,activeUnchanged:before.active===this.solver.stats.active,injectedUnchanged:before.injected===this.solver.stats.injected});
      this.onUpdate?.();return;
    }
    if(kind==='droplet')this.emitWater();
    this.qaResult='运行中';this.qaScenario={kind,elapsed:0,duration:kind==='settle-long'||kind==='settle-shake'?120:kind==='settle'?30:kind==='sloshing'?12:(kind==='tilt'||kind==='tilt-trace')?20:kind==='rest'?60:kind==='stress'?120:kind==='surface'?1.2:kind==='droplet'?.08:8,start:performance.now()};
  }
  private visibility=()=>{this.hidden=document.hidden;this.clock.reset();this.last=0;this.stopAllPour();this.onUpdate?.();};
  private contextLost=(event:Event)=>{event.preventDefault();this.lost=true;this.clock.reset();this.stopAllPour();this.onUpdate?.();this.onError?.('图形连接已中断。恢复后会重新初始化水体。');};
  private contextRestored=()=>{this.lost=false;this.reset();this.onWarning?.('图形连接已恢复，水体已重置。');};
  private frame=(time:number)=>{
    if(!this.running)return;
    this.raf=requestAnimationFrame(this.frame);
    if(this.last&&time-this.last<1000/60-.6)return;
    const elapsed=this.last?(time-this.last)/1000:0;
    const dt=Math.min(elapsed,.1);this.last=time;
    if(this.hidden||this.lost)return;
    this.controls.update();this.camera.updateMatrixWorld();this.vp.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);
    let steps=this.clock.advance(elapsed,this.paused);
    // Explicit developer QA runs fixed-step batches, independent of background RAF throttling.
    if(this.qaScenario&&!this.paused)steps=120;
    if((this.pouring||this.continuousPour)&&!this.paused){this.pourTime+=dt;if(this.pourTime>.12){this.pourTime%=.12;this.emitWater(this.pouring??undefined);}}
    this.targetQ.setFromEuler(this.targetEuler);
    for(let i=0;i<steps;i++){
      const scenario=this.qaScenario;
      if(scenario){
        scenario.elapsed+=FIXED_DT;
        if(scenario.kind==='shake'||scenario.kind==='stress')this.setPose(Math.sin(scenario.elapsed*9)*.65,Math.sin(scenario.elapsed*5)*.3,Math.sin(scenario.elapsed*3)*.32,Math.sin(scenario.elapsed*4)*.4);
        if(scenario.kind==='tilt'||scenario.kind==='tilt-trace')this.setPose(0,0,0,Math.min(scenario.elapsed*.3,1.3));
        if(scenario.kind==='impulse')this.setPose(clamp((scenario.elapsed-2)/.15,0,1)*.35,0);
        if(scenario.kind==='sloshing')this.setPose(clamp((scenario.elapsed-2)/.15,0,1)*.04,0);
        if(scenario.kind==='surface')this.setPose(scenario.elapsed<.4?.25*Math.sin(scenario.elapsed*Math.PI/.4):0,0);
        if(scenario.kind==='settle-shake'){
          const t=scenario.elapsed;
          if(t<4)this.setPose(Math.sin(t*9)*.65,Math.sin(t*5)*.3,Math.sin(t*3)*.32,Math.sin(t*4)*.4);
          else this.setPose(0,0,0,0);
        }else if(scenario.kind.startsWith('settle'))this.setPose(scenario.elapsed<.6?.45*Math.sin(scenario.elapsed*2*Math.PI/.6):0,0);
        if(scenario.kind==='pour'&&Math.floor(scenario.elapsed*8)!==Math.floor((scenario.elapsed-FIXED_DT)*8))this.emitWater();
        this.targetQ.setFromEuler(this.targetEuler);
      }
      this.position.lerp(this.targetPosition,1-Math.exp(-12*FIXED_DT));
      this.quaternion.rotateTowards(this.targetQ,2.5*FIXED_DT);
      this.solver.step(this.position,this.quaternion,this.vp);
      const collected=this.aquarium.step();
      if(collected){this.onWarning?.(`水域不足，已收回 ${collected} 条小鱼。`);this.onUpdate?.();}
      this.warmup+=FIXED_DT;this.reportSimulatedTime+=FIXED_DT;
      const sampleRate=scenario?.kind==='sloshing'?30:10;
      if(scenario&&(scenario.kind==='impulse'||scenario.kind==='sloshing'||scenario.kind.startsWith('settle'))&&Math.floor(scenario.elapsed*sampleRate)!==Math.floor((scenario.elapsed-FIXED_DT)*sampleRate)){
        const stats=this.solver.inspect();this.qaSamples.push({time:scenario.elapsed,offsetX:stats.meanX-this.position.x,speed:Math.max(stats.rmsSpeed,stats.motionRmsSpeed),surfaceY:stats.maxY,meanY:stats.meanY});
      }
      if(scenario?.kind==='tilt-trace'&&[8,12,20].some(t=>scenario.elapsed>=t&&scenario.elapsed-FIXED_DT<t)){
        const stats=this.solver.inspect(),all=this.solver.inspectMarkers();
        const tracked=new Set(this.qaMarkerSamples[0]?.markers.map(marker=>marker.id)??[]);
        const highest=new Set([...all].sort((a,b)=>b.position[1]-a.position[1]).slice(0,16).map(marker=>marker.id));
        const coincidentMarkers=all.length-new Set(all.map(marker=>marker.position.join(','))).size;
        this.qaMarkerSamples.push({time:scenario.elapsed,active:stats.active,maxY:stats.maxY,rmsSpeed:stats.rmsSpeed,coincidentMarkers,markers:all.filter(marker=>tracked.has(marker.id)||highest.has(marker.id))});
      }
      if(scenario?.kind.startsWith('settle')&&scenario.elapsed>=scenario.duration)this.setPaused(true);
      if(scenario&&scenario.elapsed>=scenario.duration){
        this.solver.inspect();
        const stats=this.solver.stats,checks:Record<string,boolean>={finite:stats.invalid===0};
        const markerSummary=scenario.kind.startsWith('settle')?(()=>{
          const markers=this.solver.inspectMarkers();
          return {coincident:markers.length-new Set(markers.map(m=>m.position.join(','))).size,
            fastest:markers.sort((a,b)=>b.velocity.reduce((s,v)=>s+v*v,0)-a.velocity.reduce((s,v)=>s+v*v,0)).slice(0,12)};
        })():undefined;
        if(scenario.kind.startsWith('settle')){
          // Correct the expected half-depth for water that actually spilled.
          const expectedMean=-TANK.y+TANK.y*.5*stats.active/stats.initial;
          checks.settledSpeed=Math.max(stats.rmsSpeed,stats.motionRmsSpeed)<.03;
          checks.bulkHeightWithinTolerance=Math.abs(stats.meanY-expectedMean)<.04;
          const late=this.qaSamples.filter(sample=>sample.time>=scenario.duration-10);
          checks.lateWindowStable=late.length>=90&&late.every(sample=>sample.speed<.03);
          checks.noLateHeightDrift=late.length>0&&Math.max(...late.map(sample=>sample.meanY))-Math.min(...late.map(sample=>sample.meanY))<.003;
        }
        if(scenario.kind==='rest'){
          checks.noWaterLost=stats.active===stats.initial&&stats.exited===0;
          checks.restingSpeed=stats.rmsSpeed<.15;
          checks.noBulkCompression=Math.abs(stats.meanY+TANK.y*.5)<.04;
        }
        if(scenario.kind==='tilt'){
          const rimHeight=Math.min(...[-TANK.x,TANK.x].flatMap(x=>[-TANK.z,TANK.z].map(z=>new THREE.Vector3(x,TANK.y,z).applyQuaternion(this.quaternion).add(this.position).y)));
          checks.noWaterPinnedAboveRim=stats.active===0||stats.maxY<rimHeight+this.solver.profile.cell;
        }
        if(scenario.kind==='tilt-trace'){
          const rimHeight=new THREE.Vector3(-TANK.x,TANK.y,0).applyQuaternion(this.quaternion).add(this.position).y;
          const first=this.qaMarkerSamples[0],last=this.qaMarkerSamples.at(-1);
          // A high marker at eight seconds may be falling spray. Track the same
          // IDs and require subsequent drainage, rather than calling it pinned.
          checks.noPersistentMarkersAboveRim=!!first&&!!last&&first.markers
            .filter(marker=>marker.position[1]>rimHeight+this.solver.profile.cell)
            .every(marker=>{const later=last.markers.find(other=>other.id===marker.id);return !later||later.position[1]<rimHeight+this.solver.profile.cell;});
          checks.finalMarkersBelowRim=stats.active===0||stats.maxY<rimHeight+this.solver.profile.cell;
        }
        this.qaResult=JSON.stringify({scenario:scenario.kind,simulatedSeconds:scenario.elapsed,wallSeconds:(performance.now()-scenario.start)/1000,...stats,checks,passed:Object.values(checks).every(Boolean),textures:this.renderer.info.memory.textures,markerSummary,...(this.qaSamples.length?{samples:this.qaSamples}:{}),...(this.qaMarkerSamples.length?{markerSamples:this.qaMarkerSamples}:{})});this.qaScenario=null;if(scenario.kind==='droplet'||scenario.kind==='surface'||scenario.kind==='rest'||scenario.kind==='tilt-trace')this.setPaused(true);break;
      }
    }
    this.renderScene();
    this.frames++;this.reportTime+=elapsed;this.statsTime+=dt;
    if(this.reportTime>=1){
      this.fps=this.frames/this.reportTime;this.simulationRate=this.reportSimulatedTime/this.reportTime;
      this.frames=0;this.reportTime=0;this.reportSimulatedTime=0;
      if(this.fps<28&&this.warmup>5&&!this.paused&&!this.qaScenario&&document.hasFocus()&&elapsed<.15)this.slowTime++;else this.slowTime=0;
      if(this.slowTime>=3&&this.resolutionScale>.5){this.resolutionScale=Math.max(.5,this.resolutionScale-.1);this.resize();this.slowTime=0;}
      this.onUpdate?.();
    }
    if(this.statsTime>2){this.solver.inspect();this.statsTime=0;if(this.solver.stats.invalid>0&&!this.paused){this.setPaused(true);this.onError?.('检测到模拟数值异常，已暂停。请重新开始或选择较低画质。');}}
  };
  private renderScene(){
    this.glass.position.copy(this.position);this.glass.quaternion.copy(this.quaternion);
    this.frontGlass.position.copy(this.position);this.frontGlass.quaternion.copy(this.quaternion);
    this.renderer.setRenderTarget(this.background);this.renderer.setClearColor('#151d20',1);this.renderer.clear();
    this.renderer.render(this.scene,this.camera);
    this.surface.render(this.camera,this.background.texture,this.aquarium);
    this.renderer.clearDepth();this.renderer.render(this.frontScene,this.camera);
  }
  async measureAquariumPerformance(){
    const gl=this.renderer.getContext() as WebGL2RenderingContext;
    const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!timer)return {available:false,reason:'GPU timer unavailable'};
    const kinds=this.aquarium.savedKinds(),quality=this.quality;
    const samples:{fish:number;gpuMillisecondsPerFrame:number;cpuSubmissionMillisecondsPerFrame:number}[]=[];
    const queries:WebGLQuery[]=[];
    this.reset(false);this.setPaused(true);
    this.camera.updateMatrixWorld();this.vp.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);
    const advance=(i:number)=>{
      for(let j=0;j<(i%2?2:1);j++){this.solver.step(this.position,this.quaternion,this.vp);this.aquarium.step();}
      this.renderScene();
    };
    try{
      for(const count of [0,12,0,12]){
        this.aquarium.clear();
        for(let i=0;i<count;i++)if(this.aquarium.add((['clown','blue','yellow'] as const)[i%3])!=='added')throw new Error('Cannot populate benchmark aquarium');
        for(let i=0;i<12;i++)advance(i);
        if(gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))throw new Error('Another GPU timer is active');
        const query=gl.createQuery();if(!query)throw new Error('GPU timer allocation failed');queries.push(query);
        const frames=60,start=performance.now();
        gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
        try{for(let i=0;i<frames;i++)advance(i);}finally{gl.endQuery(timer.TIME_ELAPSED_EXT);}
        const cpu=performance.now()-start;gl.flush();const wait=performance.now();
        while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
          if(gl.isContextLost()||performance.now()-wait>15000)throw new Error('GPU query timeout');
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        if(gl.getParameter(timer.GPU_DISJOINT_EXT))throw new Error('Disjoint GPU timer');
        samples.push({fish:count,gpuMillisecondsPerFrame:gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6/frames,cpuSubmissionMillisecondsPerFrame:cpu/frames});
      }
      const average=(count:number)=>samples.filter(s=>s.fish===count).reduce((sum,s)=>sum+s.gpuMillisecondsPerFrame,0)/2;
      const ratio=average(12)/average(0),size=this.renderer.getDrawingBufferSize(new THREE.Vector2());
      return {available:true,quality,resolution:size.toArray(),samples,gpuOverheadPercent:(ratio-1)*100,withinTarget:ratio<=1.25,note:'Complete GPU frames with alternating 1/2 physics steps, fixed resolution; excludes browser compositing.'};
    }finally{queries.forEach(q=>gl.deleteQuery(q));this.reset(false);this.aquarium.restore(kinds);this.setPaused(true);}
  }
  setDebug(value:number){this.surface.setDebug(value);}
  inspectSurfaceHeights(){
    if(this.position.lengthSq()>1e-6||Math.abs(this.quaternion.w)<.999999)throw new Error('液面高度采样需要正立、居中的容器；请先运行静置测试。');
    const points:THREE.Vector3[]=[];
    for(const y of [-TANK.y+.04,-TANK.y+.22,-TANK.y+.42])for(const x of [-TANK.x+.002,-TANK.x+.05,-TANK.x+.2,0,TANK.x-.2,TANK.x-.05,TANK.x-.002])for(const z of [-TANK.z+.002,-TANK.z+.05,0,TANK.z-.05,TANK.z-.002])points.push(new THREE.Vector3(x,y,z));
    for(let y=-TANK.y+.02;y<-TANK.y+.23;y+=.025)for(let x=-TANK.x+.02;x<TANK.x;x+=.05)for(const z of [-TANK.z+.002,TANK.z-.002])points.push(new THREE.Vector3(x,y,z));
    const fields=this.surface.inspectSupport(points);
    const outside=this.solver.inspectMarkers().filter(({position:[x,y,z]})=>y<0&&y>-TANK.y-2*WALL-.01&&(Math.abs(x)>TANK.x||Math.abs(z)>TANK.z));
    return {...this.surface.inspectSurfaceFiltering(),outsideNearBottom:outside,wallProbes:{samples:points.length,voids:fields.flatMap(([phi,support,speed],i)=>phi>0?[{position:points[i].toArray(),phi,support,speed}]:[]),thin:fields.flatMap(([phi,support,speed,rawPhi],i)=>rawPhi>-.008?[{position:points[i].toArray(),phi,rawPhi,support,speed}]:[])}};
  }
  get surfaceGpuMilliseconds(){return this.surface.gpuMilliseconds;}
  measureSolver(){this.setPaused(true);this.qaScenario=null;this.qaResult='GPU 耗时测量，不作为场景验收';return this.solver.measureSteps(this.position.clone(),this.quaternion.clone(),this.vp.clone());}
  dispose() {
    this.running=false;cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange',this.visibility);
    this.canvas.removeEventListener('webglcontextlost',this.contextLost);this.canvas.removeEventListener('webglcontextrestored',this.contextRestored);
    this.controls.dispose();this.aquarium.dispose();this.surface.dispose();this.solver.dispose();this.background.dispose();
    const geometries=new Set<THREE.BufferGeometry>();const materials=new Set<THREE.Material>();
    for(const scene of [this.scene,this.frontScene])scene.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){geometries.add(object.geometry);const m=object.material;(Array.isArray(m)?m:[m]).forEach(v=>materials.add(v));}});
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.renderer.dispose();this.canvas.remove();
  }
}
