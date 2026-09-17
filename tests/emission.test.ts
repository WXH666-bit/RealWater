import {describe,it,expect} from 'vitest';
import {PROFILES,TANK,initialParticles,randomSequence} from '../src/config';
import {dropOffsets,dropParticleCount} from '../src/fluid/emission';

describe('water emission',()=>{
  it('quantizes the requested volume by at most half a marker at every UI size',()=>{
    for(const profile of Object.values(PROFILES))for(let radius=.07;radius<=.16001;radius+=.01){
      const spacing=profile.cell*.55,count=dropParticleCount(radius,spacing);
      expect(Math.abs(count*spacing**3-4*Math.PI/3*radius**3)).toBeLessThanOrEqual(spacing**3*.500001);
    }
  });
  it('uses the same physical marker volume for a half tank and added drops',()=>{
    for(const profile of Object.values(PROFILES)){
      const initial=initialParticles(profile.cell,profile.capacity);
      expect(initial.count*initial.markerVolume).toBeCloseTo(4*TANK.x*TANK.y*TANK.z,12);
      for(const radius of [.07,.12,.16]){
        const count=dropParticleCount(radius,Math.cbrt(initial.markerVolume));
        expect(Math.abs(count*initial.markerVolume-4*Math.PI/3*radius**3)).toBeLessThanOrEqual(initial.markerVolume*.500001);
      }
    }
  });
  it('avoids initial particle clusters while retaining the drop center and bounds',()=>{
    for(const profile of Object.values(PROFILES))for(const radius of [.07,.12,.16])for(const seed of [2026,42,91]){
      const spacing=profile.cell*.55,count=dropParticleCount(radius,spacing);
      const points=dropOffsets(count,radius,randomSequence(seed));
      const mean=[0,0,0];let separation=Infinity;
      for(let i=0;i<count;i++){
        const p=Array.from(points.subarray(i*3,i*3+3));
        expect(Math.hypot(...p)).toBeLessThanOrEqual(radius+1e-7);
        p.forEach((v,axis)=>mean[axis]+=v/count);
        for(let j=0;j<i;j++)separation=Math.min(separation,Math.hypot(...p.map((v,axis)=>v-points[j*3+axis])));
      }
      expect(Math.hypot(...mean)).toBeLessThan(1e-7);
      expect(separation).toBeGreaterThan(spacing*.4);
    }
  });
  it('is reproducible and handles a single marker without introducing drift',()=>{
    expect(dropOffsets(38,.12,randomSequence(2026))).toEqual(dropOffsets(38,.12,randomSequence(2026)));
    expect([...dropOffsets(1,.03,randomSequence())]).toEqual([0,0,0]);
    expect(dropParticleCount(NaN,.05)).toBe(0);
    expect(dropParticleCount(-1,.05)).toBe(0);
  });
});
