import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { movementForView, tiltForView } from '../src/view-controls';

describe('view-relative tank interaction',()=>{
  for(const elevation of [0.55,-0.55])for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5,Math.PI*2]){
    it(`screen directions remain consistent at azimuth ${angle.toFixed(2)}, elevation ${elevation}`,()=>{
      const camera=new PerspectiveCamera();
      camera.position.set(Math.sin(angle)*5,elevation*5,Math.cos(angle)*5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
      const inverse=camera.quaternion.clone().invert();
      const right=movementForView(camera.quaternion,1,0);
      const down=movementForView(camera.quaternion,0,1);
      expect(right.y).toBe(0);expect(down.y).toBe(0);
      expect(right.clone().applyQuaternion(inverse).x).toBeCloseTo(1,6);
      expect(down.clone().applyQuaternion(inverse).y).toBeLessThan(0);
      // An infinitesimal tilt must lean the rim in the same projected direction.
      const rimRight=tiltForView(camera.quaternion,1,0).cross(new Vector3(0,1,0));
      const rimDown=tiltForView(camera.quaternion,0,1).cross(new Vector3(0,1,0));
      expect(rimRight.distanceTo(right)).toBeLessThan(1e-6);
      expect(rimDown.distanceTo(down)).toBeLessThan(1e-6);
    });
  }
  it('reverses the world shake direction after a half turn',()=>{
    const camera=new PerspectiveCamera();camera.position.set(0,2,5);camera.lookAt(0,0,0);
    const front=movementForView(camera.quaternion,.2,0);
    camera.position.set(0,2,-5);camera.lookAt(0,0,0);
    const back=movementForView(camera.quaternion,.2,0);
    expect(front.x).toBeCloseTo(.2);expect(back.x).toBeCloseTo(-.2);
  });
});
