import { isRecord } from '@caelestis/shared'
import { registerDebugEntry } from './console-api.js'
import { log } from './debug.js'
import { storedSwitches } from './stored-switches.js'

/**
 * The Wplace-side switches a painter can flip, shown in the extension's toolbar popup as well as
 * the page: performance patches for Wplace's own client, and Caelestis's rows in Wplace's
 * Settings › Accessibility panel.
 */

/**
 * Each patch has its own switch, so a patch that turns out to break something can be turned off
 * without a new release. `wplace-patches.ts` says what each one does.
 */
const WPLACE_PATCHES = {
  'hover-canvas': {
    label: 'Stop idle redraws',
    hint: 'Wplace redraws the whole map every frame for its hover crosshair, even when nothing moves. The crosshair still follows the pointer.',
  },
  'highlight-order': {
    label: 'Settle event outlines',
    hint: "Stops Wplace re-sorting the event outline's layers on every map update, which also kept the map redrawing.",
  },
  'tile-refresh': {
    label: 'Download changed tiles only',
    hint: 'Every few seconds, checks each visible tile and downloads only the ones that changed. Every tile is still downloaded again about once a minute.',
  },
  'draft-refresh': {
    label: 'Reload drafted tiles only',
    hint: 'Placing or erasing a draft pixel reloads only the tiles whose drafts changed, not every visible tile.',
  },
  'capture-dedupe': {
    label: 'Skip identical tile reads',
    hint: "Caelestis skips re-reading a tile's pixels when Wplace downloads an identical copy.",
  },
  'marker-animations': {
    label: 'Pause hidden marker animations',
    hint: "Stops the event marker's animations while it is hidden, zoomed in.",
  },
} as const satisfies Record<string, { readonly label: string; readonly hint: string }>

export type WplacePatch = keyof typeof WPLACE_PATCHES

const PATCH_IDS = Object.keys(WPLACE_PATCHES) as WplacePatch[]

export const isWplacePatch = (value: unknown): value is WplacePatch =>
  typeof value === 'string' && Object.hasOwn(WPLACE_PATCHES, value)

/** Stored as the list of patches switched off, so a new patch starts on. */
const patches = storedSwitches(
  'caelestis.wplace-patches.v1',
  Object.fromEntries(PATCH_IDS.map((id) => [id, true])) as Record<WplacePatch, boolean>,
  {
    parse: (stored) =>
      Array.isArray(stored)
        ? Object.fromEntries(stored.filter(isWplacePatch).map((id) => [id, false]))
        : {},
    serialise: (switches) => PATCH_IDS.filter((id) => !switches[id]),
  },
)

patches.onChange((patch, enabled) => log(`Wplace patch ${patch} ${enabled ? 'on' : 'off'}`))

export const isWplacePatchEnabled = (patch: WplacePatch): boolean => patches.isOn(patch)

export const setWplacePatchEnabled = (patch: WplacePatch, enabled: boolean): void =>
  patches.set(patch, enabled)

/** Notified when a patch is switched on or off, so it can apply or undo itself immediately. */
export const onWplacePatchChange = patches.onChange

/** Every patch with its settings copy and current switch, in settings order. */
export const wplacePatchSettings = (): {
  readonly id: WplacePatch
  readonly label: string
  readonly hint: string
  readonly enabled: boolean
}[] => PATCH_IDS.map((id) => ({ id, ...WPLACE_PATCHES[id], enabled: patches.isOn(id) }))

/** Caelestis's performance patches for Wplace's own client, each with its own switch. */
registerDebugEntry('wplacePatches', {
  list: () => wplacePatchSettings(),
  enable: (patch: WplacePatch) => setWplacePatchEnabled(patch, true),
  disable: (patch: WplacePatch) => setWplacePatchEnabled(patch, false),
})

/** Caelestis's Accessibility switches. Both start on. */
const OPTION_DEFAULTS = { falseType: true, cursors: true }

type WplaceOption = keyof typeof OPTION_DEFAULTS

const options = storedSwitches<WplaceOption>('caelestis.wplace-options.v1', OPTION_DEFAULTS, {
  parse: (stored) =>
    isRecord(stored)
      ? Object.fromEntries(
          Object.entries(stored).filter(
            ([key, value]) => Object.hasOwn(OPTION_DEFAULTS, key) && typeof value === 'boolean',
          ),
        )
      : {},
  serialise: (switches) => switches,
})

export const wplaceOptions = options.all

export const setWplaceOption = options.set

/** Notified when an Accessibility switch flips, here or in the toolbar popup. */
export const onWplaceOptionChange = options.onChange

/** Test seam: read both switch sets from storage afresh and forget their listeners. */
export const resetWplaceSwitches = (): void => {
  patches.reset()
  options.reset()
}
