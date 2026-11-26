import { millis, type Node, seconds } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { manifest, template } from '../tests/fixtures'
import { resolveProgressWindows } from './progress-window'

it('derives folder defaults from its descendants without changing explicit dates', () => {
  const root: Node = {
    id: 'root',
    name: 'root',
    parentId: null,
    path: '/root',
    createdAt: millis(0),
  }
  const window = (start: number, end: number) => ({ start: seconds(start), end: seconds(end) })
  const windows = resolveProgressWindows(
    manifest({
      nodes: [root, { ...root, id: 'child', path: '/root/child', parentId: root.id }],
      templates: [
        template({ id: 'uncapped', nodeId: root.id }),
        template({ id: 'early', nodeId: 'child', progressWindow: window(10, 20) }),
        template({ id: 'late', nodeId: 'child', progressWindow: window(30, 40) }),
        template({ id: 'outside' }),
      ],
    }),
  )
  expect(Object.fromEntries(windows)).toEqual({
    uncapped: window(10, 40),
    early: window(10, 20),
    late: window(30, 40),
    outside: { start: null, end: null },
  })
})

it('keeps explicit template dates when a folder default would invert the range', () => {
  const folder: Node = {
    id: 'folder',
    name: 'Folder',
    parentId: null,
    path: '/folder',
    createdAt: millis(0),
    progressWindow: { start: seconds(10), end: seconds(20) },
  }
  const windows = resolveProgressWindows(
    manifest({
      nodes: [folder],
      templates: [
        template({
          id: 'later',
          nodeId: folder.id,
          progressWindow: { start: seconds(30), end: null },
        }),
        template({
          id: 'earlier',
          nodeId: folder.id,
          progressWindow: { start: null, end: seconds(5) },
        }),
      ],
    }),
  )
  expect(Object.fromEntries(windows)).toEqual({
    later: { start: seconds(30), end: null },
    earlier: { start: null, end: seconds(5) },
  })
})
