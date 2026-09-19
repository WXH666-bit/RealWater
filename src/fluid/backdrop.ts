import {TANK,WALL} from '../config';

/** Analytic studio geometry shared by camera, reflected and refracted rays.
 * All colors are linear. The room is visual scenery, not a fluid collider. */
export const backdropShader=`
uniform float uStudioLift;
uniform vec3 uStudioCenter;
uniform vec3 uStudioHalf;
const float studioFloor=${(-TANK.y-2*WALL-.008).toFixed(5)};
float studioPanel(vec2 p,vec2 c,vec2 h){vec2 d=abs(p-c)-h;return 1.-smoothstep(-.025,.025,max(d.x,d.y));}
vec3 studioRay(vec3 origin,vec3 ray){
  origin.y+=uStudioLift;
  float nearest=1e5;int face=0;
  if(ray.y<-.0001){float t=(studioFloor-origin.y)/ray.y;if(t>0.){nearest=t;face=1;}}
  if(ray.z<-.0001){float t=(-5.-origin.z)/ray.z;if(t>0.&&t<nearest){nearest=t;face=2;}}
  if(ray.x<-.0001){float t=(-5.-origin.x)/ray.x;if(t>0.&&t<nearest){nearest=t;face=3;}}
  if(ray.x>.0001){float t=(5.-origin.x)/ray.x;if(t>0.&&t<nearest){nearest=t;face=4;}}
  if(ray.z>.0001){float t=(7.-origin.z)/ray.z;if(t>0.&&t<nearest){nearest=t;face=5;}}
  if(ray.y>.0001){float t=(5.-origin.y)/ray.y;if(t>0.&&t<nearest){nearest=t;face=6;}}
  vec3 p=origin+ray*nearest;
  vec3 color=vec3(.56,.59,.57);
  if(face==1){
    // Matte limestone with broad seams: stable at oblique angles, no noisy texture.
    float vein=sin(p.x*2.1+sin(p.z*.9)*1.2)*sin(p.z*1.7+p.x*.32);
    color=vec3(.49,.46,.40)*(1.+.018*vein);
    vec2 seam=abs(fract((p.xz+vec2(.9,.5))/3.)-.5)*3.;
    color*=1.-.075*(1.-smoothstep(.006,.02,min(seam.x,seam.y)));
    float windowLight=studioPanel(p.xz,vec2(-1.7,-1.1),vec2(2.4,1.5));
    color+=vec3(.12,.115,.09)*windowLight;
    vec2 q=abs(p.xz-uStudioCenter.xz)-uStudioHalf.xz;
    float edge=length(max(q,0.))+min(max(q.x,q.y),0.);
    float contact=1.-smoothstep(-.025,.22,edge);
    vec2 shadowOffset=(p.xz-uStudioCenter.xz-vec2(.25,.15))/(uStudioHalf.xz+vec2(.45,.32));
    float soft=exp(-dot(shadowOffset,shadowOffset)*1.4);
    color*=1.-.18*contact-.15*soft;
    // Fine glass foot shadow gives the transparent vessel a readable contact edge.
    color*=1.-.12*exp(-abs(edge)*65.);
  }else if(face==2||face==5){
    color=mix(vec3(.34,.39,.38),vec3(.68,.70,.65),smoothstep(studioFloor,3.2,p.y));
    float panel=abs(fract((p.x+.6)/2.8)-.5)*2.8;
    color*=1.-.035*(1.-smoothstep(.008,.025,panel));
    color+=vec3(.10,.09,.065)*exp(-dot(p.xy-vec2(-1.,1.4),p.xy-vec2(-1.,1.4))*.15);
    color*=.87+.13*smoothstep(studioFloor,studioFloor+.3,p.y);
  }else if(face==3){
    color=vec3(.69,.70,.65);
    float window=studioPanel(p.zy,vec2(-.8,2.),vec2(1.7,1.65));
    float frame=1.-studioPanel(p.zy,vec2(-.8,2.),vec2(.025,1.7));
    frame*=1.-studioPanel(p.zy,vec2(-.8,2.),vec2(1.7,.025));
    color=mix(color,vec3(1.65,1.8,1.9)*frame,window);
  }else if(face==4){
    color=vec3(.40,.46,.46);
    color+=vec3(.45,.48,.48)*studioPanel(p.zy,vec2(.5,2.),vec2(.4,1.6));
  }else if(face==6){
    color=vec3(.65,.67,.64);
    color+=vec3(1.3,1.28,1.15)*studioPanel(p.xz,vec2(-1.,0.),vec2(1.2,1.8));
  }
  return color;
}
`;
