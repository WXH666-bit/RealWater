/** Shared world-space backdrop for direct viewing and refracted rays. */
export const backdropShader=`
vec3 backdropColor(vec2 p,vec2 footprint){
  float glow=exp(-dot(p-vec2(0,.7),p-vec2(0,.7))*.08);
  vec3 color=mix(vec3(.0075,.0123,.0144),vec3(.023,.036,.039),glow);
  vec2 grid=abs(fract(p*1.6-.5)-.5)/max(footprint,vec2(.001));
  float line=1.-min(min(grid.x,grid.y),1.);
  return color+line*.001*glow;
}
`;
