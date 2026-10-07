import crosshair2x from '../../frontend/static/cursors/crosshair@2x.png'
import crosshair from '../../frontend/static/cursors/crosshair.png'
import defaultCursor2x from '../../frontend/static/cursors/default@2x.png'
import defaultCursor from '../../frontend/static/cursors/default.png'
import ewResize2x from '../../frontend/static/cursors/ew-resize@2x.png'
import ewResize from '../../frontend/static/cursors/ew-resize.png'
import grab2x from '../../frontend/static/cursors/grab@2x.png'
import grab from '../../frontend/static/cursors/grab.png'
import grabbing2x from '../../frontend/static/cursors/grabbing@2x.png'
import grabbing from '../../frontend/static/cursors/grabbing.png'
import notAllowed2x from '../../frontend/static/cursors/not-allowed@2x.png'
import notAllowed from '../../frontend/static/cursors/not-allowed.png'
import pointer2x from '../../frontend/static/cursors/pointer@2x.png'
import pointer from '../../frontend/static/cursors/pointer.png'
import text2x from '../../frontend/static/cursors/text@2x.png'
import text from '../../frontend/static/cursors/text.png'

/**
 * Caelestis's pixel cursors for Wplace, through its own `--cursor-*` properties.
 *
 * The rule applies only while all of Wplace's own cursor choices are off — no Legacy UI
 * (`data-standard-ui`), no Use native OS cursor (`data-native-cursor`) — and our own Caelestis
 * cursors switch in `wplace-settings.ts` has not set `data-caelestis-cursors=off`. Otherwise
 * Wplace's rules stand: its pixel cursors on `:root[data-theme=dark]`, or the plain keywords of
 * its `:root[data-standard-ui],:root[data-native-cursor]` rule. `html:root` (0,4,1) outranks
 * them all, so the attribute set alone decides.
 *
 * The eight most common cursors are the same PNGs the frontend's `scripts/build-cursors.mjs`
 * rasterises from Pixelarticons at 1x and 2x (hotspots in 1x pixels, as that script prints
 * them). The other eleven keep Wplace's pixel art.
 */
export const CURSORS_ATTRIBUTE = 'data-caelestis-cursors'

const CURSORS: Record<string, readonly [string, string, number, number, string]> = {
  default: [defaultCursor, defaultCursor2x, 5, 3, 'default'],
  pointer: [pointer, pointer2x, 10, 0, 'pointer'],
  text: [text, text2x, 12, 12, 'text'],
  crosshair: [crosshair, crosshair2x, 12, 12, 'crosshair'],
  grab: [grab, grab2x, 12, 12, 'grab'],
  grabbing: [grabbing, grabbing2x, 12, 12, 'grabbing'],
  'ew-resize': [ewResize, ewResize2x, 12, 12, 'ew-resize'],
  'not-allowed': [notAllowed, notAllowed2x, 12, 12, 'not-allowed'],
}

const CSS =
  `html:root:not([data-native-cursor]):not([data-standard-ui]):not([${CURSORS_ATTRIBUTE}=off]){` +
  Object.entries(CURSORS)
    .map(
      ([suffix, [png, png2x, x, y, keyword]]) =>
        `--cursor-${suffix}:image-set(url("${png}") 1x, url("${png2x}") 2x) ${x} ${y}, ${keyword}`,
    )
    .join(';') +
  '}'

/** Adopt the cursor sheet on the document. Safe at `document-start`, before `<html>` exists. */
export const installWplaceCursors = (): void => {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(CSS)
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
}
