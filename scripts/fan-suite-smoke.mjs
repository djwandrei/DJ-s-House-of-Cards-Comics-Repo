// Offline browser checks: no credentials, commerce data, or real game writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { palettes, themeFor } from '../tools/basketball-palettes.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd(), output = path.join(root, 'outputs/fan-suite');
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.ttf':'font/ttf', '.json':'application/json' };
const shared = new Set(['core.js','nav.js','theme-init.js','styles.css','styles-mobile-overrides.css']);
const server = createServer(async (req,res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '');
    if (rel.endsWith('/')) rel += 'index.html';
    if (['backend-config.js','supabase-client.js','analytics.js'].includes(rel)) {
      res.writeHead(200,{'Content-Type':'text/javascript'});
      res.end('window.DJ ||= {}; window.DJ.remoteCatalog = { getSession: async () => null, invokeFunction: async () => { throw new Error("Offline check"); } };'); return;
    }
    const file = path.resolve(root,rel);
    if (!file.startsWith(root+path.sep) || !types[path.extname(file)] || !(shared.has(rel) || ['tools/','assets/','lineup-lab/'].some(prefix => rel.startsWith(prefix)))) throw Error();
    res.writeHead(200,{'Content-Type':types[path.extname(file)],'Cache-Control':'no-store'}); res.end(await fs.readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true });
const report = { checks:[], errors:[], missing:[], contrastReview:[] };
const routes = ['tools/','tools/fix-the-five/','tools/draft-night/','tools/player-card-matchups/','tools/workshop/','lineup-lab/'];
async function changeMode(page, mode) {
  if (!(await page.locator('.court-style').getAttribute('open'))) {
    if (!await page.locator('.court-style').evaluate(node=>node.open)) await page.locator('.court-style>summary').click();
  }
  await page.locator(`[data-court-mode=${mode}]`).click();
  await page.waitForFunction(mode=>document.body.dataset.courtMode===mode,mode);
  await page.keyboard.press('Escape');
}
async function overflow(page) {
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page-level horizontal overflow');
}
// Review low-contrast text on solid surfaces. Photo/gradient surfaces are
// excluded and inspected in screenshots, not given a false computed pass.
async function reviewContrast(page,label) {
  const rows = await page.evaluate(()=>{
    const rgb=s=>s.match(/[\d.]+/g)?.map(Number);
    const lum=a=>{const c=a.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
    const found=[];
    for(const el of document.querySelectorAll('main *')) {
      if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()) || !el.checkVisibility({checkVisibilityCSS:true}) || el.closest('[hidden],.hero,.page-hero-card,.court-style:not([open])'))continue;
      const style=getComputedStyle(el); if(Number(style.opacity)<1 || el.closest(':disabled'))continue;
      let bg=null, mixed=false;
      for(let node=el;node;node=node.parentElement) {
        const s=getComputedStyle(node); if(s.backgroundImage!=='none'){mixed=true;break;}
        const c=rgb(s.backgroundColor); if(c?.length===3||c?.[3]===1){bg=c;break;} if(c?.[3]>0){mixed=true;break;}
      }
      if(!bg||mixed)continue;
      const fg=rgb(style.color);if(!fg)continue;
      const ratio=(Math.max(lum(fg),lum(bg))+.05)/(Math.min(lum(fg),lum(bg))+.05);
      const size=parseFloat(style.fontSize), bold=parseInt(style.fontWeight)>=700;
      const threshold=size>=24||(size>=18.66&&bold)?3:4.5;
      if(ratio+0.01<threshold)found.push({text:el.textContent.trim().slice(0,70),class:el.className,ratio:Number(ratio.toFixed(2)),fg:style.color,bg:bg.slice(0,3)});
    }return found.slice(0,45);
  });
  if(rows.length) report.contrastReview.push({label,rows});
}
try {
  await fs.mkdir(output,{recursive:true});
  for(const width of [320,390,900,1440]) for(const mode of ['dark','light']) {
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',hasTouch:width<=390});
    await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
    await context.addInitScript(mode=>localStorage.setItem('theme',mode),mode);
    const page=await context.newPage(); page.on('pageerror',e=>report.errors.push(e.message));
    page.on('response',r=>{if(r.status()===404&&/basketball-theme|basketball-palettes|lab-theme|assets\/fonts\/(manrope|barlow)/.test(r.url()))report.missing.push(r.url());});
    for(const route of routes) {
      await page.goto(base+'/'+route);
      await page.waitForFunction(()=>document.body.dataset.courtPalette);
      await page.evaluate(()=>document.fonts.ready);
      assert.ok(await page.evaluate(()=>document.fonts.check('16px Manrope') && document.fonts.check('700 24px "Barlow Condensed"')),'Both local fonts loaded');
      assert.equal(await page.locator('.court-destinations a[aria-current=page]').count(),1);
      await overflow(page);
      await changeMode(page,mode==='dark'?'light':'dark'); await changeMode(page,mode);
      assert.equal(await page.evaluate(()=>localStorage.getItem('theme')),mode);
      if(route==='tools/workshop/') {
        await page.locator('#experiencePicker').selectOption('scouts-call');
        await page.locator('#experiencePicker').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
        assert.ok(await page.locator('#workshopFields select').count());
        await page.locator('#workshopSetupForm button[type=submit]').click();
      }
      await reviewContrast(page,`${route} ${width} ${mode}`);
      await page.evaluate(()=>scrollTo(0,0));
      if([390,1440].includes(width)) await page.screenshot({path:path.join(output,`${route.replaceAll('/','-')}${width}-${mode}.png`)});
      await overflow(page); report.checks.push(`${route} ${width} ${mode}`);
    }
    await context.close();
  }
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage(); page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base+'/lineup-lab/');
  await page.waitForFunction(()=>document.querySelector('#datasetCount')?.textContent==='15'&&document.querySelector('.journey-draft-status')?.textContent.includes('saved'));
  assert.equal(await page.locator('body').getAttribute('data-court-mode'),'dark','New visits default to dark');
  // Inject only selector options, never player data. Test the actual change
  // listener and ensure appearance does not rewrite rules or the loaded pool.
  await page.locator('#nbaTeamInput').evaluate((select,palettes)=>{
    for(const p of palettes) {const option=new Option(p.team,p.id.toUpperCase());select.add(option);}
  },palettes);
  const original=await page.locator('#modeInput,#sizeInput,#minGuardsInput,#minForwardsInput,#minCentersInput').evaluateAll(inputs=>inputs.map(i=>i.value));
  for(const mode of ['light','dark']) {
    await changeMode(page,mode);
    for(const palette of palettes) {
      await page.locator('#nbaTeamInput').selectOption(palette.id.toUpperCase());
      const actual=await page.locator('body').evaluate(el=>({palette:el.dataset.courtPalette,accent:el.style.getPropertyValue('--court-accent'),mode:el.dataset.courtMode}));
      assert.deepEqual(actual,{palette:palette.id,accent:themeFor(palette,mode).accent,mode});
    }
  }
  assert.deepEqual(await page.locator('#modeInput,#sizeInput,#minGuardsInput,#minForwardsInput,#minCentersInput').evaluateAll(inputs=>inputs.map(i=>i.value)),original);
  assert.equal(await page.locator('#datasetCount').textContent(),'15');
  report.checks.push('62 live-selector palette/mode mappings; roster and rules unchanged');
  // Reload the unmodified demo controls to exercise the real guided workflow.
  await page.reload(); await page.waitForFunction(()=>document.querySelector('#datasetCount')?.textContent==='15');
  await page.locator('#workflowNext').click();
  await page.waitForFunction(()=>document.querySelector('[data-workflow-stage=plan]')?.getAnimations().length>0);
  const forward=await page.locator('[data-workflow-stage=plan]').evaluate(el=>el.getAnimations()[0].effect.getKeyframes()[0].transform);
  assert.equal(forward,'translateX(20px)');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.waitForFunction(()=>document.querySelector('[data-workflow-stage=plan]').getAnimations().length===0);
  await page.locator('#workflowBack').click();
  assert.equal(await page.evaluate(()=>document.activeElement.id),'workflowHeading');
  assert.ok(await page.locator('[data-workflow-stage=plan]').evaluate(el=>el.hidden&&el.inert));
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('#workflowNext').click(); await page.locator('#workflowBack').click();
  const back=await page.locator('[data-workflow-stage=team]').evaluate(el=>el.getAnimations()[0]?.effect.getKeyframes()[0].transform);
  assert.equal(back,'translateX(-20px)');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator('#workflowNext').click();
  await page.locator('#detailedModeButton').click();
  await reviewContrast(page,'Lab detailed plan dark');
  await page.screenshot({path:path.join(output,'lab-plan-dark.png')});
  for(const step of ['players','rules','review']) {
    await page.locator('#workflowNext').click();
    assert.ok(await page.locator(`[data-workflow-stage=${step}]`).isVisible());
    await reviewContrast(page,`Lab ${step} dark`);
    await page.screenshot({path:path.join(output,`lab-${step}-dark.png`)});
  }
  await page.locator('#optimizeButton').click();
  await page.waitForFunction(()=>!document.querySelector('#results').hidden,{timeout:30000});
  await reviewContrast(page,'Lab result dark');
  await page.screenshot({path:path.join(output,'lab-result-dark.png')});
  await page.locator('#results details').evaluateAll(nodes=>nodes.forEach(node=>{node.open=true;}));
  await reviewContrast(page,'Lab expanded result dark');
  await page.screenshot({path:path.join(output,'lab-expanded-result-dark.png')});
  await changeMode(page,'light');
  await reviewContrast(page,'Lab expanded result light');
  await page.screenshot({path:path.join(output,'lab-expanded-result-light.png')});
  await page.emulateMedia({media:'print'});
  assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).getPropertyValue('--court-text').trim()),'#111');
  assert.ok(await page.locator('.court-toolbar').isHidden());
  await page.emulateMedia({media:'screen'});
  await page.locator('#workflowRerun').click();
  await page.evaluate(()=>{Element.prototype.animate=undefined;});
  await page.locator('#workflowBack').click();
  assert.ok(await page.locator('[data-workflow-stage=rules]').isVisible());
  report.checks.push('Forward/back step motion, focus, hidden/inert panels, live reduced-motion cancellation');
  await context.close();
  assert.deepEqual(report.errors,[]); assert.deepEqual(report.missing,[]);
  assert.deepEqual(report.contrastReview,[], 'Solid-surface text needs contrast review');
  report.status='passed';
} finally {
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  await browser.close(); await new Promise(resolve=>server.close(resolve));
}
console.log(JSON.stringify(report,null,2));
