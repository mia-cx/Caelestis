import { describe, expect, it } from 'vitest'
import { dockedWindows, dropWindow, placementOf, toggleWindow } from '../src/studio/layout.js'

const viewport = { width: 1200, height: 800 }
const box = (x: number, y: number) => ({ x, y, width: 288, height: 200 })

describe('studio window layout', () => {
  it('docks a window released near an edge above the window it was dropped on', () => {
    const right = { palette: box(900, 72), 'color-space': box(900, 280) }
    const moved = dropWindow({}, 'dimensions', box(1200 - 300, 200), viewport, right)
    const end = dockedWindows(moved, 'end')
    expect(end.slice(0, 3)).toEqual(['palette', 'dimensions', 'color-space'])

    const left = { source: box(12, 72) }
    const back = dropWindow(moved, 'dimensions', box(20, 60), viewport, left)
    expect(dockedWindows(back, 'start').slice(0, 2)).toEqual(['dimensions', 'source'])
    expect(dockedWindows(back, 'end')).toEqual(end.filter((id) => id !== 'dimensions'))
  })

  it('floats a window measured from its nearer edge, so it stays put when the screen resizes', () => {
    const left = placementOf(dropWindow({}, 'source', box(300, 100), viewport, {}), 'source')
    expect(left).toMatchObject({ dock: null, edge: 'start', x: 300, y: 100 })

    const right = placementOf(dropWindow({}, 'source', box(700, 100), viewport, {}), 'source')
    expect(right).toMatchObject({ dock: null, edge: 'end', x: 1200 - 700 - 288 })
  })

  it('reopens a closed window where it was', () => {
    const floated = dropWindow({}, 'source', box(300, 100), viewport, {})
    const reopened = toggleWindow(toggleWindow(floated, 'source', false), 'source', true)
    expect(placementOf(reopened, 'source')).toMatchObject({
      open: true,
      dock: null,
      x: 300,
      y: 100,
    })
  })
})
