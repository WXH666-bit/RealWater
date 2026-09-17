import { Vector3 } from 'three';

export type Quality = 'low' | 'medium' | 'high';
export type Mode = 'move' | 'tilt' | 'drop';
export const TANK = new Vector3(1, 0.72, 0.65);
export const WALL = 0.06;
export const MAX_TILT = 85 * Math.PI / 180;
export const FIXED_DT = 1 / 90;
// A two-unit tank represents a 40 cm tabletop aquarium, not a two-metre pool.
export const METERS_PER_UNIT = 0.2;
export const GRAVITY = 9.81 / METERS_PER_UNIT;
export const PROFILES = {
  // Low quality reduces reconstruction/pixel cost, not the minimum physics
  // accuracy: coarser grids introduced wall-dependent volume drift at rest.
  low: { cell: 0.105, grid: [54, 46, 40], pressure: 30, scale: 0.7, capacity: 32768 },
  medium: { cell: 0.105, grid: [54, 46, 40], pressure: 30, scale: 0.85, capacity: 32768 },
  high: { cell: 0.082, grid: [68, 58, 52], pressure: 42, scale: 1, capacity: 65536 },
} as const;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Deterministic seed keeps resets and regression scenarios reproducible. */
export function randomSequence(seed = 48271) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export function initialParticles(cell: number, capacity: number) {
  const spacing = cell * 0.55;
  const positions = new Float32Array(capacity * 4);
  const random = randomSequence();
  let count = 0;
  const nx=Math.floor(2*TANK.x/spacing),ny=Math.floor(TANK.y/spacing),nz=Math.floor(2*TANK.z/spacing);
  for (let iy=0;iy<ny;iy++) {
    const y=-TANK.y+(iy+.5)*TANK.y/ny;
    for (let iz=0;iz<nz;iz++) {
      const z=-TANK.z+(iz+.5)*2*TANK.z/nz;
      for (let ix=0;ix<nx;ix++) {
        const x=-TANK.x+(ix+.5)*2*TANK.x/nx;
        if (count >= capacity) throw new Error('初始水量超过粒子池容量');
        positions.set([x + (random() - 0.5) * spacing * 0.07, y, z + (random() - 0.5) * spacing * 0.07, 1], count * 4);
        count++;
      }
    }
  }
  // Rounding the lattice dimensions changes the actual sample spacing. Every
  // marker represents an equal share of the specified half-tank volume.
  const markerVolume=4*TANK.x*TANK.y*TANK.z/count;
  return { positions, count, spacing, markerVolume };
}

/** Fixed-step clock never carries a background tab's elapsed time into physics. */
export class StepClock {
  private accumulator = 0;
  reset() { this.accumulator = 0; }
  advance(delta: number, paused = false) {
    if (paused) { this.reset(); return 0; }
    // Keep real time even at 12–20 rendered FPS. The old four-step ceiling
    // slowed gravity and waves whenever rendering fell below 22.5 FPS.
    // Long interruptions are discarded, never repaid as a burst of physics.
    if(!Number.isFinite(delta)||delta>.25){this.reset();return 0;}
    this.accumulator += Math.max(delta,0);
    const steps = Math.min(8, Math.floor((this.accumulator + 1e-9) / FIXED_DT));
    this.accumulator -= steps * FIXED_DT;
    // Keep the fractional step through a slow frame, but discard a backlog
    // beyond the work budget so an interruption cannot delay later input.
    if(this.accumulator>=FIXED_DT)this.accumulator%=FIXED_DT;
    return steps;
  }
}
