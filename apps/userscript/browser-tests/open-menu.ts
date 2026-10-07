import { registerCaelestisUi } from '@caelestis/ui/elements'
import { togglePanel } from '../src/ui/panel.js'

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
  })

/** Browser contract: opening the main menu must not grow Wplace's exactly-100vh page. */
export const runOpenMenuBoundary = async () => {
  const style = document.createElement('style')
  style.textContent = 'html, body { margin: 0 }'
  document.head.appendChild(style)
  // Wplace's layout: the sveltekit root is display:contents, then a relative h-full
  // overflow-hidden shell, then #map at h-screen, so body ends up exactly innerHeight tall.
  const svelteRoot = document.createElement('div')
  svelteRoot.style.display = 'contents'
  const shell = document.createElement('div')
  shell.style.cssText = 'position: relative; height: 100%; overflow: hidden'
  const map = document.createElement('div')
  map.style.height = '100vh'
  shell.appendChild(map)
  svelteRoot.appendChild(shell)
  document.body.appendChild(svelteRoot)

  registerCaelestisUi()
  togglePanel()

  const ready = () =>
    document.getElementById('caelestis-panel') !== null &&
    document
      .querySelector('caelestis-notifications')
      ?.shadowRoot?.querySelector('[role="status"]') instanceof Element
  for (let frame = 0; frame < 120 && !ready(); frame++) await nextFrame()
  if (!ready())
    throw new Error('Opening the menu did not mount the panel and notifications live region')

  const htmlScrollHeight = document.documentElement.scrollHeight
  const bodyScrollHeight = document.body.scrollHeight
  if (htmlScrollHeight !== innerHeight || bodyScrollHeight > innerHeight)
    throw new Error(
      `Opening the menu grew the page: html scrollHeight ${htmlScrollHeight}, ` +
        `body scrollHeight ${bodyScrollHeight}, innerHeight ${innerHeight}`,
    )
  return { innerHeight, htmlScrollHeight, bodyScrollHeight }
}

Object.assign(window, { runOpenMenuBoundary })
