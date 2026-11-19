// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  type ActiveAllianceSurface,
  installAllianceSurfaceObserver,
  onActiveAllianceSurfaceChange,
  resetAllianceSurfaceObserver,
} from './alliance-surface.js'
import type { InstalledValueHook } from './page-hooks.js'
import { installPageRequestObserver } from './page-requests.js'

const BACKEND = 'https://backend.wplace.live'
const DRAFT = `${BACKEND}/alliance/assets/drafts/5/canvas`

let requests: InstalledValueHook | null = null

afterEach(() => {
  resetAllianceSurfaceObserver()
  requests?.restore()
  requests = null
  document.body.replaceChildren()
})

/** Wplace's open banner editor, backed by a backend that knows alliance 7 and banner draft 5. */
const openBannerEditor = () => {
  window.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    const body = path === '/alliance' ? { id: 7 } : { draftId: 5, assetType: 'banner' }
    return new Response(JSON.stringify(body))
  }) as typeof fetch
  requests = installPageRequestObserver(window)
  document.body.innerHTML = `
    <dialog open>
      <div role="application" aria-label="Alliance asset canvas">
        <div class="artboard-frame"><canvas width="384" height="128"></canvas></div>
      </div>
    </dialog>`
  const published: (ActiveAllianceSurface | null)[] = []
  onActiveAllianceSurfaceChange((surface) => published.push(surface))
  installAllianceSurfaceObserver()
  return published
}

const settle = () => new Promise((resolve) => setTimeout(resolve))

it('keeps the open draft published while Wplace polls and reloads it', async () => {
  const published = openBannerEditor()
  await window.fetch(`${DRAFT}?metadataOnly=true`)
  await settle()
  expect(published.at(-1)).toMatchObject({ surface: { kind: 'alliance-banner' }, draftId: 5 })
  published.length = 0

  await window.fetch(`${DRAFT}?metadataOnly=true`)
  await window.fetch(DRAFT)
  await settle()

  expect(published).toEqual([])
})
