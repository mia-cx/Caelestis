// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createAllianceContext } from './alliance-context.js'
import { installPageRequestObserver, observePageRequests } from './page-requests.js'

const BACKEND = 'https://backend.wplace.live'
const DRAFT = `${BACKEND}/alliance/assets/drafts/5/canvas`
/** The banner editor's artboard is mounted, its native canvas banner-sized. */
const BANNER_EDITOR = { headquarters: false, asset: { canvasKind: 'alliance-banner' } } as const

const teardown: (() => void)[] = []

afterEach(() => {
  for (const undo of teardown.splice(0).reverse()) undo()
})

/** A context observing a backend that knows alliance 7 and banner draft 5. */
const bannerContext = () => {
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    const body = path === '/alliance' ? { id: 7 } : { draftId: 5, assetType: 'banner' }
    return new Response(JSON.stringify(body))
  }) as typeof fetch
  const requests = installPageRequestObserver(window)
  const context = createAllianceContext(() => {})
  const stop = observePageRequests(context.route)
  teardown.push(() => requests?.restore(), stop)
  return context
}

const settle = () => new Promise((resolve) => setTimeout(resolve))

it('keeps the open draft resolved while Wplace polls and reloads it', async () => {
  const context = bannerContext()
  await window.fetch(`${BACKEND}/alliance`)
  await window.fetch(`${DRAFT}?metadataOnly=true`)
  await settle()
  const opened = context.resolve(BANNER_EDITOR)
  expect(opened).toMatchObject({ surface: { kind: 'alliance-banner', allianceId: 7 }, draftId: 5 })

  await window.fetch(`${DRAFT}?metadataOnly=true`)
  expect(context.resolve(BANNER_EDITOR)).toEqual(opened)
  await window.fetch(DRAFT)
  expect(context.resolve(BANNER_EDITOR)).toEqual(opened)
  await settle()

  expect(context.resolve(BANNER_EDITOR)).toEqual(opened)
})
