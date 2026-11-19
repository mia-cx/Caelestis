import { registerCaelestisUi } from '@caelestis/ui/elements'
import { addLocalTemplate } from '../src/templates/local-store.js'
import { GAP } from '../src/ui/metrics.js'
import { renderAllianceOverlayControls } from '../src/ui/overlay-menu.js'

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const until = async (condition: () => boolean, message: string) => {
  const deadline = performance.now() + 2000
  while (!condition()) {
    assert(performance.now() < deadline, message)
    await frame()
  }
}
const onScreen = (box: DOMRect) =>
  box.width > 0 &&
  box.height > 0 &&
  box.left >= 0 &&
  box.top >= 0 &&
  box.right <= innerWidth &&
  box.bottom <= innerHeight

/**
 * Browser contract: a template's overlay menu opens beside its gear and stays inside the viewport,
 * and Escape closes it and hands the keyboard back to the gear.
 *
 * The template sits near the bottom-right corner, so the menu has to open to the gear's left and
 * the gear has to lift to fit the menu's action rail.
 */
export const runOverlayMenuContracts = async () => {
  registerCaelestisUi()
  const surface = { kind: 'alliance-banner', allianceId: 1 } as const
  const template = await addLocalTemplate(
    {
      id: 'overlay-menu-contract',
      name: 'Contract banner',
      source: 'image',
      originX: 300,
      originY: 100,
      width: 40,
      height: 20,
      moved: 0,
      opaque: 800,
      indices: new Uint8Array(40 * 20).fill(5),
    },
    surface,
  )
  const stage = document.createElement('div')
  stage.style.cssText = 'position:fixed;inset:0'
  const artboard = document.createElement('div')
  // The banner (384x128) drawn at 2x, so the template's top-right lands at (1080, 800).
  artboard.style.cssText = 'position:absolute;left:400px;top:600px;width:768px;height:256px'
  const canvas = document.createElement('canvas')
  artboard.appendChild(canvas)
  stage.appendChild(artboard)
  document.body.appendChild(stage)

  const active = { surface, stage, frame: artboard, draftId: null, bounds: null }
  const geometry = { originX: 0, originY: 0, width: 384, height: 128 }
  let scheduled = false
  const render = () => {
    scheduled = false
    renderAllianceOverlayControls(rerender, active, geometry, canvas)
  }
  const rerender = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(render)
  }
  render()

  const gear = document.getElementById(`caelestis-overlay-button-${template.id}`)
  assert(gear !== null, 'The template has no overlay gear')
  assert(onScreen(gear.getBoundingClientRect()), 'The overlay gear is off screen')
  await until(
    () => gear.shadowRoot?.querySelector('button') != null,
    'The overlay gear rendered no button',
  )
  const gearButton = gear.shadowRoot?.querySelector('button')
  const closed = gear.getBoundingClientRect()
  await window.browserInput({
    x: closed.left + closed.width / 2,
    y: closed.top + closed.height / 2,
  })

  const menuNode = () => document.getElementById('caelestis-overlay-menu')
  await until(() => menuNode()?.dataset.state === 'open', 'The overlay menu never opened')
  const menu = menuNode()
  assert(menu !== null, 'The overlay menu is missing')
  await frame()
  for (const animation of menu.getAnimations({ subtree: true })) animation.finish()
  await until(
    () => menu.getBoundingClientRect().height > 0,
    'The overlay menu collapsed to zero height',
  )
  await frame()

  const gearBox = gear.getBoundingClientRect()
  const menuBox = menu.getBoundingClientRect()
  assert(onScreen(gearBox), 'The open menu pushed its gear off screen')
  assert(
    onScreen(menuBox),
    `The overlay menu left the viewport: ${JSON.stringify(menuBox.toJSON())}`,
  )
  assert(
    Math.abs(menuBox.right - (gearBox.left - GAP)) < 1,
    `The overlay menu did not open beside its gear: menu right ${menuBox.right}, gear left ${gearBox.left}`,
  )
  assert(
    menuBox.top <= gearBox.top + 1 && menuBox.bottom >= gearBox.bottom - 1,
    'The overlay menu is not level with its gear',
  )

  await window.browserInput({ key: 'Escape' })
  await until(() => menuNode() === null, 'Escape did not close the overlay menu')
  assert(
    gear.shadowRoot?.activeElement === gearButton,
    'Closing the overlay menu did not hand the keyboard back to its gear',
  )
  return { menuWidth: menuBox.width, menuHeight: menuBox.height }
}

Object.assign(window, { runOverlayMenuContracts })
