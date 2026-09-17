/** Exact five open-top wall boxes, shared by physics and liquid rendering. */
export const tankGeometry=`
const vec3 tank=vec3(1.0,0.72,0.65);
const float wall=0.06;
float boxSdf(vec3 p,vec3 b){vec3 d=abs(p)-b;return length(max(d,0.0))+min(max(d.x,max(d.y,d.z)),0.0);}
float tankSdf(vec3 p){
  vec3 q=uInverse*(p-uCenter);
  float d=boxSdf(q-vec3(0,-tank.y-wall,0),vec3(tank.x+2.*wall,wall,tank.z+2.*wall));
  d=min(d,boxSdf(q-vec3(tank.x+wall,0,0),vec3(wall,tank.y,tank.z+2.*wall)));
  d=min(d,boxSdf(q-vec3(-tank.x-wall,0,0),vec3(wall,tank.y,tank.z+2.*wall)));
  d=min(d,boxSdf(q-vec3(0,0,tank.z+wall),vec3(tank.x, tank.y,wall)));
  return min(d,boxSdf(q-vec3(0,0,-tank.z-wall),vec3(tank.x,tank.y,wall)));
}
`;
