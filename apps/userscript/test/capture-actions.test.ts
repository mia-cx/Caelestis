import { beforeEach, expect, it, vi } from 'vitest'
import { captureSelection } from '../src/application/capture-actions.js'

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  stop: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
}))

vi.mock('../src/templates/capture-region.js', () => ({
  captureRegion: mocks.capture,
  templateFromCapture: () => ({ id: 'local-capture', name: 'Capture', width: 1, height: 1 }),
}))
vi.mock('../src/templates/local-store.js', () => ({
  addLocalTemplate: mocks.add,
  removeLocalTemplate: mocks.remove,
}))
vi.mock('../src/templates/move.js', () => ({
  reserveMove: () => ({ release: mocks.release, start: mocks.start }),
}))
vi.mock('../src/claim-editor.js', () => ({ stopClaimMode: mocks.stop }))
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }))
vi.mock('../src/debug.js', () => ({ warn: vi.fn() }))

const selection = {
  rect: { x: 0, y: 0, w: 1, h: 1 },
  parts: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, mask: new Uint8Array([1]), count: 1 }],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capture.mockResolvedValue({ originX: 0, originY: 0, width: 1, height: 1 })
  mocks.add.mockResolvedValue(undefined)
  mocks.remove.mockResolvedValue(true)
})

it('does not admit a capture after its editor session ends during the tile read', async () => {
  let finishRead: ((value: unknown) => void) | undefined
  mocks.capture.mockImplementation(() => new Promise((resolve) => (finishRead = resolve)))
  let current = true
  const rerender = vi.fn()
  const result = captureSelection(selection, 'template', rerender, () => current)

  current = false
  finishRead?.({ originX: 0, originY: 0, width: 1, height: 1 })
  await expect(result).resolves.toBeNull()
  expect(mocks.add).not.toHaveBeenCalled()
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})

it('removes an admitted capture if its editor session ends during admission', async () => {
  let finishAdmission: (() => void) | undefined
  let admissionStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => (admissionStarted = resolve))
  mocks.add.mockImplementation(() => {
    admissionStarted()
    return new Promise<void>((resolve) => (finishAdmission = resolve))
  })
  let current = true
  const rerender = vi.fn()
  const result = captureSelection(selection, 'template', rerender, () => current)

  await started
  current = false
  finishAdmission?.()
  await expect(result).resolves.toBeNull()
  expect(mocks.remove).toHaveBeenCalledWith('local-capture')
  expect(mocks.stop).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.release).toHaveBeenCalledOnce()
})
