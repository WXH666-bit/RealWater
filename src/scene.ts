import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FluidSolver } from './fluid/solver';
import { FluidSurface } from './fluid/implicit-surface';
import { backdropShader } from './fluid/backdrop';
import { FIXED_DT, MAX_TILT, PROFILES, StepClock, clamp, type Quality } from './config';

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
  paused = false;
  quality: Quality;
  pendingQuality: Quality | null = null;
  fps = 0;
  simulationRate = 0;
  resolutionScale: number;
  onUpdate?: () => void;
  onWarning?: (text: string) => void;
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
  private qaSamples:{time:number;offsetX:number;speed:number;surfaceY:number}[]=[];
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
    const walls: [number[],number[]][] = [
      [[2.24,.12,1.54],[0,-.78,0]],
      [[.12,1.44,1.54],[-1.06,0,0]],[[.12,1.44,1.54],[1.06,0,0]],
      [[2,1.44,.12],[0,0,-.71]],[[2,1.44,.12],[0,0,.71]],
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
    for (const y of [-.78,.72]) {
      line([-1.06,y,-.71],[1.06,y,-.71]);line([1.06,y,-.71],[1.06,y,.71]);line([1.06,y,.71],[-1.06,y,.71]);line([-1.06,y,.71],[-1.06,y,-.71]);
    }
    for (const x of [-1.06,1.06])for(const z of [-.71,.71])line([x,-.78,z],[x,.72,z]);
    this.frontGlass.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),lineMat));
    const ticks: THREE.Vector3[] = [];
    for(let i=0;i<=6;i++){const y=-.6+i*.2;ticks.push(new THREE.Vector3(.84,y,.773),new THREE.Vector3(i%3===0?.98:.92,y,.773));}
    this.frontGlass.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks),new THREE.LineBasicMaterial({color:'#d4e5e8',transparent:true,opacity:.26,depthWrite:false})));
  }

  private resetCamera() {
    // Consume orbit inertia before setting the front view, so reset cannot
    // drift back towards the previous angle. A small elevation reveals the water.
    const damping=this.controls.enableDamping;this.controls.enableDamping=false;this.controls.update();
    this.camera.position.set(0,1.35,6.5);this.controls.target.set(0,-.04,0);this.controls.update();this.controls.saveState();
    this.controls.enableDamping=damping;
  }
  private resize() {
    const {width,height}=this.host.getBoundingClientRect();
    if(width<1||height<1)return;
    const ratio=Math.min(window.devicePixelRatio,1.75)*this.resolutionScale;
    this.renderer.setPixelRatio(ratio);this.renderer.setSize(width,height);
    this.camera.aspect=width/height;
    this.camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(17))*Math.max(1,.95/this.camera.aspect)));
    this.camera.updateProjectionMatrix();
    const size=this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.background.setSize(size.x,size.y);this.surface.resize(size.x,size.y);
  }
  setPose(x: number,z: number,tiltX=this.targetEuler.x,tiltZ=this.targetEuler.z) {
    if (![x,z,tiltX,tiltZ].every(Number.isFinite))return;
    this.targetPosition.set(clamp(x,-.75,.75),0,clamp(z,-.5,.5));
    this.targetEuler.set(clamp(tiltX,-MAX_TILT,MAX_TILT),0,clamp(tiltZ,-MAX_TILT,MAX_TILT));
  }
  setQuality(quality: Quality) { this.pendingQuality=quality===this.quality?null:quality;this.onUpdate?.(); }
  setPaused(value: boolean) {this.paused=value;this.clock.reset();this.stopAllPour();this.onUpdate?.();}
  private dropOrigin(){return new THREE.Vector3(0,.72,0).applyQuaternion(this.quaternion).add(this.position).add(new THREE.Vector3(0,.65,0));}
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
  reset() {
    this.stopAllPour();this.clock.reset();this.position.set(0,0,0);this.targetPosition.set(0,0,0);
    this.targetEuler.set(0,0,0);this.quaternion.identity();
    this.surface.dispose();this.solver.dispose();
    this.quality=this.pendingQuality??this.quality;this.pendingQuality=null;
    this.resolutionScale=PROFILES[this.quality].scale;
    this.solver=new FluidSolver(this.renderer,this.quality);this.surface=new FluidSurface(this.renderer,this.solver);
    this.paused=false;this.warmup=0;this.qaScenario=null;this.qaResult='未运行';this.resetCamera();this.resize();this.onUpdate?.();
  }
  startScenario(kind:string) {
    this.reset();
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
    this.qaResult='运行中';this.qaScenario={kind,elapsed:0,duration:kind==='settle'?30:kind==='sloshing'?12:kind==='tilt-trace'?20:kind==='rest'?60:kind==='stress'?120:kind==='surface'?1.2:kind==='droplet'?.08:8,start:performance.now()};
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
        if(scenario.kind==='settle')this.setPose(scenario.elapsed<.6?.45*Math.sin(scenario.elapsed*2*Math.PI/.6):0,0);
        if(scenario.kind==='pour'&&Math.floor(scenario.elapsed*8)!==Math.floor((scenario.elapsed-FIXED_DT)*8))this.emitWater();
        this.targetQ.setFromEuler(this.targetEuler);
      }
      this.position.lerp(this.targetPosition,1-Math.exp(-12*FIXED_DT));
      this.quaternion.rotateTowards(this.targetQ,2.5*FIXED_DT);
      this.solver.step(this.position,this.quaternion,this.vp);this.warmup+=FIXED_DT;this.reportSimulatedTime+=FIXED_DT;
      const sampleRate=scenario?.kind==='sloshing'?30:10;
      if((scenario?.kind==='impulse'||scenario?.kind==='sloshing'||scenario?.kind==='settle')&&Math.floor(scenario.elapsed*sampleRate)!==Math.floor((scenario.elapsed-FIXED_DT)*sampleRate)){
        const stats=this.solver.inspect();this.qaSamples.push({time:scenario.elapsed,offsetX:stats.meanX-this.position.x,speed:stats.rmsSpeed,surfaceY:stats.maxY});
      }
      if(scenario?.kind==='tilt-trace'&&[8,12,20].some(t=>scenario.elapsed>=t&&scenario.elapsed-FIXED_DT<t)){
        const stats=this.solver.inspect(),all=this.solver.inspectMarkers();
        const tracked=new Set(this.qaMarkerSamples[0]?.markers.map(marker=>marker.id)??[]);
        const highest=new Set([...all].sort((a,b)=>b.position[1]-a.position[1]).slice(0,16).map(marker=>marker.id));
        const coincidentMarkers=all.length-new Set(all.map(marker=>marker.position.join(','))).size;
        this.qaMarkerSamples.push({time:scenario.elapsed,active:stats.active,maxY:stats.maxY,rmsSpeed:stats.rmsSpeed,coincidentMarkers,markers:all.filter(marker=>tracked.has(marker.id)||highest.has(marker.id))});
      }
      if(scenario?.kind==='settle'&&scenario.elapsed>=scenario.duration)this.setPaused(true);
      if(scenario&&scenario.elapsed>=scenario.duration){
        this.solver.inspect();
        const stats=this.solver.stats,checks:Record<string,boolean>={finite:stats.invalid===0};
        if(scenario.kind==='rest'){
          checks.noWaterLost=stats.active===stats.initial&&stats.exited===0;
          checks.restingSpeed=stats.rmsSpeed<.15;
          checks.noBulkCompression=Math.abs(stats.meanY+.36)<.04;
        }
        if(scenario.kind==='tilt'){
          const rimHeight=Math.min(...[-1,1].flatMap(x=>[-.65,.65].map(z=>new THREE.Vector3(x,.72,z).applyQuaternion(this.quaternion).add(this.position).y)));
          checks.noWaterPinnedAboveRim=stats.active===0||stats.maxY<rimHeight+this.solver.profile.cell;
        }
        if(scenario.kind==='tilt-trace'){
          const rimHeight=new THREE.Vector3(-1,.72,0).applyQuaternion(this.quaternion).add(this.position).y;
          const first=this.qaMarkerSamples[0],last=this.qaMarkerSamples.at(-1);
          // A high marker at eight seconds may be falling spray. Track the same
          // IDs and require subsequent drainage, rather than calling it pinned.
          checks.noPersistentMarkersAboveRim=!!first&&!!last&&first.markers
            .filter(marker=>marker.position[1]>rimHeight+this.solver.profile.cell)
            .every(marker=>{const later=last.markers.find(other=>other.id===marker.id);return !later||later.position[1]<rimHeight+this.solver.profile.cell;});
          checks.finalMarkersBelowRim=stats.active===0||stats.maxY<rimHeight+this.solver.profile.cell;
        }
        this.qaResult=JSON.stringify({scenario:scenario.kind,simulatedSeconds:scenario.elapsed,wallSeconds:(performance.now()-scenario.start)/1000,...stats,checks,passed:Object.values(checks).every(Boolean),textures:this.renderer.info.memory.textures,...(this.qaSamples.length?{samples:this.qaSamples}:{}),...(this.qaMarkerSamples.length?{markerSamples:this.qaMarkerSamples}:{})});this.qaScenario=null;if(scenario.kind==='droplet'||scenario.kind==='surface'||scenario.kind==='rest'||scenario.kind==='tilt-trace')this.setPaused(true);break;
      }
    }
    this.glass.position.copy(this.position);this.glass.quaternion.copy(this.quaternion);
    this.frontGlass.position.copy(this.position);this.frontGlass.quaternion.copy(this.quaternion);
    this.renderer.setRenderTarget(this.background);this.renderer.setClearColor('#151d20',1);this.renderer.clear();
    this.renderer.render(this.scene,this.camera);
    this.surface.render(this.camera,this.background.texture);
    this.renderer.clearDepth();this.renderer.render(this.frontScene,this.camera);
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
  setDebug(value:number){this.surface.setDebug(value);}
  inspectSurfaceHeights(){
    if(this.position.lengthSq()>1e-6||Math.abs(this.quaternion.w)<.999999)throw new Error('液面高度采样需要正立、居中的容器；请先运行静置测试。');
    return this.surface.inspectSurfaceFiltering();
  }
  get surfaceGpuMilliseconds(){return this.surface.gpuMilliseconds;}
  measureSolver(){this.setPaused(true);this.qaScenario=null;this.qaResult='GPU 耗时测量，不作为场景验收';return this.solver.measureSteps(this.position.clone(),this.quaternion.clone(),this.vp.clone());}
  dispose() {
    this.running=false;cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();
    document.removeEventListener('visibilitychange',this.visibility);
    this.canvas.removeEventListener('webglcontextlost',this.contextLost);this.canvas.removeEventListener('webglcontextrestored',this.contextRestored);
    this.controls.dispose();this.surface.dispose();this.solver.dispose();this.background.dispose();
    const geometries=new Set<THREE.BufferGeometry>();const materials=new Set<THREE.Material>();
    for(const scene of [this.scene,this.frontScene])scene.traverse(object=>{if(object instanceof THREE.Mesh||object instanceof THREE.LineSegments){geometries.add(object.geometry);const m=object.material;(Array.isArray(m)?m:[m]).forEach(v=>materials.add(v));}});
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.renderer.dispose();this.canvas.remove();
  }
}
