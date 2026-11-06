import {
  EXTENSION_SETTINGS_TAG,
  type ExtensionSettingsModel,
  type GlobalSettingsIntent,
  registerCaelestisUi,
} from '@caelestis/ui/elements'
import { userscriptVersion } from '../client-metrics.js'
import { setEnabled as setDebugLogging, storedDebugLogging } from '../debug.js'
import { storedProfiling, storeProfiling } from '../profile.js'
import { storedGlobalSettings, storeGlobalSetting } from '../state.js'
import { onStoredValueChange, useStoredValues } from '../stored-values.js'
import { applyWplaceTheme } from '../ui/theme.js'
import { isWplacePatch, setWplacePatchEnabled, wplacePatchSettings } from '../wplace-patches.js'
import { setWplaceOption, wplaceOptions } from '../wplace-settings.js'
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
  const { notifyUpdates: _, ...settings } = storedGlobalSettings()
  return {
    ...settings,
    version: userscriptVersion,
    wplacePatches: wplacePatchSettings(),
    debugLogging: storedDebugLogging(),
    performanceProfiling: storedProfiling(),
    accessibility: wplaceOptions(),
  }
}

const apply = (intent: GlobalSettingsIntent): void => {
  switch (intent.type) {
    case 'set-boolean':
      if (intent.key === 'debugLogging') setDebugLogging(intent.value)
      else if (intent.key === 'performanceProfiling') storeProfiling(intent.value)
      else storeGlobalSetting(intent.key, intent.value)
      break
    case 'set-wplace-patch':
      if (isWplacePatch(intent.id)) setWplacePatchEnabled(intent.id, intent.enabled)
      break
    case 'set-accessibility':
      setWplaceOption(intent.key, intent.value)
      break
  }
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
    apply((event as CustomEvent<GlobalSettingsIntent>).detail)
    render()
  })
  onStoredValueChange(render)
  render()
  document.body.append(view)
}

void start()
