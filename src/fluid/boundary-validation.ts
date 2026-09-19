import {TANK,WALL} from '../config';
import * as THREE from 'three';
import { FluidSolver } from './solver';
import { FluidSurface } from './implicit-surface';

/** Initial half-tank, actual particle splat + reconstruction + glass clipping. */
export function validateBoundaries(renderer:THREE.WebGLRenderer){
  const camera=new THREE.PerspectiveCamera(34,1,.05,50);camera.position.set(0,1.35,6.5);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const background=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1);background.needsUpdate=true;
  const points=[
    {name:'right glass contact',p:[TANK.x-.002,-.3,0],inside:true},
    {name:'left glass contact',p:[-TANK.x+.002,-.3,0],inside:true},
    {name:'front glass contact',p:[0,-.3,TANK.z-.002],inside:true},
    {name:'rear glass contact',p:[0,-.3,-TANK.z+.002],inside:true},
    {name:'bottom contact',p:[0,-TANK.y+.002,0],inside:true},
    {name:'wet corner',p:[TANK.x-.002,-.3,TANK.z-.002],inside:true},
    {name:'inside glass',p:[TANK.x+.02,-.3,0],inside:false},
    {name:'air above water',p:[0,.2,0],inside:false},
    {name:'outside dry tank',p:[TANK.x+2*WALL+.1,-.3,0],inside:false},
    {name:'open top',p:[0,TANK.y+.08,0],inside:false},
  ];
  const previousTarget=renderer.getRenderTarget(),previousAutoClear=renderer.autoClear;
  const results:{quality:string;name:string;phi?:number;normal?:number[];pass:boolean}[]=[];
  let solver:FluidSolver|undefined,surface:FluidSurface|undefined;
  try{
    for(const quality of ['low','medium','high'] as const){
      solver=new FluidSolver(renderer,quality);surface=new FluidSurface(renderer,solver);
      surface.resize(1,1);surface.render(camera,background);
      const values=surface.inspectField(points.map(point=>new THREE.Vector3(...point.p as [number,number,number])));
      points.forEach((point,i)=>results.push({quality,name:point.name,phi:values[i],pass:Number.isFinite(values[i])&&(point.inside?values[i]<0:values[i]>0)}));
      const normalProbes=[
        {name:'front wall near waterline normal',p:[0,-.025,TANK.z-.001],expected:[0,0,1]},
        {name:'right wall near waterline normal',p:[TANK.x-.001,-.025,0],expected:[1,0,0]},
        {name:'bottom near corner normal',p:[TANK.x-.03,-TANK.y+.001,TANK.z-.05],expected:[0,-1,0]},
        {name:'free surface near front wall normal',p:[0,0,TANK.z-.03],expected:[0,1,0]},
      ];
      const normals=surface.inspectNormals(normalProbes.map(probe=>new THREE.Vector3(...probe.p as [number,number,number])));
      normalProbes.forEach((probe,i)=>results.push({quality,name:probe.name,normal:normals[i].toArray(),pass:normals[i].dot(new THREE.Vector3(...probe.expected as [number,number,number]))>.98}));
      surface.dispose();surface=undefined;solver.dispose();solver=undefined;
    }
    return {passed:results.every(r=>r.pass),checks:results};
  }finally{
    surface?.dispose();solver?.dispose();background.dispose();renderer.setRenderTarget(previousTarget);renderer.autoClear=previousAutoClear;
  }
}
