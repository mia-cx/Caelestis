import type { TemplateSurface } from '@caelestis/shared'
import { allianceFullscreenActionGroup, allianceFullscreenHeader } from '../wplace-dom.js'

export type PanelScope = 'world' | 'alliance'

export type PanelView = 'tree' | 'settings' | 'appearance'

interface PanelSession {
  open: boolean
  view: PanelView
}

/** Keep the world panel and alliance drawer from inheriting each other's open or navigation state. */
export class PanelSessions {
  private selected: PanelScope = 'world'
  private readonly sessions: Record<PanelScope, PanelSession> = {
    world: { open: false, view: 'tree' },
    alliance: { open: false, view: 'tree' },
  }

  scope(): PanelScope {
    return this.selected
  }

  select(scope: PanelScope): void {
    this.selected = scope
  }

  isOpen(scope = this.selected): boolean {
    return this.sessions[scope].open
  }

  setOpen(open: boolean, scope = this.selected): void {
    this.sessions[scope].open = open
  }

  view(scope = this.selected): PanelView {
    return this.sessions[scope].view
  }

  setView(view: PanelView, scope = this.selected): void {
    this.sessions[scope].view = view
  }

  isWorldTreeVisible(): boolean {
    return (
      this.selected === 'world' && this.sessions.world.open && this.sessions.world.view === 'tree'
    )
  }
}

/** The panel's title on a canvas: Caelestis on the world, what the alliance canvas holds there. */
export const panelTitle = (surface: TemplateSurface): string => {
  switch (surface.kind) {
    case 'alliance-headquarters':
      return 'Headquarters overlays'
    case 'alliance-picture':
      return 'Picture overlays'
    case 'alliance-banner':
      return 'Banner overlays'
    case 'world':
      return 'Caelestis'
  }
}

/** Keep artboard controls below Wplace's visible fullscreen actions without counting header padding. */
export const allianceRailTop = (stage: HTMLElement, normalTop: number, gap: number): number => {
  const actionGroup = allianceFullscreenActionGroup(stage)
  if (actionGroup === null) return normalTop
  return Math.max(
    normalTop,
    Math.ceil(actionGroup.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + gap),
  )
}

/** Align the alliance rail's right edge with Wplace's fullscreen action group. */
export const allianceRailInlineEnd = (
  stage: HTMLElement,
  parent: HTMLElement,
  gap: number,
): number => {
  const actionGroup = allianceFullscreenActionGroup(stage)
  if (actionGroup !== null) {
    return Math.max(
      0,
      Math.round(parent.getBoundingClientRect().right - actionGroup.getBoundingClientRect().right),
    )
  }
  return Math.max(0, parent.clientWidth - stage.offsetLeft - stage.offsetWidth + gap)
}

/** Own and restore the Wplace geometry changed while the alliance drawer is open. */
export class AllianceDrawerInset {
  private stage: HTMLElement | null = null
  private stagePrevious = ''
  private header: HTMLElement | null = null
  private headerPrevious = ''

  apply(stage: HTMLElement, width: number, gap: number): void {
    if (this.stage !== stage) {
      this.clear()
      this.stage = stage
      this.stagePrevious = stage.style.marginInlineEnd
    }
    const header = allianceFullscreenHeader(stage)
    if (this.header !== header) {
      if (this.header !== null) this.header.style.marginInlineEnd = this.headerPrevious
      this.header = header
      this.headerPrevious = header?.style.marginInlineEnd ?? ''
    }
    const inset = `${Math.max(0, Math.round(width + gap))}px`
    if (stage.style.marginInlineEnd !== inset) stage.style.marginInlineEnd = inset
    if (header !== null && header.style.marginInlineEnd !== inset) {
      header.style.marginInlineEnd = inset
    }
  }

  clear(): void {
    if (this.stage !== null) this.stage.style.marginInlineEnd = this.stagePrevious
    if (this.header !== null) this.header.style.marginInlineEnd = this.headerPrevious
    this.stage = null
    this.stagePrevious = ''
    this.header = null
    this.headerPrevious = ''
  }
}
