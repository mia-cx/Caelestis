import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'

// Status shards and presence rooms read their identity from `ctx.id.name`, including when an alarm
// or a hibernated socket is what wakes them.
const script = `
import { DurableObject } from 'cloudflare:workers'
export class Named extends DurableObject {
  idName() { return this.ctx.id.name ?? null }
  async fetch() { return new Response(this.ctx.id.name ?? '') }
  async arm() { await this.ctx.storage.setAlarm(Date.now()) }
  async alarm() { await this.ctx.storage.put('woken as', this.ctx.id.name ?? null) }
  wokenAs() { return this.ctx.storage.get('woken as') }
}
export default {
  async fetch(request, env) {
    const object = env.NAMED.getByName('7:world')
    switch (new URL(request.url).pathname) {
      case '/rpc': return Response.json(await object.idName())
      case '/fetch': return object.fetch('https://object.test/')
      case '/arm': await object.arm(); return new Response(null, { status: 204 })
      default: return Response.json((await object.wokenAs()) ?? null)
    }
  },
}`

const runtimes: Miniflare[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
})

it('names a Durable Object reached by getByName in every handler', async () => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: '2026-08-03',
      durableObjects: { NAMED: { className: 'Named', useSQLite: true } },
    }),
  )
  runtimes.push(runtime)
  const read = async (path: string) =>
    (await runtime.dispatchFetch(`https://worker.test${path}`)).text()
  expect(await read('/rpc')).toBe('"7:world"')
  expect(await read('/fetch')).toBe('7:world')
  await read('/arm')
  await expect.poll(() => read('/woken'), { timeout: 5_000 }).toBe('"7:world"')
})
