import {
  type KeyBinding,
  keyBindingReleasedBy,
  SHORTCUTS,
  type ShortcutId,
  type ShortcutPlatform,
  WORLD_TEMPLATE_SURFACE,
} from '@caelestis/shared'
import {
  type ActiveAllianceSurface,
  activeAllianceEditorStage,
  activeAllianceSurface,
} from './alliance-surface.js'
import { handleTemplateStudioIntent, isTemplateStudioOpen } from './application/template-studio.js'
import { isClaimModeActive } from './claim-editor.js'
import { cycleFocusedColour, navigateFocusedSelectedColour } from './colour-navigation.js'
import { getMap } from './map-handle.js'
import { redraw } from './map-view.js'
import { setOverlayPeekActive } from './overlay-peek.js'
import {
  getState,
  getSurfaceAppearance,
  onlySelectedColourFor,
  setOnlySelectedColourFor,
  setState,
  setSurfaceAppearance,
} from './settings.js'
import { activeShortcutBindings, currentShortcutPlatform, shortcutFor } from './shortcuts.js'
import { simulatedInputAllowed } from './simulated-input.js'
import {
  ownsGroup,
  setAppearance,
  setLocalVisible,
  setOwnsGroup,
  toggleAppearanceBoolean,
} from './templates/local-store.js'
import { isMoving } from './templates/move.js'
import { focusedTemplate } from './templates/nearest.js'
import { refreshOverlayMenu, toggleOverlayMenu } from './ui/overlay-menu.js'
import { togglePanel } from './ui/panel.js'
import { openClaimTool } from './ui/presence-actions.js'
import { toggleShortcutHelp } from './ui/shortcut-help.js'
import {
  cancelPaintDraft,
  performPaintAction,
  redoPaintDraft,
  undoPaintDraft,
} from './wplace-paint.js'
import { toggleWplaceTheme } from './wplace-theme.js'

type AllianceSurface = ActiveAllianceSurface['surface']

const triggerMapRepaint = (): void => {
  const map = getMap() as { triggerRepaint?: () => void } | null
  map?.triggerRepaint?.()
}

/** Claim a handled shortcut inside an alliance editor so it cannot reach the world behind it. */
const claimShortcut = (
  event: KeyboardEvent,
  allianceEditorWasActive = activeAllianceEditorStage() !== null,
): void => {
  event.preventDefault()
  if (allianceEditorWasActive) event.stopImmediatePropagation()
}

const toggleMarkerKind = (
  property: 'markMismatch' | 'markSelectedColour',
  allianceSurface: AllianceSurface | null,
): void => {
  const focused = focusedTemplate()
  if (focused !== null && ownsGroup(focused, 'markers')) {
    void toggleAppearanceBoolean(focused.id, property)
    // Its menu may be open on the switch this moved, and it does not rebuild on a redraw.
    refreshOverlayMenu()
    return
  }
  if (allianceSurface !== null) {
    const appearance = getSurfaceAppearance(allianceSurface)
    setSurfaceAppearance(allianceSurface, {
      ...appearance,
      [property]: !appearance[property],
    })
    return
  }
  const appearance = getState().appearance
  setState({ appearance: { ...appearance, [property]: !appearance[property] } })
}

const toggleRings = (allianceSurface: AllianceSurface | null): void => {
  const focused = focusedTemplate()
  if (focused !== null && ownsGroup(focused, 'pixels')) {
    void toggleAppearanceBoolean(focused.id, 'contrastOutline').then((changed) => {
      if (!changed) return
      refreshOverlayMenu()
      if (allianceSurface === null) triggerMapRepaint()
    })
    return
  }
  if (allianceSurface !== null) {
    const appearance = getSurfaceAppearance(allianceSurface)
    setSurfaceAppearance(allianceSurface, {
      ...appearance,
      contrastOutline: !appearance.contrastOutline,
    })
    return
  }
  const appearance = getState().appearance
  setState({
    appearance: { ...appearance, contrastOutline: !appearance.contrastOutline },
  })
  triggerMapRepaint()
}

interface ShortcutContext {
  readonly shortcut: ShortcutId
  readonly allianceSurface: AllianceSurface | null
}

interface ShortcutHandler {
  /** Run the action. Returns whether it acted; an alliance editor claims the key either way. */
  readonly run: (context: ShortcutContext) => boolean
  /**
   * Runs in an alliance editor that has no resolved surface yet. Its native paint controls stay
   * scoped to the editor's dialog; every action that needs template or appearance state waits
   * rather than falling through to the world.
   */
  readonly withoutSurface?: true
}

/**
 * Install the complete key map once.
 *
 * Every template-local action resolves through `focusedTemplate`; visibility opts into its one
 * narrow hidden-template restoration mode. Peek is runtime render state and is always released on
 * keyup, blur, disposal, or a hidden tab rather than touching any persisted visibility switch.
 */
export const installKeyboardShortcuts = (
  platform: ShortcutPlatform = currentShortcutPlatform(),
): (() => void) => {
  let peeking = false
  /** The chords that started the current peek; a rebinding mid-hold must not strand it. */
  let peekBindings: readonly KeyBinding[] = []
  const repaintPeek = (active: boolean): void => {
    if (!setOverlayPeekActive(active)) return
    triggerMapRepaint()
  }
  const endPeek = (): void => {
    if (!peeking) return
    peeking = false
    peekBindings = []
    repaintPeek(false)
  }

  const setOpacity = ({ shortcut }: ShortcutContext): boolean => {
    const focused = focusedTemplate()
    const opacity = SHORTCUTS[shortcut].opacity
    if (focused === null || opacity === undefined) return false
    void setOwnsGroup(focused.id, 'pixels', true).then((owned) => {
      if (owned) void setAppearance(focused.id, { opacity })
    })
    return true
  }
  const cycle = (direction: -1 | 1) => (): boolean => {
    // Cycling clicks a swatch, which Wplace flags on the world map.
    if (simulatedInputAllowed('cycle-colour')) cycleFocusedColour(direction)
    return true
  }

  const handlers: Readonly<Record<ShortcutId, ShortcutHandler>> = {
    'cycle-colour-previous': { run: cycle(-1) },
    'cycle-colour-next': { run: cycle(1) },
    'paint-action': { run: performPaintAction, withoutSurface: true },
    'cancel-paint': { run: cancelPaintDraft, withoutSurface: true },
    'fly-to-colour': {
      run: () => {
        void navigateFocusedSelectedColour()
        return true
      },
    },
    'peek-overlays': {
      run: () => {
        if (!peeking) peekBindings = activeShortcutBindings()['peek-overlays']
        peeking = true
        repaintPeek(true)
        return true
      },
    },
    'undo-paint': { run: undoPaintDraft, withoutSurface: true },
    'redo-paint': { run: redoPaintDraft, withoutSurface: true },
    'toggle-panel': {
      run: () => {
        togglePanel()
        return true
      },
    },
    'toggle-theme': { run: () => toggleWplaceTheme(), withoutSurface: true },
    'claim-mode': {
      // Claimed on every canvas so Wplace never sees the key; alliance artboards have no
      // presence room yet, so only the world canvas opens the tool.
      run: ({ allianceSurface }) => {
        if (allianceSurface === null) openClaimTool('rectangle')
        return true
      },
    },
    'toggle-presence': {
      run: () => {
        setState({ showPresence: !getState().showPresence })
        return true
      },
    },
    'toggle-rings': {
      run: ({ allianceSurface }) => {
        toggleRings(allianceSurface)
        return true
      },
    },
    'toggle-colour': {
      run: ({ allianceSurface }) => {
        const surface = allianceSurface ?? WORLD_TEMPLATE_SURFACE
        setOnlySelectedColourFor(surface, !onlySelectedColourFor(surface))
        return true
      },
    },
    'toggle-template-menu': {
      run: () => {
        const focused = focusedTemplate()
        if (focused === null) return false
        toggleOverlayMenu(focused.id, redraw)
        return true
      },
    },
    'toggle-visibility': {
      run: () => {
        const focused = focusedTemplate({ restoreHiddenAtCentre: true })
        if (focused !== null) void setLocalVisible(focused.id, !focused.visible)
        return true
      },
    },
    'toggle-markers': {
      run: ({ allianceSurface }) => {
        toggleMarkerKind('markMismatch', allianceSurface)
        return true
      },
    },
    'toggle-selected-colour-markers': {
      run: ({ allianceSurface }) => {
        toggleMarkerKind('markSelectedColour', allianceSurface)
        return true
      },
    },
    'set-opacity-20': { run: setOpacity },
    'set-opacity-40': { run: setOpacity },
    'set-opacity-60': { run: setOpacity },
    'set-opacity-80': { run: setOpacity },
    'set-opacity-100': { run: setOpacity },
    'show-shortcut-help': {
      run: () => {
        toggleShortcutHelp(platform)
        return true
      },
      withoutSurface: true,
    },
  }

  const onKeyup = (event: KeyboardEvent): void => {
    if (!peeking) return
    if (!peekBindings.some((binding) => keyBindingReleasedBy(binding, event))) return
    claimShortcut(event)
    endPeek()
  }
  const onVisibility = (): void => {
    if (document.hidden) endPeek()
  }
  const onKeydown = (event: KeyboardEvent): void => {
    // Placement owns its confirm/cancel keys. This listener runs in capture so Wplace's alliance
    // modal cannot swallow shortcuts before they reach the shared key map.
    if (isMoving() && (event.key === 'Escape' || event.key === 'Enter')) return
    // Claim mode is its own keyboard world: tool letters, confirm, cancel, delete all belong to it.
    if (isClaimModeActive()) return
    const shortcut = shortcutFor(event, platform)
    if (shortcut === null) return
    const alliance = activeAllianceSurface()
    const inAllianceEditor = activeAllianceEditorStage() !== null

    // The template studio's edits take undo and redo while it is open.
    if (isTemplateStudioOpen() && (shortcut === 'undo-paint' || shortcut === 'redo-paint')) {
      claimShortcut(event, inAllianceEditor)
      handleTemplateStudioIntent({ type: shortcut === 'undo-paint' ? 'undo' : 'redo' })
      return
    }

    // An asset editor intentionally has no resolved surface while Wplace's draft metadata is
    // pending or invalid.
    const handler = handlers[shortcut]
    const acted =
      (!inAllianceEditor || alliance !== null || handler.withoutSurface === true) &&
      handler.run({ shortcut, allianceSurface: alliance?.surface ?? null })
    if (acted || inAllianceEditor) claimShortcut(event, inAllianceEditor)
  }

  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('keyup', onKeyup, true)
  window.addEventListener('blur', endPeek)
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    window.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('keyup', onKeyup, true)
    window.removeEventListener('blur', endPeek)
    document.removeEventListener('visibilitychange', onVisibility)
    endPeek()
  }
}
