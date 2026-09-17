import './style.css';
import { WaterScene } from './scene';
import { WaterInput } from './input';
import { WaterToolbar } from './toolbar';
import type { Quality } from './config';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = '<main id="viewport" aria-label="玻璃缸与水：拖动摇晃，点击缸口滴水"></main><div id="status" class="notice" role="status" aria-live="polite"></div><p id="error" role="alert" hidden></p>';
const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const error = document.querySelector<HTMLParagraphElement>('#error')!;
let noticeTimer=0;
const notify = (message: string) => { window.clearTimeout(noticeTimer);status.textContent = message;noticeTimer=window.setTimeout(()=>{status.textContent='';},5000); };
const diagnostics = import.meta.env.DEV && location.pathname === '/diagnostics';

async function start() {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  let scene: WaterScene;
  try { scene = new WaterScene(viewport); }
  catch (e) { error.hidden = false; error.textContent = e instanceof Error ? e.message : '无法初始化三维水体'; return; }
  const input = new WaterInput(scene, notify);
  const toolbar = new WaterToolbar(app,scene,input,notify,()=>{error.hidden=true;});
  scene.onUpdate=toolbar.update;
  input.onModeChange=toolbar.update;
  input.onMotionChange=toolbar.update;
  scene.onWarning = notify;
  scene.onError = message => { error.hidden = false; error.textContent = message; };

  // Development diagnostics have a separate explicit route, never appearing on /.
  if (diagnostics) {
    const qa = document.createElement('aside');
    qa.className = 'qa'; qa.setAttribute('aria-label', '开发验证');
    qa.innerHTML = '<div class="qa-actions"><button data-scenario="rest">静置测试</button><button data-scenario="shake">摇晃测试</button><button data-scenario="impulse">急停波浪测试</button><button data-scenario="tilt">倾倒测试</button><button data-scenario="pour">加水测试</button><button data-scenario="droplet">水滴体积</button><button data-scenario="surface">液面形态</button><button data-scenario="capacity">容量边界测试</button><button data-scenario="stress">两分钟摇晃测试</button></div><div class="qa-actions"><button id="reset">重置</button><button id="pause">暂停</button><button id="motion">体感</button><button id="add-water">滴水</button></div><label>画质<select id="quality"><option value="low">流畅</option><option value="medium">均衡</option><option value="high">细腻</option></select></label><label>水面诊断<select id="debug-surface"><option value="0">正常</option><option value="1">深度</option><option value="2">法线</option><option value="3">厚度</option></select></label><pre id="qa-stats"></pre><p id="qa-message"></p>';
    app.append(qa);
    qa.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach(button => button.addEventListener('click', () => scene.startScenario(button.dataset.scenario!)));
    qa.querySelector<HTMLSelectElement>('#debug-surface')!.addEventListener('change', event => scene.setDebug(Number((event.target as HTMLSelectElement).value)));
    const quality = qa.querySelector<HTMLSelectElement>('#quality')!;
    quality.value = scene.quality;
    quality.addEventListener('change', () => { scene.setQuality(quality.value as Quality); notify('新画质将在重置时生效'); });
    qa.querySelector('#reset')!.addEventListener('click', () => { input.disableMotion(); scene.reset(); error.hidden = true; });
    qa.querySelector('#pause')!.addEventListener('click', () => scene.setPaused(!scene.paused));
    qa.querySelector('#motion')!.addEventListener('click', () => void input.toggleMotion());
    qa.querySelector('#add-water')!.addEventListener('click', () => scene.emitWater());
    scene.onUpdate = () => {
      toolbar.update();
      qa.querySelector('#qa-stats')!.textContent = JSON.stringify({ ...scene.solver.stats, viewAzimuth:scene.controls.getAzimuthalAngle(),viewPolar:scene.controls.getPolarAngle(),tankPosition:scene.position.toArray(),tankTilt:[scene.targetEuler.x,scene.targetEuler.z], paused: scene.paused, motion: input.motionEnabled, quality: scene.quality, pendingQuality: scene.pendingQuality, framesPerSecond: Math.round(scene.fps), simulationRate:scene.simulationRate, surfaceGpuMilliseconds:scene.surfaceGpuMilliseconds, resolutionScale: scene.resolutionScale, textures: scene.renderer.info.memory.textures, scenario: scene.qaResult }, null, 2);
      qa.querySelector('#pause')!.textContent = scene.paused ? '继续' : '暂停';
      qa.querySelector('#qa-message')!.textContent = status.textContent;
    };
  }

  const keyHandler = (event: KeyboardEvent) => {
    if(event.target instanceof Element&&event.target.closest('#toolbar'))return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) return;
    if (event.key === 'Escape') { input.setMode('auto'); return; }
    if (['1', '2', '3'].includes(event.key)) input.setMode((['move', 'tilt', 'drop'] as const)[Number(event.key) - 1]);
    if (event.key.toLowerCase() === 'm') void input.toggleMotion();
    if (event.key.toLowerCase() === 'q') {
      const choices: Quality[] = ['low', 'medium', 'high'];
      scene.setQuality(choices[(choices.indexOf(scene.quality) + 1) % 3]);
      input.disableMotion(); scene.reset(); notify('画质已切换为 ' + scene.quality);
    }
    if (event.key === '+' || event.key === '=') scene.dropRadius = Math.min(.16, scene.dropRadius + .015);
    if (event.key === '-') scene.dropRadius = Math.max(.07, scene.dropRadius - .015);
    toolbar.update();
  };
  document.addEventListener('keydown', keyHandler);

  type Tool = { name: string; description: string; inputSchema: object; execute: (input: unknown) => unknown; annotations: object };
  const context = (document as Document & { modelContext?: { registerTool: (tool: Tool, options: { signal: AbortSignal }) => void | Promise<void> } }).modelContext;
  const lifecycle = new AbortController();
  const validate = (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error('Expected an empty object'); };
  const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  if (context?.registerTool) {
    const tools: Tool[] = [
      { name: 'reset_water', description: 'Reset the visible container to half full, upright, unpaused, and the default view.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async (value) => { validate(value); input.disableMotion(); input.setMode('auto'); scene.reset(); error.hidden = true; await painted(); return { waterPercent: 50 }; }, annotations: { readOnlyHint: false, untrustedContentHint: false } },
      { name: 'add_water_drop', description: 'Add one water drop above the visible container opening.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, execute: async (value) => { validate(value); if (!scene.emitWater()) throw new Error('Water is paused, unavailable, or at capacity'); scene.solver.flushSeeds(); await painted(); return { activeParticles: scene.solver.stats.active }; }, annotations: { readOnlyHint: false, untrustedContentHint: false } },
    ];
    for (const tool of tools) { try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* optional API */ } }
  }
  import.meta.hot?.dispose(() => { window.clearTimeout(noticeTimer);lifecycle.abort();toolbar.dispose(); input.dispose(); scene.dispose(); document.removeEventListener('keydown', keyHandler); });
}
void start();

