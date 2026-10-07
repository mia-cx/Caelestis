// Two drawings of the same icon roles. Material Symbols is the default; a pixel-style host
// switches to Pixelarticons. The set lives in `$state`, so `useIconSet` can run at any time and
// every mounted `Icon` re-renders in place.
import { ICONS, type IconData, type IconName } from './icons-material.js'
import { PIXEL_ICONS } from './icons-pixel.js'

export { ICONS, type IconData, type IconName } from './icons-material.js'

export type IconSet = 'material' | 'pixel'

let active = $state<{ set: IconSet; icons: Readonly<Record<IconName, IconData>> }>({
  set: 'material',
  icons: ICONS,
})

/** Pick which drawings every `Icon` renders; mounted icons update live. */
export const useIconSet = (set: IconSet): void => {
  active = { set, icons: set === 'pixel' ? PIXEL_ICONS : ICONS }
}

export const activeIconSet = (): IconSet => active.set
export const activeIcons = (): Readonly<Record<IconName, IconData>> => active.icons
