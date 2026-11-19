import type { GlobalSettingsIntent } from '@caelestis/ui/elements'
import {
  isEnabled as isDebugEnabled,
  setEnabled as setDebugEnabled,
  storedDebugLogging,
} from './debug.js'
import { isProfileEnabled, setProfileEnabled, storedProfiling, storeProfiling } from './profile.js'
import {
  currentGlobalSettings,
  setState,
  storedGlobalSettings,
  storeGlobalSetting,
} from './settings.js'
import { isWplacePatch, setWplacePatchEnabled, wplacePatchSettings } from './wplace-patches.js'
import { setWplaceOption } from './wplace-settings.js'

/**
 * The settings that apply to every Wplace tab, shared by the panel's Settings view and the
 * extension's toolbar popup. A `tab` reads and changes them live. The `popup` runs no Caelestis of
 * its own, so it reads and writes storage, and open tabs adopt each change from there.
 */
type SettingsContext = 'tab' | 'popup'

export const globalSettingsModel = (context: SettingsContext) => ({
  ...(context === 'tab' ? currentGlobalSettings() : storedGlobalSettings()),
  wplacePatches: wplacePatchSettings(),
  debugLogging: context === 'tab' ? isDebugEnabled() : storedDebugLogging(),
  performanceProfiling: context === 'tab' ? isProfileEnabled() : storedProfiling(),
})

export const applyGlobalSettingsIntent = (
  intent: GlobalSettingsIntent,
  context: SettingsContext,
): void => {
  switch (intent.type) {
    case 'set-boolean':
      if (intent.key === 'debugLogging') setDebugEnabled(intent.value)
      else if (intent.key === 'performanceProfiling')
        (context === 'tab' ? setProfileEnabled : storeProfiling)(intent.value)
      else if (context === 'tab') setState({ [intent.key]: intent.value })
      else storeGlobalSetting(intent.key, intent.value)
      break
    case 'set-wplace-patch':
      // Persists the switch, and applies or undoes the patch on a live map.
      if (isWplacePatch(intent.id)) setWplacePatchEnabled(intent.id, intent.enabled)
      break
    case 'set-accessibility':
      setWplaceOption(intent.key, intent.value)
      break
  }
}
