import { useIconSet } from '@caelestis/ui/elements'
import { applyThemeTokens, type CaelestisThemeTokens } from '@caelestis/ui/theme'
import { SURFACE_RADIUS } from './metrics.js'

export type CaelestisStyle = 'pixel' | 'classic'

const MUTED_TEXT = 'color-mix(in oklch, var(--color-base-content, currentColor) 62%, transparent)'

const SHARED = {
  surface: 'var(--color-base-100, oklch(0.27 0.025 264))',
  raisedSurface: 'var(--color-base-200, oklch(0.32 0.025 264))',
  text: 'var(--color-base-content, oklch(0.91 0.015 264))',
  border: 'var(--color-base-300, rgb(255 255 255 / 0.14))',
  focus: 'var(--color-primary, oklch(0.74 0.14 244))',
  primary: 'var(--color-primary, oklch(0.68 0.15 244))',
  warning: 'var(--color-warning, oklch(0.76 0.15 75))',
  success: 'var(--color-success, oklch(0.75 0.14 154))',
  danger: 'var(--color-error, oklch(0.72 0.18 27))',
  finished: 'var(--color-success, oklch(0.75 0.14 154))',
  frozen: 'var(--color-primary, oklch(0.76 0.12 238))',
  compactTarget: '2rem',
  touchTarget: '2.5rem',
  motionDuration: '160ms',
  pixelInk: 'var(--pixel-ink, color-mix(in oklab, var(--color-base-content, #394e6a) 70%, black))',
  pixelShadow: 'var(--pixel-shadow, rgb(0 0 0 / 0.3))',
  pixelButton: 'var(--pixel-button, var(--color-base-300, #e3e9f4))',
  pixelButtonLight: 'var(--pixel-button-light, var(--color-base-100, #fff))',
  pixelButtonShade:
    'var(--pixel-button-shade, color-mix(in oklab, var(--color-base-300, #e3e9f4) 75%, black))',
  pixelPrimaryLight:
    'var(--pixel-primary-light, color-mix(in oklab, var(--color-primary, #0069ff) 65%, white))',
  pixelPrimaryShade:
    'var(--pixel-primary-shade, color-mix(in oklab, var(--color-primary, #0069ff) 60%, black))',
  pixelFieldShade: 'var(--pixel-field-shade, var(--color-base-200, #f2f7fe))',
  pixelWell: 'var(--pixel-well, var(--color-base-200, #e3e9f4))',
  pixelWellShade: 'var(--pixel-well-shade, var(--color-base-300, #c5cfdf))',
  pixelThumb: 'var(--pixel-thumb, var(--color-base-100, #fff))',
} satisfies Partial<CaelestisThemeTokens>

const BY_STYLE = {
  classic: {
    radius: SURFACE_RADIUS,
    pillRadius: '999px',
    shadow: '0 24px 80px rgb(0 0 0 / 0.35)',
    popoverShadow: '0 1px 2px rgb(0 0 0 / 0.12), 0 10px 24px -6px rgb(0 0 0 / 0.28)',
    mutedText: MUTED_TEXT,
    font: '"Geist", ui-sans-serif, system-ui, sans-serif',
    monoFont: '"Geist Mono", ui-monospace, monospace',
  },
  pixel: {
    radius: '0',
    pillRadius: '0',
    shadow: '6px 6px 0 var(--pixel-shadow, rgb(0 0 0 / 0.3))',
    popoverShadow: '4px 4px 0 var(--pixel-shadow, rgb(0 0 0 / 0.3))',
    mutedText: `var(--pixel-muted, ${MUTED_TEXT})`,
    font: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif)',
    monoFont: 'var(--font-mono, ui-monospace, monospace)',
  },
} satisfies Record<CaelestisStyle, Partial<CaelestisThemeTokens>>

const styleOf = (root: HTMLElement): CaelestisStyle =>
  root.hasAttribute('data-game-ui') && !root.hasAttribute('data-standard-ui') ? 'pixel' : 'classic'

const painted = new Set<WeakRef<HTMLElement>>()
const observed = new WeakSet<Document>()
let iconStyle: CaelestisStyle | undefined

const paint = (target: HTMLElement, style: CaelestisStyle): void => {
  applyThemeTokens(target, { ...SHARED, ...BY_STYLE[style] })
  target.dataset.caelestisStyle = style
}

/** The icon set is global, so only the main document's style picks it. */
const syncIcons = (doc: Document, style: CaelestisStyle): void => {
  if (doc !== document || iconStyle === style) return
  iconStyle = style
  useIconSet(style === 'pixel' ? 'pixel' : 'material')
}

const repaint = (doc: Document): void => {
  const style = styleOf(doc.documentElement)
  syncIcons(doc, style)
  for (const ref of painted) {
    const target = ref.deref()
    if (target === undefined) painted.delete(ref)
    else if (target.ownerDocument === doc) paint(target, style)
  }
}

const observe = (doc: Document): void => {
  if (observed.has(doc)) return
  observed.add(doc)
  new MutationObserver(() => repaint(doc)).observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['data-game-ui', 'data-standard-ui'],
  })
}

/**
 * Bridge Wplace's variables into the package's theme contract, on one Caelestis root.
 *
 * Wplace draws its pixel UI while its root has `data-game-ui` and lacks `data-standard-ui`. The
 * target gets `data-caelestis-style="pixel"` or `"classic"` to match, and that attribute is the
 * only mode the components' styles read. When Wplace changes either attribute, every painted
 * target is repainted and the icon set follows, without a reload.
 */
export const applyWplaceTheme = (target: HTMLElement): void => {
  const doc = target.ownerDocument
  const style = styleOf(doc.documentElement)
  observe(doc)
  painted.add(new WeakRef(target))
  paint(target, style)
  syncIcons(doc, style)
}
