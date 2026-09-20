// Two drawings of the same icon roles. Material Symbols is the default and what the userscript
// shows over Wplace; the pixel frontend opts into Pixelarticons once at start-up.
import { ICONS, type IconData, type IconName } from './icons-material.js'
import { PIXEL_ICONS } from './icons-pixel.js'

export { ICONS, type IconData, type IconName } from './icons-material.js'

export type IconSet = 'material' | 'pixel'

let activeSet: IconSet = 'material'
let active: Readonly<Record<IconName, IconData>> = ICONS

/** Pick which drawings every `Icon` renders from here on. Call before the first icon mounts. */
export const useIconSet = (set: IconSet): void => {
  activeSet = set
  active = set === 'pixel' ? PIXEL_ICONS : ICONS
}

export const activeIconSet = (): IconSet => activeSet
export const activeIcons = (): Readonly<Record<IconName, IconData>> => active
