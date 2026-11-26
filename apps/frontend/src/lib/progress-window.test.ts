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
