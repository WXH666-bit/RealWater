import type { WaterScene } from './scene';
import type { WaterInput } from './input';
import type { Quality } from './config';
import {FISH_KINDS,FISH_NAMES,FISH_LIMIT} from './aquarium';

const paths={
  move:'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  tilt:'m7 3 12 4-4 14-12-4L7 3Zm-1 9 10 3',
  drop:'M12 3S5.5 10 5.5 14a6.5 6.5 0 0 0 13 0C18.5 10 12 3 12 3Z',
  orbit:'M20 10a8 8 0 1 0 0 5M20 4v6h-6M12 8v8M8 12h8',
  pour:'M7 3h10M9 3v5l-4 7a4 4 0 0 0 3.5 6h7a4 4 0 0 0 3.5-6l-4-7V3M7 14h10',
  pause:'M8 5v14M16 5v14',
  reset:'M4 10a8 8 0 1 1 0 5M4 4v6h6',
  settings:'M4 7h16M4 17h16M8 4v6M16 14v6',
  motion:'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1ZM11 18h2M3 7v10M21 7v10',
};
const icon=(name:keyof typeof paths)=>`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]}"/></svg>`;

export class WaterToolbar {
  private element=document.createElement('header');
  private abort=new AbortController();
  constructor(host:HTMLElement,private scene:WaterScene,private input:WaterInput,notify:(text:string)=>void,onReset:()=>void){
    const el=this.element;el.id='toolbar';el.setAttribute('aria-label','水体操作');
    const mode=(value:string,label:string,name:keyof typeof paths,title:string)=>`<button type="button" data-mode="${value}" aria-pressed="false" title="${title}">${icon(name)}<span>${label}</span></button>`;
    el.innerHTML=`
      <div class="tool-main">
        <div class="mode-switch" role="group" aria-label="操作模式">
          ${mode('auto','移动','move','拖容器摇晃；拖空白处旋转视角')}
          ${mode('tilt','倾斜','tilt','拖动倾斜容器，方向跟随当前视角')}
          ${mode('drop','滴水','drop','点击缸口滴水；按住持续加水')}
          ${mode('orbit','旋转','orbit','拖动画面 360° 旋转视角；捏合或滚轮缩放')}
        </div>
        <div class="tool-actions" role="group" aria-label="水体控制">
          <button type="button" data-action="drop" title="向缸口加入一滴水">${icon('drop')}<span>加一滴</span></button>
          <button type="button" data-action="pour" aria-pressed="false" title="持续向缸口加水，再次点击停止">${icon('pour')}<span>加水</span></button>
          <button type="button" data-action="pause" aria-pressed="false" title="暂停或继续模拟">${icon('pause')}<span>暂停</span></button>
          <button type="button" data-action="reset" title="恢复半缸水、正立容器和默认视角">${icon('reset')}<span>重置</span></button>
        </div>
      </div>
      <div class="tool-secondary">
        <details class="tool-settings aquarium-menu">
          <summary title="添加小鱼，打造自己的水族馆"><span>生物</span></summary>
          <div class="settings-popover aquarium-popover">
            <div class="aquarium-heading"><strong>小小水族馆</strong><output id="fish-count" aria-live="polite">0 / 12</output></div>
            <p class="aquarium-intro">添一位水下住客，看它自在游动。</p>
            ${FISH_KINDS.map(kind=>`<button type="button" data-fish="${kind}" aria-label="添加${FISH_NAMES[kind]}"><span class="fish-preview ${kind}" aria-hidden="true"></span><span>${FISH_NAMES[kind]}</span><span class="fish-add" aria-hidden="true">＋</span></button>`).join('')}
            <button type="button" data-action="clear-fish">清空生物</button>
            <p>重置会保留小鱼。水域不足时，小鱼会自动收回。</p>
          </div>
        </details>
        <button type="button" data-action="motion" aria-pressed="false" title="开启手机体感并以当前姿势校准">${icon('motion')}<span>体感</span></button>
        <details class="tool-settings">
          <summary title="水滴大小、画质和操作说明">${icon('settings')}<span>设置</span></summary>
          <div class="settings-popover">
            <label for="drop-size">水滴大小 <output id="drop-size-value">中</output></label>
            <input id="drop-size" type="range" min="0.07" max="0.16" step="0.005" value="0.12" />
            <label for="render-quality">画质</label>
            <select id="render-quality"><option value="low">流畅</option><option value="medium">均衡</option><option value="high">细腻</option></select>
            <p class="quality-note" hidden></p>
            <p class="gesture-note">右键拖动也可旋转视角。手机双指倾斜，捏合缩放；旋转模式下双指转动视角。</p>
          </div>
        </details>
      </div>`;
    host.append(el);
    const options={signal:this.abort.signal};
    FISH_KINDS.forEach(kind=>el.querySelector<HTMLButtonElement>(`[data-fish="${kind}"]`)!.addEventListener('click',()=>scene.addFish(kind),options));
    this.button('clear-fish').addEventListener('click',()=>{scene.clearFish();notify('已清空生物');},options);
    el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button=>button.addEventListener('click',()=>{
      input.setMode(button.dataset.mode as WaterInput['mode']);
    },options));
    this.button('drop').addEventListener('click',()=>scene.emitWater(),options);
    this.button('pour').addEventListener('click',()=>scene.setContinuousPour(!scene.isContinuouslyPouring),options);
    this.button('pause').addEventListener('click',()=>scene.setPaused(!scene.paused),options);
    this.button('reset').addEventListener('click',()=>{input.disableMotion();input.setMode('auto');scene.reset();onReset();notify('已恢复半缸水和默认视角');},options);
    this.button('motion').addEventListener('click',()=>void input.toggleMotion(),options);
    el.querySelector<HTMLInputElement>('#drop-size')!.addEventListener('input',event=>{
      scene.dropRadius=Number((event.target as HTMLInputElement).value);this.update();
    },options);
    el.querySelector<HTMLSelectElement>('#render-quality')!.addEventListener('change',event=>{
      scene.setQuality((event.target as HTMLSelectElement).value as Quality);this.update();
    },options);
    const panels=Array.from(el.querySelectorAll<HTMLDetailsElement>('details'));
    document.addEventListener('pointerdown',event=>{panels.forEach(details=>{if(!details.contains(event.target as Node))details.open=false;});},options);
    panels.forEach(details=>{
      details.addEventListener('toggle',()=>{if(details.open)panels.forEach(other=>{if(other!==details)other.open=false;});},options);
      details.addEventListener('keydown',event=>{if(event.key==='Escape'&&details.open){details.open=false;details.querySelector('summary')!.focus();event.stopPropagation();}},options);
    });
    this.update();
  }
  private button(name:string){return this.element.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;}
  update=()=>{
    const {scene,input}=this;
    this.element.querySelector('#fish-count')!.textContent=`${scene.fishCount} / ${FISH_LIMIT}`;
    this.element.querySelectorAll<HTMLButtonElement>('[data-fish]').forEach(button=>{button.disabled=scene.fishCount>=FISH_LIMIT;});
    this.button('clear-fish').disabled=scene.fishCount===0;
    this.element.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button=>{
      button.setAttribute('aria-pressed',String(button.dataset.mode===(input.mode==='move'?'auto':input.mode)));
    });
    const toggle=(name:string,active:boolean,label:string)=>{const button=this.button(name);button.setAttribute('aria-pressed',String(active));button.querySelector('span')!.textContent=label;};
    toggle('pause',scene.paused,scene.paused?'继续':'暂停');
    this.button('pause').querySelector('path')!.setAttribute('d',scene.paused?'m8 5 11 7-11 7V5':paths.pause);
    toggle('pour',scene.isContinuouslyPouring,scene.isContinuouslyPouring?'停止加水':'加水');
    toggle('motion',input.motionEnabled,input.motionEnabled?'关闭体感':'体感');
    this.button('drop').disabled=scene.paused;this.button('pour').disabled=scene.paused;
    this.element.querySelector<HTMLInputElement>('#drop-size')!.value=String(scene.dropRadius);
    this.element.querySelector('#drop-size-value')!.textContent=scene.dropRadius<.1?'小':scene.dropRadius>.135?'大':'中';
    this.element.querySelector<HTMLSelectElement>('#render-quality')!.value=scene.pendingQuality??scene.quality;
    const note=this.element.querySelector<HTMLParagraphElement>('.quality-note')!;
    note.hidden=!scene.pendingQuality;note.textContent=scene.pendingQuality?'点击「重置」后应用新画质。':'';
  };
  dispose(){this.abort.abort();this.element.remove();}
}
