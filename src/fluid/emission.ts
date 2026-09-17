/** One marker always represents spacing³ of water, including small drops. */
export function dropParticleCount(radius:number,spacing:number){
  if(!Number.isFinite(radius)||radius<=0||!Number.isFinite(spacing)||spacing<=0)return 0;
  return Math.max(1,Math.round(4*Math.PI/3*(radius/spacing)**3));
}

/** Bounded Poisson sampling avoids nearly coincident markers in a new drop.
 * Hashing keeps large, valid emissions from turning into quadratic work. */
export function dropOffsets(count:number,radius:number,random:()=>number){
  const result=new Float32Array(count*3);
  if(count<=1)return result;
  const separation=.75*Math.cbrt(4*Math.PI/(3*count)),separation2=separation**2;
  const width=Math.ceil(2/separation)+1;
  const buckets=new Map<number,number[]>(),points:number[][]=[];
  const cell=(p:number[])=>p.map(v=>Math.floor((v+1)/separation));
  const key=(x:number,y:number,z:number)=>x+width*(y+width*z);
  const mean=[0,0,0];
  for(let i=0;i<count;i++){
    let selected=[0,0,0],best=-1;
    for(let attempt=0;attempt<128;attempt++){
      let p:number[];
      do{p=[random()*2-1,random()*2-1,random()*2-1];}while(p[0]**2+p[1]**2+p[2]**2>1);
      const c=cell(p);let nearest=separation2;
      for(let x=Math.max(0,c[0]-1);x<=Math.min(width-1,c[0]+1);x++)
        for(let y=Math.max(0,c[1]-1);y<=Math.min(width-1,c[1]+1);y++)
          for(let z=Math.max(0,c[2]-1);z<=Math.min(width-1,c[2]+1);z++){
            for(const index of buckets.get(key(x,y,z))??[]){
              const q=points[index];nearest=Math.min(nearest,(p[0]-q[0])**2+(p[1]-q[1])**2+(p[2]-q[2])**2);
            }
          }
      if(nearest>best){best=nearest;selected=p;}
      if(nearest>=separation2)break;
    }
    points.push(selected);selected.forEach((v,axis)=>mean[axis]+=v/count);
    const c=cell(selected),bucket=key(c[0],c[1],c[2]);
    if(!buckets.has(bucket))buckets.set(bucket,[]);buckets.get(bucket)!.push(i);
  }
  // Keep the specified drop center and radius despite finite sample noise.
  let extent=1;
  for(const p of points)extent=Math.max(extent,Math.hypot(...p.map((v,axis)=>v-mean[axis])));
  points.forEach((p,i)=>p.forEach((v,axis)=>result[i*3+axis]=(v-mean[axis])*radius/extent));
  return result;
}
