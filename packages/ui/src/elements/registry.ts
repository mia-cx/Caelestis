import type { BackfillIntent, BackfillModel } from '../backfill/model.js'
import type { ClaimModeIntent, ClaimModeModel } from '../claim/model.js'
import type { NotificationsIntent, NotificationsModel } from '../notifications/model.js'
import type { OverlayControlsIntent, OverlayControlsModel } from '../overlay/model.js'
import type { PanelIntent, PanelModel } from '../panel/model.js'
import type { PaletteProgressModel } from '../progress/model.js'
import type { RailControlModel } from '../rail/model.js'
import type { ServerDetailsIntent, ServerDetailsModel } from '../server-details/model.js'
import type { ExtensionSettingsModel, GlobalSettingsIntent } from '../settings/model.js'
import type { ShortcutHelpIntent, ShortcutHelpModel } from '../shortcut-help/model.js'
import type { Box } from '../studio/layout.js'
import type { TemplateStudioIntent, TemplateStudioModel } from '../studio/model.js'
import type { TagManagerIntent, TagManagerModel } from '../tags/model.js'

/**
 * Every custom element, by tag: the properties a host sets and the intent its `${tag}-intent`
 * event carries (`never` for elements without one).
 */
export interface CaelestisElementTable {
  'caelestis-backfill': { props: { model: BackfillModel }; intent: BackfillIntent }
  'caelestis-claim-mode': { props: { model: ClaimModeModel }; intent: ClaimModeIntent }
  'caelestis-extension-settings': {
    props: { model: ExtensionSettingsModel }
    intent: GlobalSettingsIntent
  }
  'caelestis-notifications': { props: { model: NotificationsModel }; intent: NotificationsIntent }
  'caelestis-overlay-controls': {
    props: { model: OverlayControlsModel }
    intent: OverlayControlsIntent
  }
  'caelestis-palette-progress': { props: { model: PaletteProgressModel }; intent: never }
  'caelestis-panel': { props: { model: PanelModel }; intent: PanelIntent }
  'caelestis-rail-control': { props: { model: RailControlModel }; intent: never }
  'caelestis-server-details': { props: { model: ServerDetailsModel }; intent: ServerDetailsIntent }
  'caelestis-shortcut-help': { props: { model: ShortcutHelpModel }; intent: ShortcutHelpIntent }
  'caelestis-tag-manager': { props: { model: TagManagerModel }; intent: TagManagerIntent }
  'caelestis-template-studio': {
    props: {
      model: TemplateStudioModel
      /** Where the draft, or the crop being drawn, sits on screen, in CSS pixels. */
      mapBox: Box | null
    }
    intent: TemplateStudioIntent
  }
}

export type CaelestisTag = keyof CaelestisElementTable
export type CaelestisElement<Tag extends CaelestisTag> = HTMLElement &
  CaelestisElementTable[Tag]['props']
export type CaelestisIntent<Tag extends CaelestisTag> = CaelestisElementTable[Tag]['intent']

/** The name of the event an element's intents arrive on. */
export const intentEvent = <Tag extends CaelestisTag>(tag: Tag): `${Tag}-intent` => `${tag}-intent`

/** Dispatches each intent from `host` as its composed `${tag}-intent` event. */
export const intentEmitter =
  <Tag extends CaelestisTag>(host: HTMLElement, tag: Tag) =>
  (detail: CaelestisIntent<Tag>): void => {
    host.dispatchEvent(new CustomEvent(intentEvent(tag), { detail, bubbles: true, composed: true }))
  }
