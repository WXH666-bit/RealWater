import * as THREE from 'three';
import { clamp, MAX_TILT, TANK, WALL, type Mode } from './config';
import type { WaterScene } from './scene';
import { movementForView, tiltForView } from './view-controls';

type PermissionEvent = { requestPermission?: () => Promise<string> };
export class WaterInput {
  mode: Mode | 'auto' | 'orbit' = 'auto';
  motionEnabled = false;
  onMotionChange?: () => void;
  onModeChange?: () => void;
  private pointers=new Map<number,{x:number;y:number}>();
  private start:{x:number;y:number;tx:number;tz:number;rx:number;rz:number;time:number;touch:boolean;moved:boolean;pouring:boolean;point:THREE.Vector3|null;shift:boolean;orbit:boolean;view:THREE.Quaternion}|null=null;
  private dual:{x:number;y:number;distance:number;camera:THREE.Vector3;rx:number;rz:number;tx:number;tz:number;kind:'tilt'|'pinch'|null}|null=null;
  private pourTimer=0;
  private lastTap={time:-Infinity,x:0,y:0};
  private raycaster=new THREE.Raycaster();
  private tankBounds=new THREE.Box3(TANK.clone().addScalar(2*WALL).negate(),TANK.clone().add(new THREE.Vector3(2*WALL,0,2*WALL)));
  private plane=new THREE.Plane();
  private target=new THREE.Vector3();
  private lastSensor=0;
  private sensorOrigin:{beta:number;gamma:number}|null=null;
  private sensorTimer=0;
  private calibrationPending=false;
  private motionRequest=0;
  private motionPending=false;
  private abort=new AbortController();
  constructor(private scene:WaterScene,private notify:(message:string)=>void){
    const canvas=scene.canvas;const options={signal:this.abort.signal};
    scene.controls.touches.TWO=null as unknown as THREE.TOUCH;
    // Capture runs before OrbitControls: a blank-space drag orbits, while a
    // tank drag is reserved for physics. The decision stays fixed until release.
    canvas.addEventListener('pointerdown',this.prepare,{...options,capture:true});
    canvas.addEventListener('pointerdown',this.down,options);
    canvas.addEventListener('pointermove',this.move,options);
    canvas.addEventListener('pointerup',this.up,options);
    canvas.addEventListener('pointercancel',this.cancel,options);
    canvas.addEventListener('lostpointercapture',this.cancel,options);
    canvas.addEventListener('contextmenu',e=>e.preventDefault(),options);
    canvas.addEventListener('keydown',this.key,options);
    window.addEventListener('blur',this.cancel,options);
    document.addEventListener('visibilitychange',this.cancel,options);
  }
  setMode(mode:Mode|'auto'|'orbit'){
    this.mode=mode;this.cancel();this.scene.canvas.dataset.mode=mode;
    this.scene.controls.touches.TWO=mode==='orbit'?THREE.TOUCH.DOLLY_ROTATE:null as unknown as THREE.TOUCH;
    this.onModeChange?.();
  }
  private screenRay(x:number,y:number){
    const rect=this.scene.canvas.getBoundingClientRect();
    const pointer=new THREE.Vector2((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1);
    this.raycaster.setFromCamera(pointer,this.scene.camera);
    return this.raycaster.ray;
  }
  private hitsTank(x:number,y:number){
    const ray=this.screenRay(x,y).clone();
    const inverse=new THREE.Matrix4().compose(this.scene.position,this.scene.quaternion,new THREE.Vector3(1,1,1)).invert();
    return ray.applyMatrix4(inverse).intersectsBox(this.tankBounds);
  }
  private prepare=(e:PointerEvent)=>{
    if(e.button!==0||this.pointers.size)return;
    const orbit=this.mode==='orbit'||(this.mode==='auto'&&!e.shiftKey&&!this.hitsTank(e.clientX,e.clientY));
    this.scene.controls.mouseButtons.LEFT=orbit?THREE.MOUSE.ROTATE:null as unknown as THREE.MOUSE;
    this.scene.controls.touches.ONE=orbit?THREE.TOUCH.ROTATE:null as unknown as THREE.TOUCH;
  };
  private waterPoint(x:number,y:number){
    this.screenRay(x,y);
    const opening=new THREE.Vector3(0,TANK.y,0).applyQuaternion(this.scene.quaternion).add(this.scene.position);
    this.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0,1,0).applyQuaternion(this.scene.quaternion),opening);
    const hit=this.raycaster.ray.intersectPlane(this.plane,this.target);
    if(!hit)return null;
    const local=hit.clone().sub(this.scene.position).applyQuaternion(this.scene.quaternion.clone().invert());
    if(Math.abs(local.x)>TANK.x||Math.abs(local.z)>TANK.z)return null;
    return hit.clone().add(new THREE.Vector3(0,.5+this.scene.dropRadius,0));
  }
  private down=(e:PointerEvent)=>{
    if(e.button!==0)return;
    this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    this.scene.canvas.setPointerCapture(e.pointerId);
    window.clearTimeout(this.pourTimer);
    if(this.pointers.size===2){
      if(this.mode==='orbit'){this.start=null;return;}
      this.start=null;this.scene.stopPour();this.disableMotion();
      const [a,b]=[...this.pointers.values()];
      this.dual={x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.hypot(a.x-b.x,a.y-b.y),camera:this.scene.camera.position.clone().sub(this.scene.controls.target),rx:this.scene.targetEuler.x,rz:this.scene.targetEuler.z,tx:this.scene.targetPosition.x,tz:this.scene.targetPosition.z,kind:null};return;
    }
    if(this.pointers.size>2){this.start=null;this.dual=null;this.scene.stopPour();return;}
    const orbit=this.mode==='orbit'||(this.mode==='auto'&&!e.shiftKey&&!this.hitsTank(e.clientX,e.clientY));
    if(this.scene.paused&&!orbit)return;
    const point=(this.mode==='auto'||this.mode==='drop')&&!e.shiftKey?this.waterPoint(e.clientX,e.clientY):null;
    this.start={x:e.clientX,y:e.clientY,tx:this.scene.targetPosition.x,tz:this.scene.targetPosition.z,rx:this.scene.targetEuler.x,rz:this.scene.targetEuler.z,time:performance.now(),touch:e.pointerType==='touch',moved:false,pouring:false,point,shift:e.shiftKey,orbit,view:this.scene.camera.quaternion.clone()};
    if(point){
      const start=this.start;
      this.pourTimer=window.setTimeout(()=>{if(this.start===start&&!start.moved){this.scene.startPour(point);start.pouring=true;}},300);
    }
  };
  private move=(e:PointerEvent)=>{
    if(!this.pointers.has(e.pointerId))return;
    this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.dual&&this.pointers.size===2){
      const [a,b]=[...this.pointers.values()],d=this.dual;
      const distance=Math.max(5,Math.hypot(a.x-b.x,a.y-b.y));
      const x=(a.x+b.x)/2,y=(a.y+b.y)/2;
      if(!d.kind){if(Math.abs(distance-d.distance)>10)d.kind='pinch';else if(Math.hypot(x-d.x,y-d.y)>5)d.kind='tilt';}
      if(d.kind==='pinch'){
        const length=clamp(d.camera.length()*d.distance/distance,this.scene.controls.minDistance,this.scene.controls.maxDistance);
        this.scene.camera.position.copy(d.camera).setLength(length).add(this.scene.controls.target);this.scene.controls.update();
      }else if(d.kind==='tilt'&&!this.scene.paused){
        const rect=this.scene.canvas.getBoundingClientRect();
        const tilt=tiltForView(this.scene.camera.quaternion,(x-d.x)/rect.width*3.7,(y-d.y)/rect.height*3.7);
        this.scene.setPose(d.tx,d.tz,d.rx+tilt.x,d.rz+tilt.z);
      }return;
    }
    if(!this.start||this.pointers.size!==1||!this.pointers.has(e.pointerId)||(this.scene.paused&&!this.start.orbit))return;
    if(Math.hypot(e.clientX-this.start.x,e.clientY-this.start.y)>5){
      this.start.moved=true;window.clearTimeout(this.pourTimer);
      if(this.mode!=='drop'){this.scene.stopPour();if((this.motionEnabled||this.motionPending)&&!this.start.orbit)this.disableMotion();}
    }
    if(!this.start.moved)return;
    if(this.start.orbit)return;
    const rect=this.scene.canvas.getBoundingClientRect();
    const dx=(e.clientX-this.start.x)/rect.width,dy=(e.clientY-this.start.y)/rect.height;
    const tilt=this.mode==='tilt'||this.start.shift||e.shiftKey;
    if(this.mode!=='drop'&&!tilt){
      const movement=movementForView(this.start.view,dx*4,dy*3);
      this.scene.setPose(this.start.tx+movement.x,this.start.tz+movement.z);
    }else if(tilt){
      const rotation=tiltForView(this.start.view,dx*3.7,dy*3.7);
      this.scene.setPose(this.start.tx,this.start.tz,this.start.rx+rotation.x,this.start.rz+rotation.z);
    }
    else{const point=this.waterPoint(e.clientX,e.clientY);if(point){if(!this.start.pouring){this.scene.startPour(point);this.start.pouring=true;}else this.scene.updatePour(point);}else{this.scene.stopPour();this.start.pouring=false;}}
  };
  private up=(e:PointerEvent)=>{
    const start=this.start;
    window.clearTimeout(this.pourTimer);
    if(start&&!start.moved&&!this.dual&&!this.scene.paused){
      if(start.point&&!start.pouring)this.scene.emitWater(start.point);
      else if(!start.point&&!this.hitsTank(start.x,start.y)&&!this.hitsTank(e.clientX,e.clientY)){
        const now=performance.now();
        if(start.touch&&now-start.time>700)void this.toggleMotion();
        else if(now-this.lastTap.time<320&&Math.hypot(e.clientX-this.lastTap.x,e.clientY-this.lastTap.y)<22){this.disableMotion();this.scene.reset();this.lastTap.time=-Infinity;}
        else this.lastTap={time:now,x:e.clientX,y:e.clientY};
      }
    }
    this.pointers.delete(e.pointerId);this.start=null;this.dual=null;this.scene.stopPour();
  };
  private cancel=()=>{window.clearTimeout(this.pourTimer);this.start=null;this.dual=null;this.pointers.clear();this.scene.stopPour();};
  private key=(e:KeyboardEvent)=>{
    const p=this.scene.targetPosition,r=this.scene.targetEuler;
    if(e.code==='Space'){e.preventDefault();this.scene.setPaused(!this.scene.paused);return;}
    if(e.key.toLowerCase()==='r'){this.cancel();this.disableMotion();this.scene.reset();return;}
    if(e.key==='Enter'){this.scene.emitWater();return;}
    const x=e.key==='ArrowLeft'?-.15:e.key==='ArrowRight'?.15:0;
    const y=e.key==='ArrowUp'?-.15:e.key==='ArrowDown'?.15:0;
    if(!x&&!y)return;e.preventDefault();
    if(this.mode==='tilt'){
      const rotation=tiltForView(this.scene.camera.quaternion,x,y);
      this.scene.setPose(p.x,p.z,r.x+rotation.x,r.z+rotation.z);
    }else{
      const movement=movementForView(this.scene.camera.quaternion,x,y);
      this.scene.setPose(p.x+movement.x,p.z+movement.z);
    }
  };
  async toggleMotion(){
    if(this.abort.signal.aborted)return;
    if(this.motionEnabled||this.motionPending){this.disableMotion();return;}
    if(!window.isSecureContext){this.notify('手机体感需要 HTTPS 安全连接。当前仍可使用触屏操作，配置步骤见 README。');return;}
    if(!('DeviceOrientationEvent' in window)){this.notify('此设备没有可用的方向传感器，请使用触屏操作。');return;}
    const request=++this.motionRequest;
    this.motionPending=true;
    try{
      const orientation=DeviceOrientationEvent as unknown as PermissionEvent;
      const motion=typeof DeviceMotionEvent==='undefined'?undefined:DeviceMotionEvent as unknown as PermissionEvent;
      // Both requests are initiated in the original user activation before awaiting.
      const results=await Promise.all([orientation.requestPermission?.()??Promise.resolve('granted'),motion?.requestPermission?.()??Promise.resolve('granted')]);
      if(request!==this.motionRequest||this.abort.signal.aborted)return;
      if(results.some(v=>v!=='granted')){this.notify('未获得体感权限，触屏操作不受影响。');return;}
      this.motionEnabled=true;this.calibrationPending=true;this.sensorOrigin=null;this.lastSensor=0;
      window.addEventListener('deviceorientation',this.orientation);
      window.addEventListener('devicemotion',this.motion);
      this.sensorTimer=window.setTimeout(()=>{if(!this.lastSensor){this.disableMotion();this.notify('没有收到传感器数据，请使用触屏操作。');}},3500);
      this.notify('体感已开启。保持当前姿势作为正立方向，再轻轻倾斜手机。');this.onMotionChange?.();
    }catch{
      if(request!==this.motionRequest||this.abort.signal.aborted)return;
      this.disableMotion();this.notify('无法开启体感，仍可使用触屏操作。');
    }finally{if(request===this.motionRequest)this.motionPending=false;}
  }
  private orientation=(event:DeviceOrientationEvent)=>{
    if(document.hidden||event.beta===null||event.gamma===null||!Number.isFinite(event.beta+event.gamma))return;
    this.lastSensor=performance.now();
    if(this.calibrationPending||!this.sensorOrigin){this.sensorOrigin={beta:event.beta,gamma:event.gamma};this.calibrationPending=false;}
    const angle=(screen.orientation?.angle??0)*Math.PI/180;
    const bx=(event.beta-this.sensorOrigin.beta)*Math.PI/180,gz=(event.gamma-this.sensorOrigin.gamma)*Math.PI/180;
    const x=bx*Math.cos(angle)+gz*Math.sin(angle),z=gz*Math.cos(angle)-bx*Math.sin(angle);
    const tilt=tiltForView(this.scene.camera.quaternion,z,x);
    this.scene.setPose(this.scene.targetPosition.x,this.scene.targetPosition.z,clamp(tilt.x,-MAX_TILT,MAX_TILT),clamp(tilt.z,-MAX_TILT,MAX_TILT));
  };
  private motion=(event:DeviceMotionEvent)=>{
    if(document.hidden||!this.motionEnabled)return;
    const a=event.acceleration;if(!a||a.x===null||a.y===null||!Number.isFinite(a.x+a.y))return;
    // Acceleration drives a bounded container displacement, never a second gravity force on the water.
    const angle=(screen.orientation?.angle??0)*Math.PI/180;
    const x=a.x*Math.cos(angle)+a.y*Math.sin(angle),z=a.y*Math.cos(angle)-a.x*Math.sin(angle);
    const p=this.scene.targetPosition;
    const movement=movementForView(this.scene.camera.quaternion,clamp(-x*.018,-.12,.12),clamp(z*.012,-.08,.08));
    this.scene.setPose(p.x*.9+movement.x,p.z*.9+movement.z);
  };
  disableMotion(){
    this.motionRequest++;this.motionPending=false;
    this.motionEnabled=false;window.clearTimeout(this.sensorTimer);
    window.removeEventListener('deviceorientation',this.orientation);window.removeEventListener('devicemotion',this.motion);this.onMotionChange?.();
  }
  dispose(){this.cancel();this.abort.abort();this.disableMotion();}
}
