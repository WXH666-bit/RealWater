import {describe,it,expect} from 'vitest';
import {Vector3,Euler,Quaternion} from 'three';
import {TANK,WALL,TANK_TRAVEL,MAX_TILT,PROFILES,gridLayout,initialParticles} from '../src/config';
import {surfaceLayout} from '../src/fluid/surface-field';
import {tankGeometry} from '../src/fluid/tank-geometry';

describe('widened aquarium geometry',()=>{
  it('uses the same 52 cm tank in CPU initialization and GPU geometry',()=>{
    expect(TANK.toArray()).toEqual([1.3,.72,.65]);
    expect(tankGeometry).toContain(`vec3(${TANK.x.toFixed(6)},${TANK.y.toFixed(6)},${TANK.z.toFixed(6)})`);
    for(const profile of Object.values(PROFILES)){
      const initial=initialParticles(profile.cell,profile.capacity);
      expect(initial.count*initial.markerVolume).toBeCloseTo(4*TANK.x*TANK.y*TANK.z,12);
      expect(initial.count).toBeLessThan(profile.capacity/2);
      expect(Math.max(...Array.from({length:initial.count},(_,i)=>initial.positions[i*4]))).toBeGreaterThan(1.25);
    }
  });
  it.each(['low','medium','high'] as const)('%s keeps all rotated walls inside physics and surface domains',quality=>{
    const p=PROFILES[quality],grid=new Vector3(...p.grid).addScalar(1),half=grid.multiplyScalar(p.cell/2),surface=surfaceLayout(p.cell,quality);
    const atlas=gridLayout(p.grid.map(n=>n+1));expect(atlas.width).toBeLessThanOrEqual(4096);expect(atlas.height).toBeLessThanOrEqual(4096);
    expect(surface.width).toBeLessThanOrEqual(4096);expect(surface.height).toBeLessThanOrEqual(4096);
    for(let rx=-MAX_TILT;rx<=MAX_TILT;rx+=MAX_TILT/4)for(let rz=-MAX_TILT;rz<=MAX_TILT;rz+=MAX_TILT/4){
      const q=new Quaternion().setFromEuler(new Euler(rx,0,rz,'YXZ'));
      for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
        const v=TANK.clone().addScalar(2*WALL).multiply(new Vector3(x,y,z)).applyQuaternion(q);
        for(let axis=0;axis<3;axis++){
          const bound=Math.abs(v.getComponent(axis))+TANK_TRAVEL.getComponent(axis);
          const clearance=axis===1?Math.min(2.65,2*half.y-2.65):half.getComponent(axis);
          expect(bound+2*p.cell).toBeLessThanOrEqual(clearance);
          expect(bound).toBeLessThan(-surface.origin[axis]);
        }
      }
    }
  });
  it('packs high-resolution physics layers into bounded texture rows',()=>{
    const g=PROFILES.high.grid.map(n=>n+1),layout=gridLayout(g);
    expect(layout.width*layout.height).toBeGreaterThanOrEqual(g[0]*g[1]*g[2]);
    for(let z=0;z<g[2];z++){
      const x=(z%layout.columns)*g[0],y=Math.floor(z/layout.columns)*g[1];
      expect(x+g[0]).toBeLessThanOrEqual(layout.width);expect(y+g[1]).toBeLessThanOrEqual(layout.height);
    }
  });
});
