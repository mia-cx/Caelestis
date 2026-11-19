import BackfillElement from './Backfill.element.svelte'
import ClaimModeElement from './ClaimMode.element.svelte'
import ExtensionSettingsElement from './ExtensionSettings.element.svelte'
import NotificationsElement from './Notifications.element.svelte'
import OverlayControlsElement from './OverlayControls.element.svelte'
import PaletteProgressElement from './PaletteProgress.element.svelte'
import PanelElement from './Panel.element.svelte'
import RailControlElement from './RailControl.element.svelte'
import type { CaelestisElement, CaelestisIntent, CaelestisTag } from './registry.js'
import ServerDetailsElement from './ServerDetails.element.svelte'
import ShortcutHelpElement from './ShortcutHelp.element.svelte'
import TagManagerElement from './TagManager.element.svelte'
import TemplateStudioElement from './TemplateStudio.element.svelte'

export type * from '../appearance/model.js'
export type * from '../backfill/model.js'
export type * from '../claim/model.js'
// The userscript bundles this entry as a separate module instance, so it needs its own export.
export { type IconSet, useIconSet } from '../foundations/icons.svelte.js'
export type * from '../notifications/model.js'
export type * from '../overlay/model.js'
export type * from '../panel/model.js'
export type * from '../progress/model.js'
export type * from '../rail/model.js'
export type * from '../server-details/model.js'
export type * from '../settings/model.js'
export type * from '../shortcut-help/model.js'
export type { EffectLayer } from '../studio/effects/layers.js'
export { DEFAULT_STUDIO_LAYOUT, parseStudioLayout } from '../studio/layout.js'
export type * from '../studio/model.js'
export type * from '../studio/options.js'
export { ALPHA_MODES, COLOR_SPACES, DITHER_ALGORITHMS, RESIZE_MODES } from '../studio/options.js'
export type { Samples, ScopeStage } from '../studio/scopes/scopes.js'
export type * from '../tags/model.js'
export type * from '../tree/model.js'
export {
  type CaelestisElement,
  type CaelestisElementTable,
  type CaelestisIntent,
  type CaelestisTag,
  intentEvent,
} from './registry.js'

const ELEMENTS: Readonly<Record<CaelestisTag, { readonly element?: typeof HTMLElement }>> = {
  'caelestis-backfill': BackfillElement,
  'caelestis-claim-mode': ClaimModeElement,
  'caelestis-extension-settings': ExtensionSettingsElement,
  'caelestis-notifications': NotificationsElement,
  'caelestis-overlay-controls': OverlayControlsElement,
  'caelestis-palette-progress': PaletteProgressElement,
  'caelestis-panel': PanelElement,
  'caelestis-rail-control': RailControlElement,
  'caelestis-server-details': ServerDetailsElement,
  'caelestis-shortcut-help': ShortcutHelpElement,
  'caelestis-tag-manager': TagManagerElement,
  'caelestis-template-studio': TemplateStudioElement,
}

/** Browser-only and idempotent, so a userscript injected twice can call it again. */
export const registerCaelestisUi = (): void => {
  if (typeof customElements === 'undefined') return
  for (const [tag, { element }] of Object.entries(ELEMENTS)) {
    if (element !== undefined && customElements.get(tag) === undefined) {
      customElements.define(tag, element)
    }
  }
}

type ElementTagMap = { [Tag in CaelestisTag]: CaelestisElement<Tag> }
type IntentEventMap = {
  [Tag in CaelestisTag as [CaelestisIntent<Tag>] extends [never]
    ? never
    : `${Tag}-intent`]: CustomEvent<CaelestisIntent<Tag>>
}

declare global {
  interface HTMLElementTagNameMap extends ElementTagMap {}
  interface HTMLElementEventMap extends IntentEventMap {}
}
