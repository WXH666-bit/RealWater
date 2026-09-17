import type { Quality } from '../config';

// A dilute gap must break into droplets instead of forming a sticky bridge.
// At the isolated particle's true radius the kernel weight is still about .8.
export const SURFACE_MIN_WEIGHT=.55;
export const SURFACE_SUPPORT=3.5;
export const SURFACE_RADIUS=.89;
export const SPRAY_RADIUS=.65;

/** Tiled slices avoid the maximum texture-width limit of a one-row atlas. */
export function surfaceLayout(cell:number,quality:Quality){
  const spacing=cell*.55;
  const voxel=cell*(quality==='low'?.38:.35);
  // Cover the complete moving/tilting tank and nearby splashes. More distant
  // particles use the sphere-intersection spray pass; no particles are deleted.
  // Avoid spending half the reconstruction bandwidth on permanently empty air.
  const origin:[number,number,number]=[-2.8,-3,-2.4];
  const grid:[number,number,number]=[Math.ceil(5.6/voxel),Math.ceil(5.4/voxel),Math.ceil(4.8/voxel)];
  const columns=Math.ceil(Math.sqrt(grid[2]));
  return {voxel,origin,grid,columns,width:columns*grid[0],height:Math.ceil(grid[2]/columns)*grid[1],support:spacing*SURFACE_SUPPORT,radius:spacing*SURFACE_RADIUS,dropRadius:spacing*SPRAY_RADIUS};
}

/** Zhu–Bridson surface kernel, also used by the GPU splat. */
export function surfaceKernel(distance:number,support:number){return Math.max(0,1-(distance/support)**2)**3;}

export function referenceSurface(point:readonly number[],particles:readonly (readonly number[])[],support:number,radius:number,dropRadius=radius){
  let x=0,y=0,z=0,total=0,spread=0;
  for(const p of particles){
    const dx=p[0]-point[0],dy=p[1]-point[1],dz=p[2]-point[2];
    const weight=surfaceKernel(Math.hypot(dx,dy,dz),support);
    x+=dx*weight;y+=dy*weight;z+=dz*weight;total+=weight;
    spread+=(dx*dx+dy*dy+dz*dz)*weight;
  }
  const t=Math.max(0,Math.min(1,(total-2)/6)),blend=t*t*(3-2*t);
  const localRadius=dropRadius+(radius-dropRadius)*blend;
  const s=Math.max(0,Math.min(1,(total-1.1)/2.9));
  const reach=dropRadius+(support-dropRadius)*s*s*(3-2*s);
  return Math.max(total>1e-5?Math.hypot(x,y,z)/total-localRadius:support,Math.sqrt(spread/Math.max(total,1e-5))-reach,(SURFACE_MIN_WEIGHT-total)*dropRadius);
}
