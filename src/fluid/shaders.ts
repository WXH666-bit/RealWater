// MAC texture-atlas sampling and PIC/FLIP transfers adapted from David Li's
// fluid (MIT), ac3ee551ee33caaf4c0aa38da21e2be5562fd5ab. See THIRD_PARTY_NOTICES.md.
import { tankGeometry } from './tank-geometry';
export const fullscreenVertex = `
precision highp float;
in vec3 position;
void main(){gl_Position=vec4(position,1.0);}
`;

export const common = `
precision highp float;
precision highp int;
uniform vec3 uGrid;
uniform vec3 uOrigin;
uniform float uCell;
uniform float uDt;
uniform float uRadius;
uniform float uGravity;
uniform float uRestDensity;
uniform vec3 uCenter;
uniform vec3 uPreviousCenter;
uniform mat3 uRotation;
uniform mat3 uInverse;
uniform mat3 uPreviousInverse;
uniform vec3 uLinear;
uniform vec3 uAngular;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uGridVelocity;
uniform sampler2D uOriginalVelocity;
uniform sampler2D uWeights;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform sampler2D uSeeds;
uniform sampler2D uBoundary;
uniform sampler2D uAffineX;
uniform sampler2D uAffineY;
uniform sampler2D uAffineZ;
uniform vec2 uParticleSize;
${tankGeometry}
#ifndef VERTEX_STAGE
ivec3 coord(){return ivec3(int(gl_FragCoord.x)%int(uGrid.x),int(gl_FragCoord.y),int(gl_FragCoord.x)/int(uGrid.x));}
#endif
ivec2 atlas(ivec3 p){p=clamp(p,ivec3(0),ivec3(uGrid)-1);return ivec2(p.x+p.z*int(uGrid.x),p.y);}
vec4 at(sampler2D t,ivec3 p){return texelFetch(t,atlas(p),0);}
vec3 world(ivec3 p){return uOrigin+(vec3(p)+0.5)*uCell;}
vec4 sampleGrid(sampler2D t,vec3 p){
  p=clamp(p,vec3(0.0),uGrid-1.001);
  vec3 b=floor(p),f=fract(p);
  vec2 size=vec2(uGrid.x*uGrid.z,uGrid.y);
  vec2 a=vec2(b.z*uGrid.x+p.x+0.5,p.y+0.5)/size;
  vec2 c=vec2(min(b.z+1.,uGrid.z-1.)*uGrid.x+p.x+0.5,p.y+0.5)/size;
  return mix(texture(t,a),texture(t,c),f.z);
}
vec3 sampleVelocity(sampler2D t,vec3 p){
  vec3 g=(p-uOrigin)/uCell;
  return vec3(sampleGrid(t,g-vec3(0,.5,.5)).x,sampleGrid(t,g-vec3(.5,0,.5)).y,sampleGrid(t,g-vec3(.5,.5,0)).z);
}
bool fluid(ivec3 q){float volume=at(uBoundary,q).a;return volume>.01&&at(uWeights,q).a>.5*max(volume,.1);}
vec3 wallVelocity(vec3 p){return uLinear+cross(uAngular,p-uCenter);}
float face(sampler2D tex,ivec3 q,int axis){
  vec3 p=world(q);p[axis]-=.5*uCell;
  float open=at(uBoundary,q)[axis];
  return mix(wallVelocity(p)[axis],at(tex,q)[axis],open);
}
bool inDomain(vec3 p){vec3 q=(p-uOrigin)/uCell;return all(greaterThan(q,vec3(1)))&&all(lessThan(q,uGrid-2.));}
`;

// Face-area fractions use four triangles sharing a center sample; the center
// detects thin glass even when all four face corners lie outside it.
export const boundaryFragment=common+`
out vec4 result;
float triangleOpen(float a,float b,float c){
  if(a>=0.&&b>=0.&&c>=0.)return 1.;
  if(a<=0.&&b<=0.&&c<=0.)return 0.;
  if(a>=0.&&b<=0.&&c<=0.)return a*a/max((a-b)*(a-c),1e-12);
  if(b>=0.&&a<=0.&&c<=0.)return b*b/max((b-a)*(b-c),1e-12);
  if(c>=0.&&a<=0.&&b<=0.)return c*c/max((c-a)*(c-b),1e-12);
  if(a<=0.)return 1.-a*a/max((a-b)*(a-c),1e-12);
  if(b<=0.)return 1.-b*b/max((b-a)*(b-c),1e-12);
  return 1.-c*c/max((c-a)*(c-b),1e-12);
}
float openFace(vec3 p,int axis){
  vec3 a=vec3(0),b=vec3(0);a[(axis+1)%3]=uCell*.5;b[(axis+2)%3]=uCell*.5;
  float center=tankSdf(p);
  if(center>uCell*.708)return 1.;
  if(center<-uCell*.708)return 0.;
  float v0=tankSdf(p-a-b),v1=tankSdf(p+a-b),v2=tankSdf(p+a+b),v3=tankSdf(p-a+b);
  float fraction=.25*(triangleOpen(center,v0,v1)+triangleOpen(center,v1,v2)+triangleOpen(center,v2,v3)+triangleOpen(center,v3,v0));
  return fraction<.01?0.:fraction>.99?1.:fraction;
}
void main(){
  vec3 p=world(coord());
  float distance=tankSdf(p);
  if(distance>uCell*1.367){result=vec4(1);return;}
  vec3 open=vec3(openFace(p-vec3(.5*uCell,0,0),0),openFace(p-vec3(0,.5*uCell,0),1),openFace(p-vec3(0,0,.5*uCell),2));
  // Estimate usable space for cell classification. The pressure rest-density
  // target is calibrated separately from the actual volume per marker.
  float volume=0.;
  for(int x=-1;x<=1;x+=2)for(int y=-1;y<=1;y+=2)for(int z=-1;z<=1;z+=2){
    float d=tankSdf(p+vec3(x,y,z)*uCell*.25);
    volume+=clamp(.5+d/(uCell*.5),0.,1.)*.125;
  }
  result=vec4(open,volume);
}
`;

export const splatVertex = `#define VERTEX_STAGE
` + common + `
uniform int uLayer;
out vec3 vGridPosition;
out vec3 vVelocity;
flat out vec3 vAffineX;
flat out vec3 vAffineY;
flat out vec3 vAffineZ;
flat out int vLayer;
void main(){
  ivec2 uv=ivec2(gl_VertexID%int(uParticleSize.x),gl_VertexID/int(uParticleSize.x));
  vec4 p=texelFetch(uPositions,uv,0);
  vGridPosition=(p.xyz-uOrigin)/uCell;
  vVelocity=texelFetch(uVelocities,uv,0).xyz;
  vAffineX=texelFetch(uAffineX,uv,0).xyz;
  vAffineY=texelFetch(uAffineY,uv,0).xyz;
  vAffineZ=texelFetch(uAffineZ,uv,0).xyz;
  vLayer=int(floor(vGridPosition.z))+uLayer;
  vec2 c=vec2(float(vLayer)*uGrid.x+floor(vGridPosition.x)+.5,floor(vGridPosition.y)+.5);
  gl_Position=vec4(c/vec2(uGrid.x*uGrid.z,uGrid.y)*2.-1.,0,1);
  gl_PointSize=3.;
  if(p.a<.5||!inDomain(p.xyz)||vLayer<0||float(vLayer)>=uGrid.z)gl_Position=vec4(3,3,3,1);
}
`;
export const splatFragment = common + `
in vec3 vGridPosition;
in vec3 vVelocity;
flat in vec3 vAffineX;
flat in vec3 vAffineY;
flat in vec3 vAffineZ;
flat in int vLayer;
layout(location=0)out vec4 weights;
layout(location=1)out vec4 momentum;
float kernel(vec3 p){vec3 w=max(1.-abs(p),0.);return w.x*w.y*w.z;}
void main(){
  ivec3 q=coord();if(q.z!=vLayer)discard;
  vec3 p=vec3(q);
  vec4 w=vec4(kernel(vGridPosition-p-vec3(0,.5,.5)),kernel(vGridPosition-p-vec3(.5,0,.5)),kernel(vGridPosition-p-vec3(.5,.5,0)),kernel(vGridPosition-p-.5));
  vec3 velocity=vVelocity+vec3(
    dot(vAffineX,(p+vec3(0,.5,.5)-vGridPosition)*uCell),
    dot(vAffineY,(p+vec3(.5,0,.5)-vGridPosition)*uCell),
    dot(vAffineZ,(p+vec3(.5,.5,0)-vGridPosition)*uCell));
  weights=w;momentum=vec4(w.xyz*velocity,0);
}
`;
export const normalizeFragment = common + `
uniform sampler2D uMomentum;
out vec4 result;
void main(){
  ivec3 q=coord();vec3 w=at(uWeights,q).xyz;vec3 m=at(uMomentum,q).xyz;
  int valid=(w.x>1e-5?1:0)+(w.y>1e-5?2:0)+(w.z>1e-5?4:0);
  result=vec4(m/max(w,vec3(1e-6)),float(valid));
}
`;
// Extend each staggered component into a narrow air band before FLIP differencing
// and again after projection. Zero-valued air otherwise acts like numerical drag.
export const extrapolateFragment = common + `
out vec4 result;
void main(){
  ivec3 q=coord();vec4 source=at(uGridVelocity,q);vec3 v=source.xyz;
  int valid=int(source.a+.5),next=valid;
  for(int component=0;component<3;component++){
    int bit=1<<component;if((valid&bit)!=0)continue;
    float sum=0.,count=0.;
    for(int axis=0;axis<3;axis++)for(int sign=-1;sign<=1;sign+=2){
      ivec3 off=ivec3(0);off[axis]=sign;vec4 neighbor=at(uGridVelocity,q+off);
      if((int(neighbor.a+.5)&bit)!=0){sum+=neighbor[component];count+=1.;}
    }
    if(count>0.){v[component]=sum/count;next|=bit;}
  }
  result=vec4(v,float(next));
}
`;
export const forceFragment = common + `
out vec4 result;
float density(ivec3 q){return min(at(uWeights,q).a/uRestDensity,1.);}
void main(){
  ivec3 q=coord();vec3 v=at(uOriginalVelocity,q).xyz;
  v.y-=uGravity*uDt;
  // Weak grid-scale cohesion at the liquid/air interface; not molecular capillarity.
  vec3 grad=vec3(density(q+ivec3(1,0,0))-density(q-ivec3(1,0,0)),density(q+ivec3(0,1,0))-density(q-ivec3(0,1,0)),density(q+ivec3(0,0,1))-density(q-ivec3(0,0,1)));
  float d=density(q);
  if(d>.015&&d<.95)v+=grad*.025*uDt/uCell;
  result=vec4(v,at(uOriginalVelocity,q).a);
}
`;
export const divergenceFragment = common + `
out vec4 result;
void main(){
  ivec3 q=coord();if(!fluid(q)){result=vec4(0);return;}
  float div=face(uGridVelocity,q+ivec3(1,0,0),0)-face(uGridVelocity,q,0)+face(uGridVelocity,q+ivec3(0,1,0),1)-face(uGridVelocity,q,1)+face(uGridVelocity,q+ivec3(0,0,1),2)-face(uGridVelocity,q,2);
  // Correct bulk crowding using the same marker volume as initialization and
  // emission. Partial wall volume is not a particle-kernel mass fraction.
  div-=max(at(uWeights,q).a-uRestDensity,0.)*.25;
  result=vec4(div,0,0,1);
}
`;
export const pressureFragment = common + `
out vec4 result;
void main(){
  ivec3 q=coord();if(!fluid(q)){result=vec4(0);return;}
  float sum=0.,n=0.;
  for(int axis=0;axis<3;axis++)for(int sign=-1;sign<=1;sign+=2){
    ivec3 offset=ivec3(0);offset[axis]=sign;ivec3 p=q+offset;
    float open=at(uBoundary,sign>0?p:q)[axis];
    sum+=open*at(uPressure,p).r;n+=open;
  }
  result=vec4(n>1e-4?(sum-at(uDivergence,q).r)/n:0.,0,0,1);
}
`;
export const projectFragment = common + `
out vec4 result;
void main(){
  ivec3 q=coord();vec3 v=at(uGridVelocity,q).xyz;int valid=0;
  for(int axis=0;axis<3;axis++){
    ivec3 off=ivec3(0);off[axis]=1;
    float open=at(uBoundary,q)[axis];
    if(open<=0.){
      vec3 p=world(q);p[axis]-=.5*uCell;v[axis]=wallVelocity(p)[axis];
    }else if(fluid(q)||fluid(q-off))v[axis]-=at(uPressure,q).r-at(uPressure,q-off).r;
    // Blocked faces are excluded from pressure flux, but extrapolated for
    // particle advection: a zero velocity inside glass would erase tangents.
    // Air faces containing marker-kernel tails are not pressure-projected.
    // Marking them valid would blend free-fall air into the water surface;
    // extend the projected liquid velocity into that band instead.
    if(open>0.&&(fluid(q)||fluid(q-off)))valid|=1<<axis;
  }
  result=vec4(v,float(valid));
}
`;

// APIC with multilinear weights: B D^-1 equals the gradient of the
// component's trilinear interpolant. Evaluate that gradient directly so a
// marker exactly on a face does not require inversion of a singular D.
export const affineFragment=common+`
uniform bool uInjectOnly;
layout(location=0)out vec4 affineX;
layout(location=1)out vec4 affineY;
layout(location=2)out vec4 affineZ;
vec3 componentGradient(vec3 p,int axis){
  vec3 offset=vec3(.5);offset[axis]=0.;
  vec3 g=(p-uOrigin)/uCell-offset;
  ivec3 base=ivec3(floor(g));vec3 f=fract(g),gradient=vec3(0);
  for(int x=0;x<2;x++)for(int y=0;y<2;y++)for(int z=0;z<2;z++){
    vec3 side=vec3(x,y,z),w=mix(1.-f,f,side),sign=side*2.-1.;
    float value=at(uGridVelocity,base+ivec3(x,y,z))[axis];
    gradient+=value*vec3(sign.x*w.y*w.z,sign.y*w.x*w.z,sign.z*w.x*w.y);
  }
  gradient/=uCell;
  // Match the existing velocity safety cap over one grid cell.
  return gradient/max(1.,length(gradient)*uCell/16.);
}
void main(){
  ivec2 uv=ivec2(gl_FragCoord.xy);vec4 p=texelFetch(uPositions,uv,0);
  if(p.a<.5||texelFetch(uSeeds,uv,0).a>.5||!inDomain(p.xyz)){
    affineX=vec4(0);affineY=vec4(0);affineZ=vec4(0);return;
  }
  if(uInjectOnly){affineX=texelFetch(uAffineX,uv,0);affineY=texelFetch(uAffineY,uv,0);affineZ=texelFetch(uAffineZ,uv,0);return;}
  affineX=vec4(componentGradient(p.xyz,0),0);
  affineY=vec4(componentGradient(p.xyz,1),0);
  affineZ=vec4(componentGradient(p.xyz,2),0);
}
`;

export const boxCollision = `
void collideBox(inout vec3 q,inout vec3 v,vec3 oldQ,vec3 center,vec3 halfSize){
  vec3 b=halfSize+vec3(uRadius*.42);vec3 p=q-center;
  vec3 old=oldQ-center,delta=p-old;
  vec3 normal=vec3(0);bool hit=false;
  // Use the entry face whenever the trajectory starts outside. An endpoint
  // inside the far half of the glass must not be pushed through its far face.
  if(all(lessThan(abs(old),b))){
    if(any(greaterThanEqual(abs(p),b)))return;
    vec3 depth=b-abs(p);int axis=0;if(depth.y<depth.x)axis=1;if(depth.z<depth[axis])axis=2;
    normal[axis]=p[axis]>=0.?1.:-1.;p[axis]=normal[axis]*(b[axis]+.0002);hit=true;
  }else{
    float entry=0.,leave=1.;int hitAxis=-1;float hitSign=1.;
    for(int axis=0;axis<3;axis++){
      if(abs(delta[axis])<1e-7){if(abs(old[axis])>b[axis])return;}
      else{
        float a=(-b[axis]-old[axis])/delta[axis],z=(b[axis]-old[axis])/delta[axis];
        float lo=min(a,z),hi=max(a,z);
        if(lo>=entry){entry=lo;hitAxis=axis;hitSign=delta[axis]>0.?-1.:1.;}
        leave=min(leave,hi);
      }
    }
    if(hitAxis>=0&&entry<=leave&&entry>=0.&&entry<=1.){
      normal[hitAxis]=hitSign;
      vec3 point=old+entry*delta;vec3 remainder=(1.-entry)*delta;
      p=point+normal*.0003+remainder-normal*min(dot(remainder,normal),0.);hit=true;
    }
  }
  // Free-slip glass: remove incoming normal velocity without damping the tangent.
  if(hit){q=p+center;float vn=dot(v,normal);if(vn<0.)v-=normal*vn*1.01;}
}
`;
// Face-flux reconstruction with limited transverse slopes and a quadratic
// correction. It reproduces affine flow while keeping each cell's projected
// divergence. General transverse components can still jump at cell faces.
export const transportSampling=`
vec3 transportSlope(ivec3 q,int component){
  vec3 slope=vec3(0);
  if(at(uBoundary,q)[component]<=0.)return slope;
  float center=face(uGridVelocity,q,component);
  for(int axis=0;axis<3;axis++)if(axis!=component){
    ivec3 off=ivec3(0);off[axis]=1;
    float left=center-face(uGridVelocity,q-off,component),right=face(uGridVelocity,q+off,component)-center;
    if(left*right>0.)slope[axis]=sign(left)*min(abs((left+right)*.5),2.*min(abs(left),abs(right)));
  }
  return slope;
}
vec3 transportVelocity(vec3 p){
  vec3 g=(p-uOrigin)/uCell,f=fract(g);ivec3 q=ivec3(floor(g));vec3 v;
  vec3 divergenceSlope=vec3(0);
  for(int axis=0;axis<3;axis++){
    ivec3 off=ivec3(0);off[axis]=1;
    vec3 left=transportSlope(q,axis),right=transportSlope(q+off,axis);
    v[axis]=mix(face(uGridVelocity,q,axis)+dot(left,f-.5),face(uGridVelocity,q+off,axis)+dot(right,f-.5),f[axis]);
    divergenceSlope+=right-left;
  }
  // Zero at both normal faces; its derivative cancels the transverse slope
  // contribution to divergence without changing any cell's net face flux.
  v-=.5*divergenceSlope*(f*f-f);
  return v;
}
`;
export const particleFragment = common + boxCollision + transportSampling + `
layout(location=0)out vec4 outPosition;
layout(location=1)out vec4 outVelocity;
uniform mat4 uViewProjection;
uniform bool uInjectOnly;
uniform float uEmissionVelocity;
void main(){
  ivec2 uv=ivec2(gl_FragCoord.xy);
  vec4 seed=texelFetch(uSeeds,uv,0);
  vec4 p=texelFetch(uPositions,uv,0);vec3 v=texelFetch(uVelocities,uv,0).xyz;
  if(seed.a>.5){outPosition=seed;outVelocity=vec4(0,uEmissionVelocity,0,1);return;}
  if(p.a<.5||uInjectOnly){outPosition=p;outVelocity=vec4(v,p.a);return;}
  vec3 advectV;
  if(inDomain(p.xyz)){
    vec3 pic=sampleVelocity(uGridVelocity,p.xyz);
    // APIC preserves local velocity gradients in the affine state instead of
    // retaining unresolved FLIP noise in the marker's translational velocity.
    v=pic;
    // Transport markers with the pressure-projected grid velocity.
    // CFL-limited RK2 substeps preserve the full distance travelled. Clipping
    // displacement instead of substepping makes falling water look viscous.
    float transportSpeed=max(length(pic),length(transportVelocity(p.xyz)));
    int substeps=clamp(int(ceil(transportSpeed*uDt/(uCell*.7))),1,4);
    float subDt=uDt/float(substeps);vec3 trajectory=p.xyz;
    for(int i=0;i<4;i++){
      if(i>=substeps)break;
      vec3 startV=transportVelocity(trajectory);
      vec3 midpoint=trajectory+startV*subDt*.5;
      trajectory+=transportVelocity(midpoint)*subDt;
    }
    advectV=(trajectory-p.xyz)/uDt;
  }else{v.y-=uGravity*uDt;advectV=v;}
  float speed=length(v);if(speed>16.)v*=16./speed;
  vec3 newP=p.xyz+advectV*uDt;
  vec3 oldQ=uPreviousInverse*(p.xyz-uPreviousCenter);
  vec3 q=uInverse*(newP-uCenter);
  vec3 wallV=wallVelocity(newP);
  vec3 localV=uInverse*(v-wallV);
  collideBox(q,localV,oldQ,vec3(0,-tank.y-wall,0),vec3(tank.x+2.*wall,wall,tank.z+2.*wall));
  collideBox(q,localV,oldQ,vec3(tank.x+wall,0,0),vec3(wall,tank.y,tank.z+2.*wall));
  collideBox(q,localV,oldQ,vec3(-tank.x-wall,0,0),vec3(wall,tank.y,tank.z+2.*wall));
  collideBox(q,localV,oldQ,vec3(0,0,tank.z+wall),vec3(tank.x,tank.y,wall));
  collideBox(q,localV,oldQ,vec3(0,0,-tank.z-wall),vec3(tank.x,tank.y,wall));
  newP=uRotation*q+uCenter;v=uRotation*localV+wallV;
  vec4 clip=uViewProjection*vec4(newP,1);vec3 screen=clip.xyz/max(clip.w,.001);
  bool outOfView=clip.w<=0.||abs(screen.x)>1.15||abs(screen.y)>1.15;
  // Never recycle water still within reach of the tilted tank, even when the camera is zoomed in.
  float alive=((outOfView&&newP.y<-2.2)||length(newP)>15.)?0.:1.;
  if(any(isnan(newP))||any(isnan(v))||any(isinf(newP))||any(isinf(v))){outPosition=vec4(0,0,0,-1);outVelocity=vec4(0,0,0,-1);return;}
  outPosition=vec4(newP,alive);outVelocity=vec4(v,alive);
}
`;

export const copyFragment = `precision highp float;uniform sampler2D uSource;out vec4 result;void main(){result=texelFetch(uSource,ivec2(gl_FragCoord.xy),0);}`;
