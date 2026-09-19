import * as THREE from 'three';
import {FIXED_DT} from './config';
import type {FluidSolver} from './fluid/solver';
import {common,fullscreenVertex} from './fluid/shaders';

export const FISH_LIMIT=12;
export const FISH_KINDS=['clown','blue','yellow'] as const;
export type FishKind=typeof FISH_KINDS[number];
export const FISH_NAMES:Record<FishKind,string>={clown:'橙白条纹鱼',blue:'蓝色扁身鱼',yellow:'黄色细身鱼'};
export type AddFishResult='added'|'capacity'|'dry'|'unavailable';

export const fishUpdateFragment=common+`
uniform sampler2D uFishPosition,uFishVelocity,uFishHeading;
uniform int uFishAction,uFishSlot,uFishKind;
uniform bool uFishBootstrap;
uniform float uFishTime;
layout(location=0)out vec4 position;
layout(location=1)out vec4 velocity;
layout(location=2)out vec4 heading;
float hash(float n){return fract(sin(n*127.1+311.7)*43758.5453);}
vec3 fishCandidate(int i,int id){
  // Eighteen separated columns in the initial half tank make restoring a full
  // population reliable; the remaining probes cover tilted/irregular water.
  if(i<36){
    int k=(i+id*13)%36;
    return vec3((float(k%6)/5.*2.-1.)*(tank.x-.24),-tank.y*.5+(k<18?-.06:.06),(float((k/6)%3)-1.)*(tank.z-.24));
  }
  float seed=float(i+id*71);
  return (vec3(hash(seed+1.),hash(seed+2.),hash(seed+3.))*2.-1.)*(tank-vec3(.23));
}
bool wetPoint(vec3 p){
  vec3 local=uInverse*(p-uCenter);
  if(any(greaterThan(abs(local),tank-vec3(.025))))return false;
  if(uFishBootstrap)return local.y<-.035;
  if(!inDomain(p))return false;
  return sampleGrid(uWeights,(p-uOrigin)/uCell-.5).a>uRestDensity*.25;
}
bool safeFish(vec3 p){
  // A sphere encloses the animated tail and every species, independent of heading.
  const float r=.205;
  if(any(greaterThan(abs(uInverse*(p-uCenter)),tank-vec3(r+.025))))return false;
  return wetPoint(p)&&wetPoint(p+vec3(r,0,0))&&wetPoint(p-vec3(r,0,0))
    &&wetPoint(p+vec3(0,r,0))&&wetPoint(p-vec3(0,r,0))
    &&wetPoint(p+vec3(0,0,r))&&wetPoint(p-vec3(0,0,r));
}
bool separated(vec3 p,int id){
  for(int j=0;j<${FISH_LIMIT};j++)if(j!=id){vec4 other=texelFetch(uFishPosition,ivec2(j,0),0);if(other.w>.5&&distance(other.xyz,p)<.34)return false;}
  return true;
}
void main(){
  int id=int(gl_FragCoord.x);ivec2 uv=ivec2(id,0);
  position=texelFetch(uFishPosition,uv,0);velocity=texelFetch(uFishVelocity,uv,0);heading=texelFetch(uFishHeading,uv,0);
  if(uFishAction==1){
    if(id!=uFishSlot)return;
    position=vec4(0);velocity=vec4(0);heading=vec4(1,0,0,0);
    for(int i=0;i<64;i++){
      float seed=float(i+id*71)+uFishTime*13.;
      vec3 local=fishCandidate(i,id);
      vec3 p=uRotation*local+uCenter;
      if(safeFish(p)&&separated(p,id)){
        position=vec4(p,float(uFishKind+1));
        float a=hash(seed+5.)*6.283185;
        heading=vec4(cos(a),0,sin(a),0);velocity=vec4(heading.xyz*.16,hash(seed+7.)*6.283185);return;
      }
    }
    return;
  }
  if(position.w<.5)return;
  float seed=float(id)*2.399;
  vec3 wander=vec3(cos(uFishTime*.43+seed),.15*sin(uFishTime*.67+seed),sin(uFishTime*.37+seed));
  vec3 avoid=vec3(0);
  for(int j=0;j<${FISH_LIMIT};j++)if(j!=id){
    vec4 other=texelFetch(uFishPosition,ivec2(j,0),0);vec3 delta=position.xyz-other.xyz;float d=length(delta);
    if(other.w>.5&&d<.45)avoid+=delta/max(d,.001)*(.45-d)*5.;
  }
  vec3 local=uInverse*(position.xyz-uCenter);
  vec3 toward=uRotation*(-local/ max(tank-vec3(.23),vec3(.1)));
  vec3 desired=normalize(heading.xyz+(.35*wander+avoid+.45*toward)*uDt*3.);
  vec3 flow=uFishBootstrap?vec3(0):sampleVelocity(uGridVelocity,position.xyz);
  flow*=min(1.,.6/max(length(flow),.001));
  vec3 v=desired*.18+flow*.18;
  vec3 next=position.xyz+v*uDt;
  if(!safeFish(next)){
    bool found=false;
    for(int i=0;i<12;i++){
      float a=float(i)*2.399+seed;
      vec3 direction=normalize(vec3(cos(a),sin(a*1.7),sin(a)));
      vec3 candidate=position.xyz+direction*.23*uDt;
      if(safeFish(candidate)){next=candidate;v=direction*.23;found=true;break;}
    }
    if(!found){
      next=position.xyz;v=vec3(0);
      // A moving rim can uncover a fish faster than its swimming speed. Rehome
      // it in the nearest safe candidate instead of leaving it suspended in air.
      if(!safeFish(next)){
        float best=1e20;
        for(int i=0;i<64;i++){
          vec3 candidate=uRotation*fishCandidate(i,id)+uCenter;
          float d=distance(candidate,position.xyz);
          if(d<best&&safeFish(candidate)&&separated(candidate,id)){best=d;next=candidate;}
        }
      }
    }
  }
  bool wet=safeFish(next);
  heading.w=wet?0.:heading.w+uDt;
  if(heading.w>=.5){position=vec4(0);velocity=vec4(0);return;}
  position.xyz=next;
  if(length(v)>.01){vec3 facing=normalize(v);facing.y=clamp(facing.y,-.18,.18);heading.xyz=normalize(mix(heading.xyz,normalize(facing),1.-exp(-4.*uDt)));}
  velocity=vec4(v,mod(velocity.w+uDt*(7.+length(v)*8.),6.283185));
}
`;

/** Small independent GPU population; never modifies fluid momentum or water mass. */
export class AquariumSystem {
  private targets:THREE.WebGLRenderTarget[]=[];
  private current:THREE.WebGLRenderTarget;
  private next:THREE.WebGLRenderTarget;
  private material:THREE.RawShaderMaterial;
  private scene=new THREE.Scene();
  private camera=new THREE.Camera();
  private geometry=new THREE.BufferGeometry();
  private records:(FishKind|null)[]=Array(FISH_LIMIT).fill(null);
  private elapsed=0;
  private readTime=0;
  private disposed=false;
  constructor(private renderer:THREE.WebGLRenderer,private solver:FluidSolver){
    const target=()=>{const t=new THREE.WebGLRenderTarget(FISH_LIMIT,1,{count:3,type:THREE.FloatType,depthBuffer:false});this.targets.push(t);return t;};
    this.current=target();this.next=target();
    this.material=new THREE.RawShaderMaterial({vertexShader:fullscreenVertex,fragmentShader:fishUpdateFragment,glslVersion:THREE.GLSL3,depthTest:false,depthWrite:false,
      uniforms:{...solver.uniforms,uFishPosition:{value:null},uFishVelocity:{value:null},uFishHeading:{value:null},uFishAction:{value:0},uFishSlot:{value:0},uFishKind:{value:0},uFishTime:{value:0},uFishBootstrap:{value:true}}});
    this.geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    const quad=new THREE.Mesh(this.geometry,this.material);quad.frustumCulled=false;this.scene.add(quad);
    this.clear();
  }
  get count(){return this.records.filter(Boolean).length;}
  get textures(){return this.current.textures;}
  get time(){return this.elapsed;}
  private run(action:number,slot=0,kind=0){
    const r=this.renderer,previous=r.getRenderTarget(),auto=r.autoClear,u=this.material.uniforms;
    u.uFishPosition.value=this.current.textures[0];u.uFishVelocity.value=this.current.textures[1];u.uFishHeading.value=this.current.textures[2];
    u.uFishAction.value=action;u.uFishSlot.value=slot;u.uFishKind.value=kind;u.uFishTime.value=this.elapsed;u.uFishBootstrap.value=this.solver.revision===0;
    try{r.autoClear=false;r.setRenderTarget(this.next);r.render(this.scene,this.camera);[this.current,this.next]=[this.next,this.current];}
    finally{r.autoClear=auto;r.setRenderTarget(previous);}
  }
  inspect(){
    const data=new Float32Array(FISH_LIMIT*4);
    this.renderer.readRenderTargetPixels(this.current,0,0,FISH_LIMIT,1,data,0,0);
    this.records=Array.from({length:FISH_LIMIT},(_,i)=>FISH_KINDS[Math.round(data[i*4+3])-1]??null);
    return Array.from({length:FISH_LIMIT},(_,i)=>({kind:this.records[i],position:Array.from(data.subarray(i*4,i*4+3))})).filter(f=>f.kind);
  }
  snapshot():FishKind[]{if(!this.disposed)this.inspect();return this.records.filter((kind):kind is FishKind=>kind!==null);}
  /** CPU metadata remains usable after WebGL context loss. */
  savedKinds():FishKind[]{return this.records.filter((kind):kind is FishKind=>kind!==null);}
  add(kind:FishKind):AddFishResult{
    if(this.disposed||!FISH_KINDS.includes(kind))return 'unavailable';
    this.inspect();const slot=this.records.indexOf(null);if(slot<0)return 'capacity';
    this.run(1,slot,FISH_KINDS.indexOf(kind));this.inspect();return this.records[slot]?'added':'dry';
  }
  restore(kinds:readonly FishKind[]){let rejected=0;for(const kind of kinds)if(this.add(kind)!=='added')rejected++;return rejected;}
  step(){
    if(this.disposed||!this.count)return 0;
    this.elapsed+=FIXED_DT;this.run(0);this.readTime+=FIXED_DT;
    if(this.readTime<.25)return 0;
    this.readTime=0;const before=this.count;this.inspect();return before-this.count;
  }
  clear(){
    if(this.disposed)return;
    const r=this.renderer,previous=r.getRenderTarget(),color=r.getClearColor(new THREE.Color()),alpha=r.getClearAlpha();
    try{r.setClearColor(0,0);for(const t of this.targets){r.setRenderTarget(t);r.clear();}}
    finally{r.setClearColor(color,alpha);r.setRenderTarget(previous);}
    this.records.fill(null);this.elapsed=0;this.readTime=0;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.targets.forEach(t=>t.dispose());this.material.dispose();this.geometry.dispose();}
}
