import { SURFACE_MIN_WEIGHT, BULK_SUPPORT } from './surface-field';
import { backdropShader } from './backdrop';
import { tankGeometry } from './tank-geometry';
import { fishRayShader } from './fish-shaders';

// Continuous world-space reconstruction follows Zhu & Bridson 2005, §5.
// Particle splats below build an acceleration volume, never the visible surface.
export const fieldCommon=`
precision highp float;
precision highp int;
uniform vec3 uFieldGrid;
uniform vec3 uFieldOrigin;
uniform float uVoxel;
uniform float uColumns;
uniform vec2 uFieldSize;
uniform float uSupport;
uniform float uSurfaceRadius;
uniform float uDropRadius;
uniform sampler2D uField;
uniform sampler2D uFieldMetadata;
uniform sampler2D uMoments;
uniform sampler2D uSpread;
uniform vec3 uCenter;
uniform mat3 uInverse;
uniform mat3 uRotation;
uniform bool uClipToTank;
${tankGeometry}
ivec2 fieldAtlas(ivec3 q){q=clamp(q,ivec3(0),ivec3(uFieldGrid)-1);return ivec2((q.z%int(uColumns))*int(uFieldGrid.x)+q.x,(q.z/int(uColumns))*int(uFieldGrid.y)+q.y);}
ivec3 fieldCoord(vec2 pixel){ivec2 q=ivec2(pixel);return ivec3(q.x%int(uFieldGrid.x),q.y%int(uFieldGrid.y),(q.y/int(uFieldGrid.y))*int(uColumns)+q.x/int(uFieldGrid.x));}
vec3 voxelWorld(ivec3 q){return uFieldOrigin+(vec3(q)+.5)*uVoxel;}
vec4 sampleFieldTexture(sampler2D source,vec3 p){
  vec3 g=(p-uFieldOrigin)/uVoxel-.5;
  if(any(lessThan(g,vec3(0)))||any(greaterThan(g,uFieldGrid-1.001)))return vec4(0);
  vec3 b=floor(g),f=fract(g);
  vec2 a=(vec2(fieldAtlas(ivec3(b)))+f.xy+.5)/uFieldSize;
  vec2 c=(vec2(fieldAtlas(ivec3(b)+ivec3(0,0,1)))+f.xy+.5)/uFieldSize;
  return mix(textureLod(source,a,0.),textureLod(source,c,0.),f.z);
}
float fieldAt(vec3 p){
  vec3 g=(p-uFieldOrigin)/uVoxel-.5;
  if(any(lessThan(g,vec3(0)))||any(greaterThan(g,uFieldGrid-1.001)))return uSupport;
  float phi=sampleFieldTexture(uField,p).r;
  if(!uClipToTank)return phi;
  vec3 local=uInverse*(p-uCenter);
  if(all(lessThanEqual(abs(local.xz),tank.xz))&&local.y>=-tank.y&&local.y<=tank.y){
    float distance=min(min(tank.x-abs(local.x),tank.z-abs(local.z)),local.y+tank.y);
    return max(phi,-distance);
  }
  if(all(lessThan(abs(local),tank+vec3(2.*wall))))return max(phi,-tankSdf(p));
  return phi;
}
`;

export const momentVertex=fieldCommon+`
uniform sampler2D uPositions;
uniform sampler2D uParticleVelocities;
uniform vec2 uParticleSize;
uniform int uLayer;
uniform float uSplatSize;
flat out vec3 vParticle;
flat out float vSpeedSquared;
flat out int vLayer;
void main(){
  vec4 p=texelFetch(uPositions,ivec2(gl_VertexID%int(uParticleSize.x),gl_VertexID/int(uParticleSize.x)),0);
  vec3 g=(p.xyz-uFieldOrigin)/uVoxel-.5;
  vParticle=p.xyz;vLayer=int(floor(g.z))+uLayer;
  vec3 velocity=texelFetch(uParticleVelocities,ivec2(gl_VertexID%int(uParticleSize.x),gl_VertexID/int(uParticleSize.x)),0).xyz;
  vSpeedSquared=dot(velocity,velocity);
  ivec3 center=ivec3(ivec2(floor(g.xy)),vLayer);
  vec2 pixel=vec2(fieldAtlas(center))+.5;
  gl_Position=vec4(pixel/uFieldSize*2.-1.,0,1);gl_PointSize=uSplatSize;
  if(p.a<.5||vLayer<0||float(vLayer)>=uFieldGrid.z||any(lessThan(g.xy,vec2(0)))||any(greaterThan(g.xy,uFieldGrid.xy-1.)))gl_Position=vec4(3,3,3,1);
}
`;
export const momentFragment=fieldCommon+`
flat in vec3 vParticle;
flat in float vSpeedSquared;
flat in int vLayer;
layout(location=0)out vec4 result;
layout(location=1)out vec4 spread;
void main(){
  ivec3 q=fieldCoord(gl_FragCoord.xy);if(q.z!=vLayer)discard;
  vec3 delta=(vParticle-voxelWorld(q))/uSupport;
  float t=max(0.,1.-dot(delta,delta));if(t<=0.)discard;
  float w=t*t*t;
  // Relative moments retain precision in the additive half-float buffer.
  result=vec4(delta*w,w);
  spread=vec4(dot(delta,delta)*w,vSpeedSquared*w,0,0);
}
`;
export const fieldFragment=fieldCommon+`
out vec4 result;
void main(){
  vec4 moment=texelFetch(uMoments,ivec2(gl_FragCoord.xy),0);
  vec2 spread=texelFetch(uSpread,ivec2(gl_FragCoord.xy),0).rg;
  vec3 local=uInverse*(voxelWorld(fieldCoord(gl_FragCoord.xy))-uCenter);
  // Mirror the particle neighborhood into the solid, only when reconstructing
  // the tank interior. This fills missing support at glass instead of rounding
  // the entire water body into a detached gel. There is no lid reflection.
  // A small halo inside the glass keeps trilinear sampling at a corner from
  // blending supported liquid with an unsupported exterior voxel. The exact
  // wall SDF clips this halo, so it is never visible as water in the glass.
  float halo=min(uVoxel*1.5,wall);
  if(uClipToTank&&all(lessThanEqual(abs(local.xz),tank.xz+halo))&&local.y>=-tank.y-halo&&local.y<=tank.y){
    vec3 plane=vec3(local.x<0.?-tank.x:tank.x,-tank.y,local.z<0.?-tank.z:tank.z);
    bvec3 nearWall=lessThan(abs(local-plane),vec3(uSupport));
    for(int mask=1;mask<8;mask++){
      vec3 reflected=local;bool valid=true;
      for(int axis=0;axis<3;axis++)if((mask&(1<<axis))!=0){
        if(!nearWall[axis])valid=false;
        reflected[axis]=2.*plane[axis]-local[axis];
      }
      if(!valid)continue;
      vec3 worldPoint=uRotation*reflected+uCenter;
      vec4 ghost=sampleFieldTexture(uMoments,worldPoint);
      vec3 delta=uInverse*ghost.xyz;
      for(int axis=0;axis<3;axis++)if((mask&(1<<axis))!=0)delta[axis]=-delta[axis];
      moment+=vec4(uRotation*delta,ghost.a);
      spread+=sampleFieldTexture(uSpread,worldPoint).rg;
    }
  }
  // A wider neighborhood reconstructs the bulk wave instead of exposing each
  // particle's bump. Sparse spray keeps its own small radius, not a thick blob.
  float radius=mix(uDropRadius,uSurfaceRadius,smoothstep(2.,8.,moment.a));
  float phi=moment.a>1e-5?length(moment.xyz/moment.a)*uSupport-radius:uSupport;
  // A mean position can lie in an empty gap between droplets. The second
  // moment rejects that false bridge, while dense bulk water stays smooth.
  float rms=sqrt(max(spread.r/max(moment.a,1e-5),0.))*uSupport;
  float reach=mix(uDropRadius,uSupport,smoothstep(1.1,4.,moment.a));
  phi=max(phi,rms-reach);
  // Reject unsupported lobes between far-apart particles with tiny kernel tails.
  phi=max(phi,(${SURFACE_MIN_WEIGHT}-moment.a)*uDropRadius);
  // Dense particle support is liquid even when an asymmetric centroid alone
  // would invent an internal cavity. Sparse spray retains its original field.
  float bulkPhi=uSurfaceRadius*(1.-moment.a/${BULK_SUPPORT}.);
  phi=mix(phi,min(phi,bulkPhi),smoothstep(${BULK_SUPPORT-4}.,${BULK_SUPPORT}.,moment.a));
  // Carry the same mirrored support into filtering and normal reconstruction.
  // Otherwise a dense wetted wall is incorrectly classified as sparse spray.
  result=vec4(phi,moment.a,sqrt(max(spread.g/max(moment.a,1e-5),0.)),1);
}
`;
export const smoothFieldFragment=fieldCommon+`
uniform sampler2D uHistory;
uniform float uHistorySeconds;
uniform bool uHasHistory;
out vec4 result;
void main(){
  ivec3 q=fieldCoord(gl_FragCoord.xy);
  vec4 sampleValue=texelFetch(uField,fieldAtlas(q),0);
  float center=sampleValue.r;
  float dense=smoothstep(2.,10.,sampleValue.g);
  float sum=center*4.;
  for(int axis=0;axis<3;axis++)for(int sign=-1;sign<=1;sign+=2){
    ivec3 off=ivec3(0);off[axis]=sign;
    float nearValue=texelFetch(uField,fieldAtlas(q+off),0).r;
    float farValue=texelFetch(uField,fieldAtlas(q+off*2),0).r;
    sum+=mix(nearValue,farValue,dense);
  }
  // Spatial filtering of the current frame; moving water bypasses history below.
  // Dense water loses particle-scale dimples; separate spray is preserved.
  float filtered=mix(center,sum/10.,mix(.12,.65,dense));
  // Filter the actual free surface, not just its lighting normal. Restrict the
  // wider stencil to dense, nearly horizontal liquid and mirror at wet walls.
  // A symmetric horizontal kernel preserves a plane and broad wave slopes.
  vec3 gradient=vec3(0);
  for(int axis=0;axis<3;axis++){
    ivec3 off=ivec3(0);off[axis]=1;
    gradient[axis]=texelFetch(uField,fieldAtlas(q+off),0).r-texelFetch(uField,fieldAtlas(q-off),0).r;
  }
  float horizontal=smoothstep(.85,.98,gradient.y/max(length(gradient),1e-6));
  if(dense>.01&&horizontal>.01&&abs(center)<uVoxel*3.){
    vec3 point=voxelWorld(q),local=uInverse*(point-uCenter);
    bool interior=uClipToTank&&all(lessThanEqual(abs(local.xz),tank.xz))&&local.y>=-tank.y&&local.y<=tank.y;
    float total=0.,weightSum=0.;
    for(int z=-2;z<=2;z++)for(int x=-2;x<=2;x++){
      vec3 samplePoint=point+vec3(float(x),0,float(z))*uVoxel*2.;
      if(interior){
        vec3 p=uInverse*(samplePoint-uCenter);
        if(abs(p.x)>tank.x)p.x=sign(p.x)*(2.*tank.x-abs(p.x));
        if(abs(p.z)>tank.z)p.z=sign(p.z)*(2.*tank.z-abs(p.z));
        samplePoint=uRotation*p+uCenter;
      }
      float value=sampleFieldTexture(uField,samplePoint).r;
      float wx=x==0?6.:(abs(x)==1?4.:1.);
      float wz=z==0?6.:(abs(z)==1?4.:1.);
      // Exclude disconnected/sparse neighborhoods rather than bridging spray.
      float supported=smoothstep(2.,10.,sampleFieldTexture(uField,samplePoint).g);
      float weight=wx*wz*supported;
      total+=value*weight;weightSum+=weight;
    }
    if(weightSum>1e-5)filtered=mix(filtered,total/weightSum,dense*horizontal);
  }
  // Only suppress temporal sampling noise in almost stationary dense water.
  // Moving waves and falling drops use the current field without history.
  // History uses simulated time, so batch tests and slow frames cannot freeze it.
  float speed=sampleValue.b;
  float retention=exp(-uHistorySeconds/.10)*(1.-smoothstep(.04,.16,speed))*dense;
  float previous=texelFetch(uHistory,fieldAtlas(q),0).r;
  float agreement=1.-smoothstep(uVoxel*.25,uVoxel,abs(previous-filtered));
  if(uHasHistory)filtered=mix(filtered,previous,retention*agreement);
  result=vec4(filtered,sampleValue.gb,1);
}
`;

export const boundVertex=`
precision highp float;
precision highp int;
uniform sampler2D uPositions;
uniform vec2 uParticleSize;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uSpriteRadius;
uniform float uHeight;
uniform vec2 uResolution;
uniform vec3 uFieldGrid;
uniform vec3 uFieldOrigin;
uniform float uVoxel;
uniform bool uOutsideOnly;
in vec3 position;
flat out vec3 vView;
void main(){
  vec4 p=texelFetch(uPositions,ivec2(gl_InstanceID%int(uParticleSize.x),gl_InstanceID/int(uParticleSize.x)),0);
  vView=(modelViewMatrix*vec4(p.xyz,1)).xyz;
  gl_Position=projectionMatrix*vec4(vView,1);
  vec2 extent=vec2(uHeight*projectionMatrix[1][1]*uSpriteRadius/max(-vView.z-uSpriteRadius,.05))/uResolution;
  gl_Position.xy+=position.xy*extent*gl_Position.w;
  vec3 g=(p.xyz-uFieldOrigin)/uVoxel;
  bool inside=all(greaterThan(g,vec3(2)))&&all(lessThan(g,uFieldGrid-2.));
  if(p.a<.5||(uOutsideOnly&&inside))gl_Position=vec4(3,3,3,1);
}
`;
export const boundFragment=`
precision highp float;
uniform mat4 uInverseProjection;
uniform vec2 uResolution;
uniform float uSpriteRadius;
flat in vec3 vView;
out vec4 result;
void main(){
  vec4 p=uInverseProjection*vec4(gl_FragCoord.xy/uResolution*2.-1.,1,1);
  vec3 ray=normalize(p.xyz/p.w);
  float b=dot(ray,vView),disc=b*b-dot(vView,vView)+uSpriteRadius*uSpriteRadius;
  if(disc<0.)discard;
  float radius=sqrt(disc),nearT=max(b-radius,.01),farT=b+radius;
  if(farT<=0.)discard;
  // Component-wise MAX packs nearest and farthest conservative ray bounds.
  result=vec4(1./nearT,farT,0,1);
}
`;

export const dielectricOptics=`
// Unpolarized dielectric Fresnel; eta is incident IOR / transmitted IOR.
float dielectricFresnel(float cosine,float eta){
  float c=clamp(cosine,0.,1.),sin2=eta*eta*(1.-c*c);
  if(sin2>=1.)return 1.;
  float ct=sqrt(1.-sin2);
  float rs=(eta*c-ct)/max(eta*c+ct,1e-6);
  float rp=(c-eta*ct)/max(c+eta*ct,1e-6);
  return .5*(rs*rs+rp*rp);
}
`;
const waterOptics=dielectricOptics+`
vec3 displayColor(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
`+backdropShader+`
vec3 environment(vec3 r){return studioRay(vec3(0),r);}
vec3 transmittedBackground(vec3 point,vec3 direction,vec3 cameraPosition,float height){
  return studioRay(point,direction);
}
`;

export const surfaceTracing=`
float normalFieldAt(vec3 point,bool mirror){
  if(mirror){
    vec3 local=uInverse*(point-uCenter);
    if(abs(local.x)>tank.x)local.x=sign(local.x)*(2.*tank.x-abs(local.x));
    if(abs(local.z)>tank.z)local.z=sign(local.z)*(2.*tank.z-abs(local.z));
    if(local.y<-tank.y)local.y=-2.*tank.y-local.y;
    point=uRotation*local+uCenter;
  }
  return sampleFieldTexture(uField,point).r;
}
vec3 surfaceNormal(vec3 point){
  ivec3 cell=ivec3((point-uFieldOrigin)/uVoxel);
  float dense=smoothstep(2.,10.,texelFetch(uFieldMetadata,fieldAtlas(cell),0).g);
  float e=uVoxel*mix(.65,1.8,dense);
  // Differentiate the active surface of the intersection, not a wide stencil
  // through both water and glass. Blending their normals creates a rounded,
  // reflective "skin" at an otherwise sharp waterline.
  bool mirror=false;
  if(uClipToTank){
    vec3 local=uInverse*(point-uCenter);
    bool interior=all(lessThanEqual(abs(local.xz),tank.xz))&&local.y>=-tank.y&&local.y<=tank.y;
    mirror=interior;
    bool nearTank=all(lessThan(abs(local),tank+vec3(2.*wall)));
    if(interior){
      vec3 distances=vec3(tank.x-abs(local.x),local.y+tank.y,tank.z-abs(local.z));
      int axis=0;if(distances.y<distances.x)axis=1;if(distances.z<distances[axis])axis=2;
      if(-distances[axis]>=sampleFieldTexture(uField,point).r){
        vec3 normal=vec3(0);normal[axis]=axis==1?-1.:sign(local[axis]);return uRotation*normal;
      }
    }else if(nearTank&&-tankSdf(point)>=sampleFieldTexture(uField,point).r){
      float h=uVoxel*.03;
      vec3 normal=-vec3(tankSdf(point+vec3(h,0,0))-tankSdf(point-vec3(h,0,0)),tankSdf(point+vec3(0,h,0))-tankSdf(point-vec3(0,h,0)),tankSdf(point+vec3(0,0,h))-tankSdf(point-vec3(0,0,h)));
      return normal/max(length(normal),1e-6);
    }
  }
  vec3 gradient=vec3(normalFieldAt(point+vec3(e,0,0),mirror)-normalFieldAt(point-vec3(e,0,0),mirror),normalFieldAt(point+vec3(0,e,0),mirror)-normalFieldAt(point-vec3(0,e,0),mirror),normalFieldAt(point+vec3(0,0,e),mirror)-normalFieldAt(point-vec3(0,0,e),mirror));
  return gradient/max(length(gradient),1e-6);
}
// Find the first exit of this connected volume, along the refracted ray.
// The reconstruction is not a distance field inside; cap every step.
bool waterExit(vec3 entry,vec3 direction,out vec3 exitPoint,out float distance){
  float previous=0.;distance=uVoxel*.02;bool entered=false;
  // At the highest quality the minimum step is 0.00861 world units. Allow
  // enough steps to cross the tank diagonal even in a shallow implicit field.
  for(int i=0;i<512;i++){
    float phi=fieldAt(entry+direction*distance);
    if(phi>=0.&&!entered){
      // Entry refinement and trilinear volume sampling have finite precision.
      // An initial positive sample is not an exit: first establish an inside
      // interval, searching only a small entry-tolerance band, never across air.
      if(distance>=uVoxel*.5){exitPoint=entry+direction*distance;return false;}
      distance+=uVoxel*.04;continue;
    }
    if(phi>=0.){
      float lo=previous,hi=distance;
      for(int j=0;j<6;j++){float mid=(lo+hi)*.5;if(fieldAt(entry+direction*mid)<0.)lo=mid;else hi=mid;}
      distance=(lo+hi)*.5;exitPoint=entry+direction*distance;return true;
    }
    // Tank clipping makes phi arbitrarily small along a wetted wall even when
    // the ray is parallel to it. Using that value exhausted the march budget
    // midway across quiet water and switched abruptly to fallback radiance.
    // March by the liquid field; still detect exits with the clipped field.
    // A step shorter than the glass thickness cannot skip the solid wall.
    float liquidPhi=sampleFieldTexture(uField,entry+direction*distance).r;
    entered=true;previous=distance;
    distance+=clamp(-liquidPhi*.75,uVoxel*.3,min(uVoxel*1.5,wall));
  }
  exitPoint=entry+direction*distance;return false;
}
`;
export const interiorRadiance=`
vec3 traceInterior(vec3 point,vec3 inside,vec3 cameraPosition,float height,out float thickness,out vec3 pathStatus){
  vec3 transmitted=vec3(0),throughput=vec3(1),pathPoint=point,pathDirection=inside;
  pathStatus=vec3(1,1,0);
  thickness=0.;bool escaped=false;
  // Follow the reflected remainder at EVERY interface, including partial
  // reflection. Previously it sampled the sky while still inside the water,
  // creating bright patches and a discontinuity at the critical angle.
  for(int bounce=0;bounce<4;bounce++){
    vec3 exitPoint;float segment;
    bool foundExit=waterExit(pathPoint,pathDirection,exitPoint,segment);
    #ifdef AQUARIUM
    float fishDistance;vec3 fishColor;
    if(fishHit(pathPoint,pathDirection,segment,fishDistance,fishColor)){
      vec3 absorption=exp(-vec3(.065,.015,.008)*fishDistance);
      transmitted+=throughput*(vec3(.008,.025,.032)*(1.-absorption)+absorption*fishColor);
      if(bounce==0)thickness=fishDistance;
      pathStatus=vec3(0,.7,0);return transmitted;
    }
    #endif
    if(!foundExit){
      if(bounce==0)pathStatus=vec3(1,0,0);
      break;
    }
    if(bounce==0)thickness=segment;
    vec3 absorption=exp(-vec3(.065,.015,.008)*segment);
    transmitted+=throughput*vec3(.008,.025,.032)*(1.-absorption);
    throughput*=absorption;
    vec3 exitNormal=surfaceNormal(exitPoint);
    if(dot(exitNormal,pathDirection)<0.)exitNormal=-exitNormal;
    float f=dielectricFresnel(dot(exitNormal,pathDirection),1.333);
    if(f<1.){
      vec3 outgoing=refract(pathDirection,-exitNormal,1.333);
      transmitted+=throughput*(1.-f)*transmittedBackground(exitPoint,outgoing,cameraPosition,height);
      if(!escaped)pathStatus=bounce==0?vec3(0,.7,0):vec3(0,.4,1);
      escaped=true;
    }
    throughput*=f;
    pathPoint=exitPoint;pathDirection=reflect(pathDirection,exitNormal);
    if(max(throughput.r,max(throughput.g,throughput.b))<.005)break;
  }
  // Bounded residual for paths beyond the bounce budget; never add the full
  // environment after already accumulating transmitted energy.
  transmitted+=throughput*transmittedBackground(pathPoint,pathDirection,cameraPosition,height);
  return transmitted;
}
`;
export const rayFragment=fieldCommon+waterOptics+surfaceTracing+fishRayShader+interiorRadiance+`
uniform sampler2D uBounds;
uniform sampler2D uBackground;
uniform vec2 uResolution;
uniform mat4 uInverseProjection;
uniform mat4 uCameraWorld;
uniform mat4 uViewProjection;
uniform vec3 uCameraPosition;
uniform int uDebug;
out vec4 result;
void main(){
  vec2 uv=gl_FragCoord.xy/uResolution;
  vec3 background=displayColor(texture(uBackground,uv).rgb);
  vec4 bounds=texture(uBounds,uv);
  result=vec4(background,1);gl_FragDepth=1.;
  if(bounds.r<=0.)return;
  vec4 view=uInverseProjection*vec4(uv*2.-1.,1,1);
  vec3 ray=normalize(mat3(uCameraWorld)*(view.xyz/view.w));
  float start=max(1./bounds.r-uVoxel,.02),end=bounds.g+uVoxel;
  float t=start,previous=start,phi=0.;bool hit=false;
  // The zero isosurface is view-independent. No sprite silhouette is shaded.
  for(int i=0;i<96;i++){
    phi=fieldAt(uCameraPosition+ray*t);
    if(phi<0.){hit=true;break;}
    previous=t;t+=max(phi*.75,uVoxel*.18);
    if(t>end)break;
  }
  if(!hit)return;
  float lo=previous,hi=t;
  for(int i=0;i<6;i++){float mid=(lo+hi)*.5;if(fieldAt(uCameraPosition+ray*mid)>0.)lo=mid;else hi=mid;}
  t=(lo+hi)*.5;vec3 point=uCameraPosition+ray*t;
  vec3 n=surfaceNormal(point);
  if(dot(n,-ray)<0.)n=-n;
  vec4 projected=uViewProjection*vec4(point,1);gl_FragDepth=projected.z/projected.w*.5+.5;
  if(uDebug==1){result=vec4(vec3(t/9.),1);return;}
  if(uDebug==2){result=vec4(n*.5+.5,1);return;}
  vec3 inside=refract(ray,n,1./1.333);
  float fresnel=dielectricFresnel(dot(n,-ray),1./1.333);
  float thickness;vec3 pathStatus;
  vec3 transmitted=traceInterior(point,inside,uCameraPosition,uResolution.y,thickness,pathStatus);
  if(uDebug==3){result=vec4(vec3(thickness*.5),1);return;}
  if(uDebug==4){result=vec4(pathStatus,1);return;}
  vec3 reflection=transmittedBackground(point,reflect(ray,n),uCameraPosition,uResolution.y);
  vec3 color=mix(transmitted,reflection,fresnel);
  result=vec4(displayColor(color),1);
}
`;

// Escaped particles outside the reconstruction volume remain visible as exact
// ray/sphere intersections, including curved normals and depth. These are only
// distant spray, never a substitute for the reconstructed bulk water.
export const sprayFragment=`
precision highp float;
`+waterOptics+`
uniform mat4 uInverseProjection;
uniform mat4 projectionMatrix;
uniform mat4 uCameraWorld;
uniform vec3 uCameraPosition;
uniform vec2 uResolution;
uniform float uSpriteRadius;
uniform sampler2D uBackground;
uniform int uDebug;
flat in vec3 vView;
out vec4 result;
void main(){
  vec2 uv=gl_FragCoord.xy/uResolution;
  vec4 p=uInverseProjection*vec4(uv*2.-1.,1,1);vec3 ray=normalize(p.xyz/p.w);
  float b=dot(ray,vView),disc=b*b-dot(vView,vView)+uSpriteRadius*uSpriteRadius;
  if(disc<0.)discard;
  float halfLength=sqrt(disc),t=b-halfLength;if(t<.02)discard;
  vec3 hit=ray*t,normal=normalize(hit-vView),worldNormal=mat3(uCameraWorld)*normal;
  vec4 clip=projectionMatrix*vec4(hit,1);gl_FragDepth=clip.z/clip.w*.5+.5;
  if(uDebug==1){result=vec4(vec3(t/9.),1);return;}
  if(uDebug==2){result=vec4(worldNormal*.5+.5,1);return;}
  if(uDebug==3){result=vec4(vec3(halfLength),1);return;}
  float f=dielectricFresnel(dot(normal,-ray),1./1.333);
  vec3 reflected=mat3(uCameraWorld)*reflect(ray,normal);
  vec3 reflection=environment(reflected);
  vec3 inside=refract(ray,normal,1./1.333);
  float thickness=max(-2.*dot(hit-vView,inside),0.);
  vec3 exitPoint=hit+inside*thickness,exitNormal=normalize(exitPoint-vView);
  vec3 outgoing=refract(inside,-exitNormal,1.333);
  float exitFresnel=dielectricFresnel(dot(exitNormal,inside),1.333);
  vec3 exitWorld=(uCameraWorld*vec4(exitPoint,1)).xyz;
  vec3 transmitted=transmittedBackground(exitWorld,mat3(uCameraWorld)*outgoing,uCameraPosition,uResolution.y);
  vec3 internal=environment(mat3(uCameraWorld)*reflect(inside,exitNormal));
  vec3 absorption=exp(-vec3(.065,.015,.008)*thickness);
  vec3 refraction=mix(transmitted,internal,exitFresnel)*absorption+vec3(.008,.025,.032)*(1.-absorption);
  result=vec4(displayColor(mix(refraction,reflection,f)),1);
}
`;
