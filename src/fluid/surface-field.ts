import {TANK_REACH,TANK_TRAVEL,type Quality} from '../config';

// A dilute gap must break into droplets instead of forming a sticky bridge.
// At the isolated particle's true radius the kernel weight is still about .8.
export const SURFACE_MIN_WEIGHT=.55;
export const SURFACE_SUPPORT=3.5;
export const SURFACE_RADIUS=.89;
export const SPRAY_RADIUS=.65;
// The poly6 support of a uniform lattice is about 27; a flat interface has
// about half that support. Dense interior must not become air just because
// marker crowding shifts the weighted centroid to one side.
export const BULK_SUPPORT=16;

/** Tiled slices avoid the maximum texture-width limit of a one-row atlas. */
export function surfaceLayout(cell:number,quality:Quality){
  const spacing=cell*.55;
  const voxel=cell*(quality==='low'?.38:.35);
  // Cover the complete moving/tilting tank and nearby splashes. More distant
  // particles use the sphere-intersection spray pass; no particles are deleted.
  // Avoid spending half the reconstruction bandwidth on permanently empty air.
  const extent=[Math.max(2.8,TANK_REACH+TANK_TRAVEL.x+.3),3,Math.max(2.4,TANK_REACH+TANK_TRAVEL.z+.3)];
  const origin=extent.map(n=>-n) as [number,number,number];
  const grid=extent.map(n=>Math.ceil(2*n/voxel)) as [number,number,number];
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
  const phi=Math.max(total>1e-5?Math.hypot(x,y,z)/total-localRadius:support,Math.sqrt(spread/Math.max(total,1e-5))-reach,(SURFACE_MIN_WEIGHT-total)*dropRadius);
  const bulkT=Math.max(0,Math.min(1,(total-(BULK_SUPPORT-4))/4));
  return phi+(Math.min(phi,radius*(1-total/BULK_SUPPORT))-phi)*bulkT*bulkT*(3-2*bulkT);
}
