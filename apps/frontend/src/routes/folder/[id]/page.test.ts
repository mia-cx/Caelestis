// @vitest-environment happy-dom
import { millis, type Node, planTimelapseTiles, seconds, tileKey } from '@caelestis/shared'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { manifest, template } from '../../../tests/fixtures'

const fixture = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  history: vi.fn(),
  archive: vi.fn(),
  stats: null as null | { onSeek?: (time: number) => void },
}))
vi.mock('$app/state', () => ({ page: { params: { id: 'route' } } }))
vi.mock('$lib/state/app.svelte', () => ({ useApp: () => fixture.app }))
vi.mock('$lib/api/client', () => ({
  getTileHistory: fixture.history,
  getArchiveHistory: fixture.archive,
}))
// A Svelte 5 component is a function of its anchor and props; these only keep the props.
vi.mock('$lib/components/StatsPanel.svelte', () => ({
  default: (_anchor: unknown, props: { onSeek?: (time: number) => void }) => {
    fixture.stats = props
  },
}))
vi.mock('$lib/components/TemplateViewer.svelte', () => ({ default: () => undefined }))
vi.mock('$lib/components/TemplateCard.svelte', () => ({ default: () => undefined }))
vi.mock('$lib/components/FolderSection.svelte', () => ({ default: () => undefined }))

import { buildTree } from '$lib/tree'
import Page from './+page.svelte'

const start = 1_800_000_000
const node = (id: string, parentId: string | null): Node => ({
  id,
  parentId,
  path: `/${id}`,
  name: id,
  createdAt: millis(start * 1_000),
})
const at = (id: string, nodeId: string, minX: number, minY: number, published = true) =>
  template({
    id,
    nodeId,
    published,
    bbox: { minX, minY, maxX: minX + 100, maxY: minY + 100 },
    createdAt: millis(start * 1_000),
  })
const top = at('top', 'route', 10_000, 10_000)
const nested = at('nested', 'child', 900_000, 600_000)
const draft = at('draft', 'child', 500_000, 500_000, false)

let mounted: ReturnType<typeof mount> | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime((start + 7_200) * 1_000)
  localStorage.clear()
  const catalog = manifest({
    nodes: [node('route', null), node('child', 'route')],
    templates: [top, nested, draft],
  })
  fixture.app = {
    manifest: catalog,
    tree: buildTree(catalog, new Map()),
    statuses: new Map(),
    alarms: new Map(),
    canvas: new Map(),
    liveProtocol: 2,
    subscribeDashboard: () => () => undefined,
  }
  fixture.stats = null
  fixture.history.mockReset().mockResolvedValue({
    frames: [0, 3_600].map((offset) => ({
      bucketStart: seconds(start + offset),
      hash: String(offset),
      reporters: 1,
    })),
  })
  fixture.archive.mockReset().mockResolvedValue({ frames: [] })
})

afterEach(async () => {
  if (mounted) await unmount(mounted)
  mounted = null
  vi.useRealTimers()
  document.body.replaceChildren()
})

const position = () =>
  Number(
    document.querySelector('[aria-label="timelapse position"]')?.getAttribute('data-playhead'),
  ) - start

it('plays every nested published template from its own capture tiles only', async () => {
  mounted = mount(Page, { target: document.body })
  flushSync()
  await vi.advanceTimersByTimeAsync(0)
  flushSync()

  const fetched = fixture.history.mock.calls.map(([x, y]) => tileKey({ x, y }))
  expect(fetched.toSorted()).toEqual(
    planTimelapseTiles([top.bbox, nested.bbox]).map(tileKey).toSorted(),
  )
  expect(fixture.history).toHaveBeenCalledWith(10, 10, 1, start, start + 7_201)
  expect(fixture.archive).toHaveBeenCalledWith('nested', nested.version, { x: 900, y: 600 })
  expect(fixture.archive.mock.calls.some(([id]) => id === 'draft')).toBe(false)

  expect(position()).toBe(7_200)
  fixture.stats?.onSeek?.(start + 3_600)
  flushSync()
  expect(position()).toBe(3_600)
})
