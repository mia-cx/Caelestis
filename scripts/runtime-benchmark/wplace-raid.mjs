import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Invoked through benchmark-wplace-collaboration.mjs bundle output repeats --raid.
const bundle = await readFile(resolve(process.argv[2]), 'utf8')
const output = resolve(process.argv[3])
const repeats = Number(process.argv[4] ?? 3)
assert(Number.isInteger(repeats) && repeats > 0)
const expectedTemplates = Number(process.env.RAID_TEMPLATES)
const hoverMs = Number(process.env.RAID_HOVER_MS ?? 30000)
assert(Number.isFinite(hoverMs) && hoverMs >= 1000)
assert(
  Number.isInteger(expectedTemplates) && expectedTemplates > 0,
  'Set RAID_TEMPLATES to the expected fully loaded template count',
)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const camera = { center: [-122.797265625, -78.83827746060328], zoom: 15 }
const info = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const socket = new WebSocket(info.webSocketDebuggerUrl)
await new Promise((done) => socket.addEventListener('open', done, { once: true }))
let sequence = 0
let sessionId
let targetId
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const event = JSON.parse(data)
  const job = pending.get(event.id)
  if (!job) return
  pending.delete(event.id)
  clearTimeout(job.timer)
  if (event.error) job.reject(new Error(JSON.stringify(event.error)))
  else job.resolve(event.result)
})
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 30000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

// Stored credentials never leave the page. Reads use the existing configuration, while all
// userscript storage writes and non-Wplace socket/HTTP mutations stay inside this test tab.
const prelude = `
const held = new Map([['caelestisProfile','1']]);
const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
Storage.prototype.getItem = function(key) { return key.startsWith('caelestis') && held.has(key) ? held.get(key) : get.call(this,key) };
Storage.prototype.setItem = function(key,value) { if(key.startsWith('caelestis')) held.set(key,String(value)); else set.call(this,key,value) };
Storage.prototype.removeItem = function(key) { if(key.startsWith('caelestis')) held.set(key,null); else remove.call(this,key) };
globalThis.GM_getValue = (key,fallback) => localStorage.getItem(key) ?? fallback;
globalThis.GM_setValue = (key,value) => held.set(key,value);
globalThis.GM_deleteValue = key => held.set(key,null);
const replay = globalThis.raidReplay = { sockets:[], blocked:0, tick:0, reads:[] };
replay.regions = season => Array.from({length:37},(_,i) => {
 const rect={x:325380+(i%7)*180,y:1782020+Math.floor(i/7)*180,w:140,h:140};
 return {id:'raid-claim-'+i,season,surface:{kind:'world',allianceId:null},templateId:null,claimant:{wplaceUserId:900000+i,displayName:'Benchmark '+i},document:{items:[{id:'outer',op:'add',shape:{kind:'rectangle',...rect}},{id:'hole',op:'subtract',shape:{kind:'rectangle',x:rect.x+50,y:rect.y+50,w:20,h:20}}]},rect,label:'Claim '+i,createdAt:1700000000000,expiresAt:1900000000000};
});
replay.peers = tick => Array.from({length:10},(_,i) => ({sessionId:'raid-peer-'+i,publisherId:'01950000-0000-7000-8000-'+String(i).padStart(12,'0'),painter:{wplaceUserId:910000+i,displayName:'Peer '+i},viewport:{x:325350+(i%4)*20+tick%8,y:1782010+Math.floor(i/4)*20,w:90,h:70},draft:null}));
replay.emit = (ws,event) => ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event)}));
const NativeWebSocket = globalThis.WebSocket;
class ReplaySocket extends EventTarget {
 static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
 readyState=0; bufferedAmount=0; binaryType='blob';
 constructor(url,protocols) {
  super(); this.url=String(url);this.protocol=this.url.includes('/telemetry/live')?'caelestis.live.v1':Array.isArray(protocols)?protocols[0]:(protocols??'');this.season=Number(new URL(url).searchParams.get('season')??0);
  replay.sockets.push(this);
  setTimeout(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));if(this.url.includes('/telemetry/presence'))replay.emit(this,{type:'presence-ready',sessionId:'raid-self',online:11,peers:replay.peers(0),regions:replay.regions(this.season),ownedRegionIds:[],canWrite:false})},20);
 }
 send(data) { replay.blocked++;if(data==='ping')queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:'pong'}))) }
 close() { if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:1000,wasClean:true})) }
}
globalThis.WebSocket = class extends ReplaySocket {
 constructor(url,protocols) { if(new URL(url).hostname.endsWith('wplace.live')) return new NativeWebSocket(url,protocols); super(url,protocols) }
};
const nativeFetch=globalThis.fetch;
globalThis.fetch=async function(input,init) {
 const url=new URL(typeof input==='string'?input:input.url??input,location.href);
 const method=init?.method??input.method??'GET';
 if(!url.hostname.endsWith('wplace.live')) {
  if(!['GET','HEAD'].includes(method.toUpperCase())) { replay.blocked++;return new Response('{}',{status:403,headers:{'content-type':'application/json'}}) }
  if(url.pathname.includes('/work/regions'))return Response.json({regions:replay.regions(Number(url.searchParams.get('season')??0)),ownedRegionIds:[],canWrite:false});
 }
 const response=await nativeFetch.call(this,input,init);
 if(!url.hostname.endsWith('wplace.live'))replay.reads.push({path:url.pathname,status:response.status});
 return response;
};
replay.publish=()=>{const tick=replay.tick++;for(const ws of replay.sockets){if(ws.readyState!==1||!ws.url.includes('/telemetry/presence'))continue;replay.emit(ws,{type:'regions',regions:replay.regions(ws.season),ownedRegionIds:[]});replay.emit(ws,{type:'presence-delta',online:11,upsert:replay.peers(tick),remove:[]})}};
`
const metrics = async () =>
  Object.fromEntries(
    (await call('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
  )
let pressed = false
try {
  targetId = (await call('Target.createTarget', { url: 'about:blank', background: true })).targetId
  sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId
  await call('Page.enable')
  await call('Performance.enable')
  await call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await call('Emulation.setCPUThrottlingRate', { rate: Number(process.env.RAID_CPU_RATE ?? 1) })
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `if(location.hostname==='wplace.live'){${prelude}\n${bundle}\n}`,
  })
  await call('Page.navigate', { url: 'https://wplace.live/' })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (
      await evaluate(
        '!!globalThis.__caelestis?.map() && globalThis.raidReplay?.sockets.some(s=>s.url.includes("/telemetry/presence"))',
      )
    )
      break
    await sleep(500)
  }
  assert(
    await evaluate(
      '!!globalThis.__caelestis?.map() && raidReplay.sockets.some(s=>s.url.includes("/telemetry/presence"))',
    ),
    'Map or replay presence did not connect',
  )
  await evaluate(`void __caelestis.map().jumpTo(${JSON.stringify(camera)})`)
  // Set controls through the same UI intent as a user; persistence is tab-local above.
  await evaluate(
    `(()=>{document.querySelector('caelestis-rail-control').shadowRoot.querySelector('button').click();const panel=document.querySelector('caelestis-panel');for(const key of ['showPresence','showPresenceClaims','showPresenceViewports'])panel.dispatchEvent(new CustomEvent('caelestis-panel-intent',{detail:{type:'settings',intent:{type:'set-boolean',key,value:true}}}));document.querySelector('caelestis-rail-control').shadowRoot.querySelector('button').click()})()`,
  )
  await sleep(5000)
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await evaluate('__caelestis.templates().length')) === expectedTemplates) break
    await sleep(500)
  }
  assert.equal(
    await evaluate('__caelestis.templates().length'),
    expectedTemplates,
    `Template workload did not finish loading: ${JSON.stringify(await evaluate('raidReplay.reads'))}`,
  )
  const templateSignature = await evaluate('JSON.stringify(__caelestis.templates())')
  const templateSha256 = createHash('sha256').update(templateSignature).digest('hex')
  const environment = await evaluate(
    '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scale:visualViewport.scale})',
  )
  const runs = []
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const scenario of (process.env.RAID_SCENARIOS ?? 'hover,movement,idle').split(',')) {
      await evaluate(
        `void __caelestis.map().jumpTo(${JSON.stringify(camera)});raidReplay.tick=0;raidReplay.publish()`,
      )
      await sleep(1000)
      const point = await evaluate(
        `(()=>{const map=__caelestis.map();const p=map.project([325395/2048000*360-180,Math.atan(Math.sinh(Math.PI*(1-2*1782035/2048000)))*180/Math.PI]);const b=map.getCanvas().getBoundingClientRect();return{x:p.x+b.left,y:p.y+b.top}})()`,
      )
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      await evaluate(
        `__caelestis.profileReset();__caelestis.profileConfigure({label:${JSON.stringify(scenario)},browserZoomPercent:Math.round(devicePixelRatio*100)});${scenario === 'idle' ? '' : 'raidReplay.timer=setInterval(raidReplay.publish,300)'}`,
      )
      const before = await metrics()
      const start = Date.now()
      const dispatchDelayMs = []
      const at = async (offset) => {
        await sleep(Math.max(0, start + offset - Date.now()))
        const late = Math.max(0, Date.now() - start - offset)
        dispatchDelayMs.push(late)
        assert(late < 200, `Input driver is ${late} ms late; reject this comparison`)
      }
      if (scenario === 'movement') {
        // Input acknowledgements wait for the renderer. Keep sending at wall-clock cadence
        // so a slower build receives the same workload instead of stretching the camera path.
        const inputs = []
        const dispatch = (params) => {
          const input = call('Input.dispatchMouseEvent', params)
          input.catch(() => {}) // Observed by Promise.all after the scheduled path.
          inputs.push(input)
        }
        for (let round = 0; round < 8; round++) {
          await at(round * 1500)
          const p = { x: 720, y: 450 },
            sign = round % 2 ? -1 : 1
          dispatch({ type: 'mouseMoved', ...p })
          dispatch({
            type: 'mousePressed',
            ...p,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          })
          pressed = true
          for (let step = 1; step <= 12; step++) {
            await at(round * 1500 + step * 35)
            dispatch({
              type: 'mouseMoved',
              x: p.x + sign * step * 10,
              y: p.y + Math.sin(step / 4) * 40,
              button: 'left',
              buttons: 1,
            })
          }
          dispatch({
            type: 'mouseReleased',
            x: p.x + sign * 120,
            y: p.y + Math.sin(3) * 40,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          })
          pressed = false
          dispatch({
            type: 'mouseWheel',
            ...p,
            deltaX: 0,
            deltaY: sign * 100,
          })
        }
        await at(12000)
        await Promise.all(inputs)
      } else await sleep(scenario === 'hover' ? hoverMs : 10000)
      await evaluate('clearInterval(raidReplay.timer)')
      const after = await metrics()
      const profile = await evaluate('__caelestis.profile()')
      assert.equal(
        await evaluate('JSON.stringify(__caelestis.templates())'),
        templateSignature,
        'Template workload changed during sampling',
      )
      const currentEnvironment = profile.context.current.environment
      assert.equal(currentEnvironment.viewport.width, environment.width, 'Viewport changed')
      assert.equal(currentEnvironment.devicePixelRatio, environment.dpr, 'DPR changed')
      assert.equal(
        profile.context.current.collaboration.regions,
        37,
        'Claim replay was not rendered',
      )
      assert.equal(profile.context.current.collaboration.peers, 10, 'Peer replay was not rendered')
      const labels = await evaluate(
        '[...document.querySelectorAll("#caelestis-presence-labels span")].map(n=>({text:n.textContent,transform:n.style.transform}))',
      )
      runs.push({
        repeat,
        scenario,
        elapsedMs: (after.Timestamp - before.Timestamp) * 1000,
        dispatchDelayMs,
        profile,
        labels,
        external: {
          taskSeconds: after.TaskDuration - before.TaskDuration,
          scriptSeconds: after.ScriptDuration - before.ScriptDuration,
          layoutSeconds: after.LayoutDuration - before.LayoutDuration,
          heapBytes: after.JSHeapUsedSize,
        },
      })
      await mkdir(dirname(output), { recursive: true })
      await writeFile(
        output,
        JSON.stringify(
          {
            bundleSha256: createHash('sha256').update(bundle).digest('hex'),
            workloadSha256: createHash('sha256')
              .update(prelude)
              .update(String(hoverMs))
              .digest('hex'),
            hoverMs,
            browser: info.Browser,
            camera,
            environment,
            templateSha256,
            runs,
          },
          null,
          2,
        ),
      )
      console.log(
        `${repeat + 1}/${repeats} ${scenario}: ${runs.at(-1).external.taskSeconds.toFixed(3)} main-thread task seconds; claims=${profile.context.current.collaboration.regions}; labels=${labels.length}`,
      )
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}.${repeat}-${scenario}.png`, Buffer.from(shot.data, 'base64'))
    }
} finally {
  if (pressed)
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: 720,
      y: 450,
      button: 'left',
      buttons: 0,
    })
  if (targetId) {
    sessionId = undefined
    await call('Target.closeTarget', { targetId })
  }
  socket.close()
}
