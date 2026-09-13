import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// One Wplace tab, the complete userscript, native drafts and controlled incoming peers.
// node scripts/benchmark-wplace-collaboration.mjs <bundle> <output.json> [repeats=3]
const bundle = await readFile(resolve(process.argv[2]), 'utf8')
const output = resolve(process.argv[3])
const repeats = Number(process.argv[4] ?? 3)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const info = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const socket = new WebSocket(info.webSocketDebuggerUrl)
await new Promise((done) => socket.addEventListener('open', done, { once: true }))
let sequence = 0
let sessionId
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
    }, 20000)
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
const prelude = `
const held=new Map([['caelestisProfile','1']]);
const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
Storage.prototype.getItem=function(key){return key.startsWith('caelestis')&&held.has(key)?held.get(key):get.call(this,key)};
Storage.prototype.setItem=function(key,value){if(key.startsWith('caelestis'))held.set(key,String(value));else set.call(this,key,value)};
globalThis.GM_getValue=(key,fallback)=>localStorage.getItem(key)??fallback;
globalThis.GM_setValue=(key,value)=>held.set(key,value);
globalThis.collaborationReplay={socket:null,ready:null};
const NativeWebSocket=globalThis.WebSocket;
globalThis.WebSocket=class extends NativeWebSocket{
 constructor(...args){super(...args);if(new URL(args[0]).pathname.endsWith('/telemetry/presence')){
 collaborationReplay.socket=this;
 this.addEventListener('message',event=>{if(typeof event.data!=='string')return;try{const data=JSON.parse(event.data);if(data.type==='presence-ready')collaborationReplay.ready=data}catch{}})
 }}
};
`
const camera = { center: [-122.797265625, -78.83827746060328], zoom: 15 }
const metrics = async () =>
  Object.fromEntries(
    (await call('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]),
  )
const click = (selector) =>
  evaluate(
    `(()=>{const node=${selector};if(!node)throw new Error('Missing control');node.click()})()`,
  )
let identifier
try {
  const { targetInfos } = await call('Target.getTargets')
  const pages = targetInfos.filter(
    (t) => t.type === 'page' && t.url.startsWith('https://wplace.live/'),
  )
  if (pages.length > 1) throw new Error('Keep only one Wplace tab open for this benchmark')
  const targetId =
    pages[0]?.targetId ?? (await call('Target.createTarget', { url: 'about:blank' })).targetId
  sessionId = (await call('Target.attachToTarget', { targetId, flatten: true })).sessionId
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Performance.enable')
  await call('Emulation.setFocusEmulationEnabled', { enabled: true })
  identifier = (
    await call('Page.addScriptToEvaluateOnNewDocument', {
      source: `if(location.hostname==='wplace.live'){${prelude}\n${bundle}\n}`,
    })
  ).identifier
  await call('Page.navigate', { url: 'https://wplace.live/' })
  for (let load = 0; load < 2; load++) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await evaluate('!!globalThis.__caelestis?.map()&&!!globalThis.collaborationReplay?.ready')
      )
        break
      await sleep(300)
    }
    if (await evaluate('!!globalThis.__caelestis?.map()&&!!globalThis.collaborationReplay?.ready'))
      break
    if (load === 0) await call('Page.reload')
  }
  if (!(await evaluate('!!globalThis.__caelestis?.map()&&!!collaborationReplay.ready')))
    throw new Error('Wplace map or live presence not ready')
  await evaluate(`void __caelestis.map().jumpTo(${JSON.stringify(camera)})`)
  await sleep(8000)
  await click(`document.querySelector('caelestis-rail-control').shadowRoot.querySelector('button')`)
  await sleep(500)
  const runs = []
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const scenario of ['idle', 'painting', 'movement', 'players']) {
      await evaluate(`void __caelestis.map().jumpTo(${JSON.stringify(camera)})`)
      if (scenario === 'painting') {
        await click(
          `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Paint'))`,
        )
        await sleep(600)
        await click(`document.querySelector('button[aria-label^="Black"]')`)
      }
      await evaluate(
        `collaborationReplay.peers=Array.from({length:${scenario === 'players' ? 64 : 1}},(_,i)=>({sessionId:'benchmark-'+i,painter:{wplaceUserId:900000+i,displayName:'Benchmark '+i},viewport:{x:325380+i%8*8,y:1782020+Math.floor(i/8)*8,w:90,h:70},draft:null}));collaborationReplay.socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'presence-delta',online:collaborationReplay.peers.length+1,upsert:collaborationReplay.peers,remove:Array.from({length:64},(_,i)=>'benchmark-'+i)})}))`,
      )
      await sleep(1500)
      const pointer = await evaluate(
        `(()=>{const l=__caelestis.map().getLayer('caelestis-presence').implementation;const i=[...l.retained.values()].find(i=>i.kind==='region');const n=i.mask.mask.indexOf(1);const x=i.rect.x+n%i.rect.w+.5,y=i.rect.y+Math.floor(n/i.rect.w)+.5;return __caelestis.map().project([x/2048000*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y/2048000)))*180/Math.PI])})()`,
      )
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x, y: pointer.y })
      await evaluate(
        `__caelestis.profileReset();__caelestis.profileConfigure({label:${JSON.stringify(scenario)},browserZoomPercent:110})`,
      )
      const before = await metrics()
      for (let tick = 0; tick < 24; tick++) {
        if (scenario === 'painting') {
          await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900 + tick * 4, y: 500 })
          await call('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            buttons: 1,
            clickCount: 1,
            x: 900 + tick * 4,
            y: 500,
          })
          await call('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            buttons: 0,
            clickCount: 1,
            x: 900 + tick * 4,
            y: 500,
          })
        }
        if (scenario === 'movement')
          await evaluate(
            `void __caelestis.map().jumpTo({center:[${camera.center[0] + Math.sin(tick / 3) * 0.002},${camera.center[1]}]})`,
          )
        if (scenario !== 'idle')
          await evaluate(
            `collaborationReplay.socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'presence-delta',online:collaborationReplay.peers.length+1,remove:[],upsert:collaborationReplay.peers.map(p=>({...p,viewport:{...p.viewport,x:p.viewport.x+${tick % 8}},draft:{rect:{x:325410,y:1782050,w:8,h:8},pixels:64,mask:'//////////8='}}))})}))`,
          )
        await sleep(300)
      }
      const after = await metrics()
      const profile = await evaluate('__caelestis.profile()')
      const labels = await evaluate(
        `[...document.querySelectorAll('#caelestis-presence-labels span')].map(n=>({text:n.textContent,transform:n.style.transform}))`,
      )
      runs.push({
        repeat,
        scenario,
        profile,
        labels,
        external: {
          seconds: after.Timestamp - before.Timestamp,
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
            browser: info.Browser,
            camera,
            runs,
          },
          null,
          2,
        ),
      )
      console.log(
        `${repeat + 1}/${repeats} ${scenario}: ${runs.at(-1).external.taskSeconds.toFixed(3)} CPU seconds; peers=${profile.context.current.collaboration.peers}; labels=${labels.length}`,
      )
      const shot = await call('Page.captureScreenshot', { format: 'png' })
      await writeFile(`${output}.${repeat}-${scenario}.png`, Buffer.from(shot.data, 'base64'))
      if (scenario === 'painting') {
        await click(`document.querySelector('button[aria-label="Close"]')`)
        await sleep(500)
      }
    }
  await evaluate(
    `collaborationReplay.socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'presence-delta',online:collaborationReplay.ready.online,upsert:[],remove:Array.from({length:64},(_,i)=>'benchmark-'+i)})}))`,
  )
} finally {
  if (identifier) await call('Page.removeScriptToEvaluateOnNewDocument', { identifier })
  if (sessionId) await call('Emulation.setFocusEmulationEnabled', { enabled: false })
  socket.close()
}
