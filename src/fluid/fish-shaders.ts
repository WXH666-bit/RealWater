import {FISH_LIMIT} from '../aquarium';

/** Analytic geometry is intersected along the actual refracted water ray. */
export const fishRayShader=`
uniform sampler2D uFishPosition,uFishVelocity,uFishHeading;
uniform int uFishCount;
float fishEllipsoid(vec3 ro,vec3 rd,vec3 center,vec3 axes,out vec3 normal){
  vec3 o=(ro-center)/axes,d=rd/axes;
  float a=dot(d,d),b=dot(o,d),c=dot(o,o)-1.,disc=b*b-a*c;
  if(disc<0.)return 1e20;
  float t=(-b-sqrt(disc))/a;if(t<.0001)t=(-b+sqrt(disc))/a;
  if(t<.0001)return 1e20;
  normal=normalize((ro+rd*t-center)/(axes*axes));return t;
}
bool fishHit(vec3 origin,vec3 direction,float limit,out float nearest,out vec3 color){
  nearest=limit;color=vec3(0);bool found=false;
  if(uFishCount==0)return false;
  for(int id=0;id<${FISH_LIMIT};id++){
    vec4 fish=texelFetch(uFishPosition,ivec2(id,0),0),heading=texelFetch(uFishHeading,ivec2(id,0),0);
    if(fish.w<.5||heading.w>0.)continue;
    vec3 delta=origin-fish.xyz;float b=dot(delta,direction);
    float disc=b*b-dot(delta,delta)+.215*.215;
    if(disc<0.||-b+sqrt(disc)<0.||-b-sqrt(disc)>nearest)continue;
    vec3 forward=normalize(heading.xyz),side=normalize(cross(forward,abs(forward.y)>.95?vec3(0,0,1):vec3(0,1,0)));
    mat3 basis=mat3(forward,normalize(cross(side,forward)),side);
    vec3 ro=transpose(basis)*delta,rd=transpose(basis)*direction;
    float phase=texelFetch(uFishVelocity,ivec2(id,0),0).w;
    int kind=int(fish.w+.5);
    vec3 axes=kind==2?vec3(.11,.082,.031):kind==3?vec3(.13,.042,.032):vec3(.11,.058,.04);
    vec3 base=kind==2?vec3(.025,.32,.9):kind==3?vec3(1.,.68,.025):vec3(1.,.24,.025);
    for(int part=0;part<8;part++){
      vec3 center=vec3(0),size=axes,tint=base,n;
      if(part==1){center=vec3(-.151,0,sin(phase)*.023);size=vec3(.045,.07,.012);}
      if(part==2){center=vec3(-.025,axes.y*.92,0);size=vec3(.065,.03,.009);}
      if(part==3){center=vec3(-.015,-axes.y*.88,0);size=vec3(.04,.023,.009);}
      if(part==4){center=vec3(.008,-.018,sin(phase)*.025);size=vec3(.032,.012,.065);}
      if(part==5||part==6){center=vec3(axes.x*.65,axes.y*.25,(part==5?-1.:1.)*axes.z*.8);size=vec3(.013);tint=vec3(.008,.012,.018);}
      if(part==7){center=vec3(-.105,0,sin(phase)*.011);size=vec3(.048,.024,.024);}
      float t=fishEllipsoid(ro,rd,center,size,n);
      if(t>=nearest)continue;
      vec3 hit=ro+rd*t;
      if(part==0&&kind==1){float stripe=min(abs(hit.x-.045),abs(hit.x+.05));tint=mix(base,vec3(.94,.98,1),1.-smoothstep(.011,.018,stripe));}
      if(part==0&&kind==2){float band=abs(hit.y-axes.y*.15);tint=mix(base,vec3(.014,.028,.11),1.-smoothstep(.012,.023,band));}
      vec3 worldNormal=basis*n;float light=.52+.48*max(dot(worldNormal,normalize(vec3(-.4,.8,1))),0.);
      float shine=pow(max(dot(reflect(-normalize(vec3(-.4,.8,1)),worldNormal),-direction),0.),32.);
      color=tint*light+vec3(.3)*shine;nearest=t;found=true;
    }
  }
  return found;
}
`;
