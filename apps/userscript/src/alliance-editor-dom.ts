import { type AllianceTemplateSurfaceKind, templateSurfaceBounds } from '@caelestis/shared'
import type { AllianceEditorView } from './alliance-context.js'
import { pageWindow } from './page-world.js'
import { ALLIANCE_EDITOR_STAGE, ARTBOARD_FRAME } from './wplace-dom.js'
import { findWplaceLabelled } from './wplace-messages.js'

/** An alliance editor's stage and the transformed frame its artboard is drawn into. */
export interface AllianceEditorElements {
  readonly stage: HTMLElement
  readonly frame: HTMLElement
}

/** The open alliance editor whose stage carries Wplace's `label`, in the reader's language. */
const stage = (label: 'alliance_hq_canvas' | 'alliance_asset_canvas'): HTMLElement | null =>
  findWplaceLabelled<HTMLElement>(pageWindow().document, ALLIANCE_EDITOR_STAGE, label)

const mounted = (editorStage: HTMLElement | null): AllianceEditorElements | null => {
  const frame = editorStage?.querySelector<HTMLElement>(ARTBOARD_FRAME) ?? null
  return editorStage === null || frame === null ? null : { stage: editorStage, frame }
}

const ASSET_KINDS = ['alliance-picture', 'alliance-banner'] as const

/** The asset whose fixed size Wplace's native artboard canvas has, if any. */
const assetKindFromCanvas = (frame: HTMLElement): AllianceTemplateSurfaceKind | null => {
  for (const child of frame.children) {
    // By tag, not `instanceof`: the canvas belongs to the page's realm.
    if (child.tagName !== 'CANVAS') continue
    const canvas = child as HTMLCanvasElement
    const kind = ASSET_KINDS.find((candidate) => {
      const bounds = templateSurfaceBounds({ kind: candidate, allianceId: 0 })
      return bounds?.maxX === canvas.width && bounds.maxY === canvas.height
    })
    if (kind !== undefined) return kind
  }
  return null
}

/** The alliance editors with a mounted artboard, and what the asset editor's canvas size says. */
export const locateAllianceEditors = (): {
  readonly headquarters: AllianceEditorElements | null
  readonly asset: AllianceEditorElements | null
  readonly view: AllianceEditorView
} => {
  const headquarters = mounted(stage('alliance_hq_canvas'))
  const asset = mounted(stage('alliance_asset_canvas'))
  return {
    headquarters,
    asset,
    view: {
      headquarters: headquarters !== null,
      asset: asset === null ? null : { canvasKind: assetKindFromCanvas(asset.frame) },
    },
  }
}

/** The open alliance editor stage, even while its exact asset surface is still being validated. */
export const activeAllianceEditorStage = (): HTMLElement | null =>
  stage('alliance_hq_canvas') ?? stage('alliance_asset_canvas')
