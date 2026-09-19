import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as THREE from 'three';
import {WaterInput} from '../src/input';
import type {WaterScene} from '../src/scene';

describe('input lifecycle and gestures',()=>{
  let input:WaterInput;
  let scene:ReturnType<typeof makeScene>;
  let notify=vi.fn<(message:string)=>void>();
  function makeScene(){
    const camera=new THREE.PerspectiveCamera(34,1000/800,.05,50);
    camera.position.set(0,1.35,6.5);camera.lookAt(0,-.04,0);camera.updateMatrixWorld();
    let pouring=false;
    return {
      canvas:Object.assign(new EventTarget(),{dataset:{},setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0,width:1000,height:800})}),
      camera,controls:{touches:{},mouseButtons:{}},position:new THREE.Vector3(),quaternion:new THREE.Quaternion(),
      targetPosition:new THREE.Vector3(),targetEuler:new THREE.Euler(),paused:false,dropRadius:.12,
      get pouring(){return pouring;},
      startPour:vi.fn(()=>{pouring=true;}),stopPour:vi.fn(()=>{pouring=false;}),updatePour:vi.fn(),
      emitWater:vi.fn(),reset:vi.fn(),setPose:vi.fn(),
    };
  }
  function point(x:number,y:number,z:number){
    const p=new THREE.Vector3(x,y,z).project(scene.camera);
    return {clientX:(p.x+1)*500,clientY:(1-p.y)*400};
  }
  function pointer(type:string,p:{clientX:number;clientY:number},pointerType='mouse'){
    scene.canvas.dispatchEvent(Object.assign(new Event(type),{button:0,pointerId:1,shiftKey:false,pointerType,...p}));
  }
  function tap(p:{clientX:number;clientY:number}){pointer('pointerdown',p);pointer('pointerup',p);}
  function permission(){
    let resolve!:(value:string)=>void,reject!:(reason:Error)=>void;
    const promise=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});
    const orientation={requestPermission:vi.fn(()=>promise)};
    vi.stubGlobal('DeviceOrientationEvent',orientation);
    Object.assign(window,{DeviceOrientationEvent:orientation,isSecureContext:true});
    return {resolve,reject};
  }
  beforeEach(()=>{
    vi.useFakeTimers();
    vi.stubGlobal('window',Object.assign(new EventTarget(),{setTimeout,clearTimeout}));
    vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));
    scene=makeScene();notify=vi.fn();input=new WaterInput(scene as unknown as WaterScene,notify);
  });
  afterEach(()=>{input.dispose();vi.useRealTimers();vi.unstubAllGlobals();});

  it('resumes pouring when a held drag returns to the opening',()=>{
    input.setMode('drop');pointer('pointerdown',point(0,.72,0));vi.advanceTimersByTime(301);
    expect(scene.pouring).toBe(true);
    pointer('pointermove',{clientX:10,clientY:10});expect(scene.pouring).toBe(false);
    pointer('pointermove',point(.2,.72,0));expect(scene.pouring).toBe(true);
    expect(scene.startPour).toHaveBeenCalledTimes(2);
    pointer('pointerup',point(.2,.72,0));expect(scene.pouring).toBe(false);
    expect(scene.emitWater).not.toHaveBeenCalled();
  });
  it.each(['auto','move','tilt','drop','orbit'] as const)('does not reset on tank double clicks in %s mode',mode=>{
    input.setMode(mode);tap(point(0,0,0));tap(point(0,0,0));
    expect(scene.reset).not.toHaveBeenCalled();
  });
  it.each(['auto','move','tilt','drop','orbit'] as const)('still resets on blank double clicks in %s mode',mode=>{
    input.setMode(mode);const blank={clientX:10,clientY:10};tap(blank);
    expect(scene.reset).not.toHaveBeenCalled();tap(blank);expect(scene.reset).toHaveBeenCalledOnce();
  });
  it('still emits a single drop on an opening tap',()=>{
    input.setMode('drop');tap(point(0,.72,0));expect(scene.emitWater).toHaveBeenCalledOnce();
  });
  it('recognizes the widened opening while rejecting clicks beyond the new rim',()=>{
    input.setMode('drop');tap(point(1.2,.72,0));expect(scene.emitWater).toHaveBeenCalledOnce();
    tap(point(1.6,.72,0));expect(scene.emitWater).toHaveBeenCalledOnce();
    input.setMode('orbit');tap(point(1.2,0,0));tap(point(1.2,0,0));expect(scene.reset).not.toHaveBeenCalled();
  });
  it.each(['disable','dispose','toggle','drag'] as const)('ignores late permission after %s',async action=>{
    const grant=permission(),pending=input.toggleMotion();
    if(action==='disable')input.disableMotion();
    if(action==='dispose')input.dispose();
    if(action==='toggle')await input.toggleMotion();
    if(action==='drag'){
      input.setMode('move');pointer('pointerdown',point(0,0,0));pointer('pointermove',point(.2,0,0));
    }
    grant.resolve('granted');await pending;
    expect(input.motionEnabled).toBe(false);expect(notify).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not let an old rejection disable a newer successful request',async()=>{
    const old=permission(),pending=input.toggleMotion();input.disableMotion();
    const latest=permission(),newPending=input.toggleMotion();latest.resolve('granted');await newPending;
    old.reject(new Error('stale'));await pending;
    expect(input.motionEnabled).toBe(true);expect(notify).toHaveBeenCalledOnce();
  });
  it('enables normally and detaches sensor listeners when disabled',async()=>{
    const grant=permission(),pending=input.toggleMotion();grant.resolve('granted');await pending;
    expect(input.motionEnabled).toBe(true);input.disableMotion();
    window.dispatchEvent(Object.assign(new Event('deviceorientation'),{beta:0,gamma:0}));
    expect(scene.setPose).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
  });
});
