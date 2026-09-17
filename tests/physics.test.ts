import { describe, expect, it } from 'vitest';
import { FIXED_DT, PROFILES, StepClock, TANK, initialParticles } from '../src/config';

describe('particle initialization', () => {
  for (const [quality, profile] of Object.entries(PROFILES)) {
    it(`${quality}: seeds a reproducible half tank and reserves space for new water`, () => {
      const first = initialParticles(profile.cell, profile.capacity);
      const second = initialParticles(profile.cell, profile.capacity);
      expect(first.count).toBeGreaterThan(1000);
      expect(first.count).toBeLessThan(profile.capacity / 2);
      expect(first.positions).toEqual(second.positions);
      for (let i = 0; i < first.count; i++) {
        const [x, y, z, active] = first.positions.subarray(i * 4, i * 4 + 4);
        expect(Math.abs(x)).toBeLessThan(TANK.x);
        expect(Math.abs(z)).toBeLessThan(TANK.z);
        expect(y).toBeGreaterThan(-TANK.y);
        expect(y).toBeLessThan(0);
        expect(active).toBe(1);
      }
      expect(first.positions.slice(first.count * 4).every(value => value === 0)).toBe(true);
    });
  }
  it('rejects a capacity that would silently lose initial water', () => {
    expect(() => initialParticles(PROFILES.medium.cell, 10)).toThrow('容量');
  });
});

describe('fixed-step simulation clock', () => {
  it('keeps gravity and waves in real time from 12 to 240 rendered frames/second', () => {
    for (const fps of [12,15,20,30,60,120,240]) {
      const clock = new StepClock();let steps = 0;
      for (let i = 0; i < fps * 10; i++) steps += clock.advance(1 / fps);
      expect(steps * FIXED_DT).toBeCloseTo(10, 5);
    }
  });
  it('drops long background gaps instead of making one destructive large physics step', () => {
    const clock = new StepClock();
    expect(clock.advance(60)).toBe(0);
    clock.reset();
    expect(clock.advance(0)).toBe(0);
  });
  it('clears remaining time on pause and never advances with negative elapsed time', () => {
    const clock = new StepClock();clock.advance(FIXED_DT / 2);
    expect(clock.advance(1, true)).toBe(0);
    expect(clock.advance(FIXED_DT / 2)).toBe(0);
    clock.reset();expect(clock.advance(-1)).toBe(0);
  });
  it('keeps pace through alternating fast and slow frames without accumulating a backlog',()=>{
    const clock=new StepClock();let seconds=0,steps=0;
    for(let i=0;i<100;i++)for(const delta of [1/60,1/12,1/15,1/30,1/20]){seconds+=delta;steps+=clock.advance(delta);}
    expect(Math.abs(seconds-steps*FIXED_DT)).toBeLessThan(FIXED_DT);
    expect(clock.advance(NaN)).toBe(0);
    expect(clock.advance(FIXED_DT)).toBe(1);
  });
});
