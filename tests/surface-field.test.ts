import {describe,expect,it} from 'vitest';
import { PROFILES } from '../src/config';
import { referenceSurface, surfaceLayout, SURFACE_SUPPORT, SURFACE_RADIUS, SPRAY_RADIUS } from '../src/fluid/surface-field';

const liquid=(point:readonly number[],particles:readonly (readonly number[])[])=>referenceSurface(point,particles,SURFACE_SUPPORT,SURFACE_RADIUS,SPRAY_RADIUS);

function surfaceHeight(x:number,z:number,field:(point:number[])=>number){
  let lo=-1,hi=1;
  for(let i=0;i<16;i++){const y=(lo+hi)/2;if(field([x,y,z])>0)hi=y;else lo=y;}
  return (lo+hi)/2;
}

describe('continuous liquid reconstruction',()=>{
  it('reconstructs an isolated droplet as a sphere in every direction',()=>{
    const radius=SPRAY_RADIUS;
    for(let i=0;i<32;i++){
      const phi=i*Math.PI/16,theta=i*2.399963;
      const direction=[Math.sin(phi)*Math.cos(theta),Math.cos(phi),Math.sin(phi)*Math.sin(theta)];
      expect(liquid(direction.map(v=>v*radius),[[0,0,0]])).toBeCloseTo(0,10);
      expect(liquid(direction.map(v=>v*radius*.8),[[0,0,0]])).toBeLessThan(0);
      expect(liquid(direction.map(v=>v*radius*1.2),[[0,0,0]])).toBeGreaterThan(0);
    }
  });
  it('reconstructs a flat half-space without particle-shaped holes',()=>{
    const particles:number[][]=[];
    for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++)for(let y=0;y<4;y++)particles.push([x,-.5-y,z]);
    for(let x=0;x<=1;x+=.1)for(let z=0;z<=1;z+=.1){
      expect(Math.abs(liquid([x,0,z],particles))).toBeLessThan(.06);
      // Interior sign matters; this implicit field is not an exact interior SDF.
      expect(liquid([x,-.5,z],particles)).toBeLessThan(0);
    }
  });
  it('merges close particles but rejects a phantom surface in a large gap',()=>{
    expect(liquid([0,0,0],[[-.5,0,0],[.5,0,0]])).toBeLessThan(0);
    expect(liquid([0,0,0],[[-2,0,0],[2,0,0]])).toBeGreaterThan(0);
  });
  it('does not carve air around a marker in a dense asymmetric neighborhood',()=>{
    const particles:number[][]=[[0,0,0]];
    for(let i=0;i<64;i++)particles.push([1.4,(i%4-.5)*.05,(Math.floor(i/4)%4-.5)*.05]);
    expect(liquid([0,0,0],particles)).toBeLessThan(0);
    expect(liquid([5,0,0],particles)).toBeGreaterThan(0);
  });
  it('breaks a stretched water ligament instead of gluing separated droplets together',()=>{
    expect(liquid([0,0,0],[[-.8,0,0],[.8,0,0]])).toBeLessThan(0);
    expect(liquid([0,0,0],[[-1.5,0,0],[1.5,0,0]])).toBeGreaterThan(0);
  });
  it('suppresses bumps caused by irregular particle placement without moving the mean water level',()=>{
    const particles:number[][]=[];
    for(let x=-6;x<=6;x++)for(let z=-6;z<=6;z++)for(let y=0;y<5;y++){
      const seed=Math.sin(x*12.9898+z*78.233+y*39.346)*43758.5453;
      particles.push([x,-.5-y+(seed-Math.floor(seed)-.5)*.6,z]);
    }
    const before:number[]=[],after:number[]=[];
    for(let x=-1.5;x<=1.5;x+=.5)for(let z=-1.5;z<=1.5;z+=.5){
      before.push(surfaceHeight(x,z,p=>referenceSurface(p,particles,2.5,.67)));
      after.push(surfaceHeight(x,z,p=>liquid(p,particles)));
    }
    const mean=(a:number[])=>a.reduce((sum,v)=>sum+v,0)/a.length;
    const rms=(a:number[])=>Math.sqrt(a.reduce((sum,v)=>sum+(v-mean(a))**2,0)/a.length);
    expect(rms(after)).toBeLessThan(rms(before)*.7);
    expect(Math.abs(mean(after))).toBeLessThan(.08);
  });
  it('preserves a broad physical wave while smoothing particle-scale bumps',()=>{
    const particles:number[][]=[];
    for(let x=-8;x<=8;x++)for(let z=-5;z<=5;z++)for(let y=0;y<5;y++)particles.push([x,-.5-y+.6*Math.sin(x*Math.PI/7),z]);
    const crest=surfaceHeight(3.5,0,p=>liquid(p,particles));
    const trough=surfaceHeight(-3.5,0,p=>liquid(p,particles));
    expect(crest-trough).toBeGreaterThan(.9);
    expect(crest-trough).toBeLessThan(1.3);
  });
  it('keeps a single-marker-thick sheet visible without filling the surrounding air',()=>{
    const particles:number[][]=[];
    for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)particles.push([x,0,z]);
    for(let x=0;x<=1;x+=.1)for(let z=0;z<=1;z+=.1){
      expect(liquid([x,0,z],particles)).toBeLessThan(0);
      expect(liquid([x,1,z],particles)).toBeGreaterThan(0);
    }
  });
  it('keeps all quality atlases inside a 4096 texture without losing slices',()=>{
    for(const quality of ['low','medium','high'] as const){
      const layout=surfaceLayout(PROFILES[quality].cell,quality);
      expect(layout.width).toBeLessThanOrEqual(4096);expect(layout.height).toBeLessThanOrEqual(4096);
      expect(layout.width*layout.height).toBeGreaterThanOrEqual(layout.grid[0]*layout.grid[1]*layout.grid[2]);
      // Worst case: an isolated drop is exactly between eight voxels. Include
      // the small outward shift introduced by the sparse smoothing stencil.
      expect(layout.voxel*.90).toBeLessThan(layout.dropRadius);
    }
  });
});
