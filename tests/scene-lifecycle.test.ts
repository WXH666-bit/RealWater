import {afterEach,describe,expect,it,vi} from 'vitest';
import {WaterScene} from '../src/scene';

const state=vi.hoisted(()=>({failSolver:false}));
vi.mock('three',async importOriginal=>{
  const actual=await importOriginal<typeof import('three')>();
  return {...actual,WebGLRenderer:class {
    domElement=Object.assign(new EventTarget(),{setAttribute(){},remove(){}});
    capabilities={isWebGL2:true};debug={};
    setClearColor(){} dispose(){}
    getContext(){return {getExtension:()=>({})};}
  }};
});
vi.mock('three/addons/controls/OrbitControls.js',async()=>{
  const {Vector3}=await import('three');
  return {OrbitControls:class {
    target=new Vector3();enableDamping=false;
    update(){} saveState(){} dispose(){}
  }};
});
vi.mock('../src/fluid/solver',()=>({FluidSolver:class {
  constructor(){if(state.failSolver)throw new Error('Allocation failed');}
  dispose(){}
}}));
vi.mock('../src/fluid/implicit-surface',()=>({FluidSurface:class {dispose(){}}}));
vi.mock('../src/aquarium',()=>({FISH_LIMIT:12,FISH_NAMES:{clown:'橙白条纹鱼',blue:'蓝色扁身鱼',yellow:'黄色细身鱼'},AquariumSystem:class {
  kinds:string[]=[];get count(){return this.kinds.length;}
  dispose(){} savedKinds(){return [...this.kinds];}
  restore(kinds:string[]){this.kinds=[...kinds];return 0;}
  add(kind:string){this.kinds.push(kind);return 'added';} clear(){this.kinds=[];}
}}));

describe('scene error recovery',()=>{
  let scene:WaterScene|undefined;
  function setup(){
    vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));
    vi.stubGlobal('matchMedia',()=>({matches:false}));
    vi.stubGlobal('navigator',{hardwareConcurrency:8});
    vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
    vi.stubGlobal('requestAnimationFrame',()=>1);
    vi.stubGlobal('cancelAnimationFrame',()=>{});
    const host={append(){},getBoundingClientRect:()=>({width:0,height:0})};
    scene=new WaterScene(host as unknown as HTMLElement);
    const onError=vi.fn();scene.onError=onError;
    return {scene,onError};
  }
  afterEach(()=>{state.failSolver=false;scene?.dispose();scene=undefined;vi.unstubAllGlobals();});
  it('clears the error after context recovery successfully rebuilds the scene',()=>{
    const {scene,onError}=setup();
    const lost=new Event('webglcontextlost',{cancelable:true});scene.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('中断'));
    scene.canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(onError).toHaveBeenLastCalledWith('');expect(scene.paused).toBe(false);
  });
  it('retains the context error when reset is requested while the context is lost',()=>{
    const {scene,onError}=setup();scene.canvas.dispatchEvent(new Event('webglcontextlost'));
    scene.reset();expect(onError).toHaveBeenCalledOnce();
  });
  it('does not report error clearance if rebuilding fails',()=>{
    const {scene,onError}=setup();state.failSolver=true;
    expect(()=>scene.reset()).toThrow('Allocation failed');expect(onError).not.toHaveBeenCalled();
  });
  it('clears a previous simulation error on a successful manual reset',()=>{
    const {scene,onError}=setup();scene.setPaused(true);scene.reset();
    expect(onError).toHaveBeenLastCalledWith('');
  });
  it('allows fish addition and clearing while paused',()=>{
    const {scene}=setup();scene.setPaused(true);
    expect(scene.addFish('clown')).toBe(true);expect(scene.fishCount).toBe(1);
    scene.clearFish();expect(scene.fishCount).toBe(0);expect(scene.paused).toBe(true);
  });
  it('keeps the population through reset and quality changes',()=>{
    const {scene}=setup();scene.addFish('clown');scene.addFish('blue');scene.addFish('yellow');
    scene.reset();expect(scene.fishCount).toBe(3);
    scene.setQuality('high');scene.reset();expect(scene.quality).toBe('high');expect(scene.fishCount).toBe(3);
  });
  it('retains population metadata through context loss and refuses unavailable additions',()=>{
    const {scene}=setup();scene.addFish('blue');scene.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(scene.addFish('clown')).toBe(false);scene.canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(scene.fishCount).toBe(1);
  });
  it('runs fluid diagnostics without fish',()=>{
    const {scene}=setup();scene.addFish('yellow');scene.startScenario('rest');expect(scene.fishCount).toBe(0);
  });
});
