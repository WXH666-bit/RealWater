import { Quaternion, Vector3 } from 'three';

/** Horizontal world directions corresponding to screen right/down. The camera
 * stays upright, including when looking at the tank from below. */
export function screenGroundBasis(camera: Quaternion) {
  const right=new Vector3(1,0,0).applyQuaternion(camera);right.y=0;right.normalize();
  const down=new Vector3(0,-1,0).applyQuaternion(camera);down.y=0;
  if(down.lengthSq()<1e-8)down.crossVectors(new Vector3(0,1,0),right);
  down.normalize();
  return {right,down};
}

export function movementForView(camera:Quaternion,x:number,y:number) {
  const {right,down}=screenGroundBasis(camera);
  return right.multiplyScalar(x).addScaledVector(down,y);
}

export function tiltForView(camera:Quaternion,x:number,y:number) {
  // An angular impulse about (up × drag) makes the rim lean in the
  // screen drag direction, whichever side of the aquarium is visible.
  return new Vector3(0,1,0).cross(movementForView(camera,x,y));
}
