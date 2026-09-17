import { SURFACE_MIN_WEIGHT } from './surface-field';

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
uniform sampler2D uMoments;
uniform sampler2D uSpread;
ivec2 fieldAtlas(ivec3 q){q=clamp(q,ivec3(0),ivec3(uFieldGrid)-1);return ivec2((q.z%int(uColumns))*int(uFieldGrid.x)+q.x,(q.z/int(uColumns))*int(uFieldGrid.y)+q.y);}
ivec3 fieldCoord(vec2 pixel){ivec2 q=ivec2(pixel);return ivec3(q.x%int(uFieldGrid.x),q.y%int(uFieldGrid.y),(q.y/int(uFieldGrid.y))*int(uColumns)+q.x/int(uFieldGrid.x));}
vec3 voxelWorld(ivec3 q){return uFieldOrigin+(vec3(q)+.5)*uVoxel;}
float fieldAt(vec3 p){
  vec3 g=(p-uFieldOrigin)/uVoxel-.5;
  if(any(lessThan(g,vec3(0)))||any(greaterThan(g,uFieldGrid-1.001)))return uSupport;
  vec3 b=floor(g),f=fract(g);
  vec2 a=(vec2(fieldAtlas(ivec3(b)))+f.xy+.5)/uFieldSize;
  vec2 c=(vec2(fieldAtlas(ivec3(b)+ivec3(0,0,1)))+f.xy+.5)/uFieldSize;
  return mix(texture(uField,a).r,texture(uField,c).r,f.z);
}
`;

export const momentVertex=fieldCommon+`
uniform sampler2D uPositions;
uniform vec2 uParticleSize;
uniform int uLayer;
uniform float uSplatSize;
flat out vec3 vParticle;
flat out int vLayer;
void main(){
  vec4 p=texelFetch(uPositions,ivec2(gl_VertexID%int(uParticleSize.x),gl_VertexID/int(uParticleSize.x)),0);
  vec3 g=(p.xyz-uFieldOrigin)/uVoxel-.5;
  vParticle=p.xyz;vLayer=int(floor(g.z))+uLayer;
  ivec3 center=ivec3(ivec2(floor(g.xy)),vLayer);
  vec2 pixel=vec2(fieldAtlas(center))+.5;
  gl_Position=vec4(pixel/uFieldSize*2.-1.,0,1);gl_PointSize=uSplatSize;
  if(p.a<.5||vLayer<0||float(vLayer)>=uFieldGrid.z||any(lessThan(g.xy,vec2(0)))||any(greaterThan(g.xy,uFieldGrid.xy-1.)))gl_Position=vec4(3,3,3,1);
}
`;
export const momentFragment=fieldCommon+`
flat in vec3 vParticle;
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
  spread=vec4(dot(delta,delta)*w,0,0,1);
}
`;
export const fieldFragment=fieldCommon+`
out vec4 result;
void main(){
  vec4 moment=texelFetch(uMoments,ivec2(gl_FragCoord.xy),0);
  // A wider neighborhood reconstructs the bulk wave instead of exposing each
  // particle's bump. Sparse spray keeps its own small radius, not a thick blob.
  float radius=mix(uDropRadius,uSurfaceRadius,smoothstep(2.,8.,moment.a));
  float phi=moment.a>1e-5?length(moment.xyz/moment.a)*uSupport-radius:uSupport;
  // A mean position can lie in an empty gap between droplets. The second
  // moment rejects that false bridge, while dense bulk water stays smooth.
  float rms=sqrt(max(texelFetch(uSpread,ivec2(gl_FragCoord.xy),0).r/max(moment.a,1e-5),0.))*uSupport;
  float reach=mix(uDropRadius,uSupport,smoothstep(1.1,4.,moment.a));
  phi=max(phi,rms-reach);
  // Reject unsupported lobes between far-apart particles with tiny kernel tails.
  phi=max(phi,(${SURFACE_MIN_WEIGHT}-moment.a)*uDropRadius);
  result=vec4(phi,0,0,1);
}
`;
export const smoothFieldFragment=fieldCommon+`
out vec4 result;
void main(){
  ivec3 q=fieldCoord(gl_FragCoord.xy);
  float center=texelFetch(uField,fieldAtlas(q),0).r;
  float dense=smoothstep(2.,10.,texelFetch(uMoments,fieldAtlas(q),0).a);
  int stride=dense>.5?2:1;
  float sum=center*4.;
  for(int axis=0;axis<3;axis++)for(int sign=-1;sign<=1;sign+=2){
    ivec3 off=ivec3(0);off[axis]=sign*stride;sum+=texelFetch(uField,fieldAtlas(q+off),0).r;
  }
  // Spatial filtering only: there is no temporal blend or lag in the wave.
  // Dense water loses particle-scale dimples; separate spray is preserved.
  result=vec4(mix(center,sum/10.,mix(.12,.65,dense)),0,0,1);
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

const waterOptics=`
vec3 displayColor(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
float panel(vec2 p,vec2 center,vec2 halfSize){
  vec2 edge=abs(p-center)-halfSize;
  float d=max(edge.x,edge.y),width=max(fwidth(d)*1.25,.045);
  return 1.-smoothstep(-width,width,d);
}
vec3 environment(vec3 r){
  // Clear water reflects sharp light sources. A broad grey lobe made every
  // ripple look like a rounded, opaque rubber surface.
  vec3 sky=mix(vec3(.012,.018,.021),vec3(.13,.17,.19),smoothstep(-.3,1.,r.y));
  if(r.y>0.03){
    vec2 ceiling=r.xz/r.y;
    float key=panel(ceiling,vec2(-.9,-.55),vec2(.5,.35));
    float strip=panel(ceiling,vec2(.9,.15),vec2(.08,1.05));
    sky+=vec3(.9,.95,1.)*key+vec3(.5,.6,.65)*strip;
  }
  return sky;
}
`;

export const rayFragment=fieldCommon+waterOptics+`
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
  ivec3 fieldCell=ivec3((point-uFieldOrigin)/uVoxel);
  float dense=smoothstep(2.,10.,texelFetch(uMoments,fieldAtlas(fieldCell),0).a);
  float e=uVoxel*mix(.65,1.8,dense);
  vec3 n=normalize(vec3(fieldAt(point+vec3(e,0,0))-fieldAt(point-vec3(e,0,0)),fieldAt(point+vec3(0,e,0))-fieldAt(point-vec3(0,e,0)),fieldAt(point+vec3(0,0,e))-fieldAt(point-vec3(0,0,e))));
  if(dot(n,-ray)<0.)n=-n;
  // Integrate occupied distance, so disconnected droplets do not look like a
  // solid slab between the nearest and farthest particles.
  float thickness=0.,segment=max(end-t,0.)/32.;
  for(int i=0;i<32;i++){
    float s=fieldAt(uCameraPosition+ray*(t+(float(i)+.5)*segment));
    thickness+=segment*(1.-smoothstep(-uVoxel*.35,uVoxel*.35,s));
  }
  vec4 projected=uViewProjection*vec4(point,1);gl_FragDepth=projected.z/projected.w*.5+.5;
  if(uDebug==1){result=vec4(vec3(t/9.),1);return;}
  if(uDebug==2){result=vec4(n*.5+.5,1);return;}
  if(uDebug==3){result=vec4(vec3(thickness*.5),1);return;}
  float cosine=clamp(dot(n,-ray),0.,1.);
  float fresnel=.0204+.9796*pow(1.-cosine,5.);
  vec3 refracted=refract(ray,n,1./1.333);
  vec4 bent=uViewProjection*vec4(point+refracted*min(thickness,2.5),1);
  vec2 offset=bent.xy/max(bent.w,.01)*.5+.5-uv;
  vec3 transmitted=texture(uBackground,clamp(uv+offset,vec2(.001),vec2(.999))).rgb;
  vec3 absorption=exp(-vec3(.065,.015,.008)*thickness);
  transmitted=transmitted*absorption+vec3(.008,.025,.032)*(1.-absorption);
  vec3 reflection=environment(reflect(ray,n));
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
  float f=.0204+.9796*pow(1.-clamp(dot(normal,-ray),0.,1.),5.);
  vec3 reflected=mat3(uCameraWorld)*reflect(ray,normal);
  vec3 reflection=environment(reflected);
  vec3 refraction=texture(uBackground,clamp(uv+normal.xy*.006,vec2(.001),vec2(.999))).rgb;
  result=vec4(displayColor(mix(refraction,reflection,f)),1);
}
`;
