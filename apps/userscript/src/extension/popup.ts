import {
  EXTENSION_SETTINGS_TAG,
  type ExtensionSettingsModel,
  type GlobalSettingsIntent,
  registerCaelestisUi,
} from '@caelestis/ui/elements'
import { userscriptVersion } from '../client-metrics.js'
import { applyGlobalSettingsIntent, globalSettingsModel } from '../global-settings.js'
import { onStoredValueChange, useStoredValues } from '../stored-values.js'
import { applyWplaceTheme } from '../ui/theme.js'
import { wplaceOptions } from '../wplace-switches.js'
import { loadStoredStrings, onStoredStringsChange, writeStoredString } from './storage.js'

/**
 * The extension's toolbar popup: the settings that apply to every Wplace tab.
 *
 * It reads and writes `chrome.storage.local` through the same modules the page uses, so every
 * switch means what it means in the panel. Open Wplace tabs pick each change up through their
 * bridge and apply it without a reload; a change made in a tab shows here the same way.
 */

const model = (): ExtensionSettingsModel => {
  // The store updates the extension, so there is no update notification to switch.
  const { notifyUpdates: _, ...settings } = globalSettingsModel('popup')
  return { ...settings, version: userscriptVersion, accessibility: wplaceOptions() }
}

const start = async (): Promise<void> => {
  const values = new Map(Object.entries(await loadStoredStrings()))
  onStoredStringsChange(
    useStoredValues(values, {
      persist: (key, value) => void writeStoredString(key, value),
      fetch: loadStoredStrings,
    }),
  )
  registerCaelestisUi()
  const view = document.createElement(EXTENSION_SETTINGS_TAG)
  applyWplaceTheme(view)
  const render = (): void => {
    view.model = model()
  }
  view.addEventListener('caelestis-extension-settings-intent', (event) => {
    applyGlobalSettingsIntent((event as CustomEvent<GlobalSettingsIntent>).detail, 'popup')
    render()
  })
  onStoredValueChange(render)
  render()
  document.body.append(view)
}

void start()
