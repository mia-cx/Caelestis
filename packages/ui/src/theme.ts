/**
 * The stable theme contract every Caelestis surface reads. The `pixel*` tokens mirror Wplace's
 * own `--pixel-*` palette; only the pixel-style rules read them, so classic surfaces can ignore
 * them entirely.
 */
export interface CaelestisThemeTokens {
  readonly surface: string
  readonly raisedSurface: string
  readonly text: string
  readonly mutedText: string
  readonly border: string
  readonly focus: string
  readonly primary: string
  readonly warning: string
  readonly success: string
  readonly danger: string
  readonly finished: string
  readonly frozen: string
  readonly radius: string
  readonly pillRadius: string
  readonly font: string
  readonly monoFont: string
  readonly compactTarget: string
  readonly touchTarget: string
  readonly shadow: string
  readonly popoverShadow: string
  readonly motionDuration: string
  readonly pixelInk: string
  readonly pixelShadow: string
  readonly pixelButton: string
  readonly pixelButtonLight: string
  readonly pixelButtonShade: string
  readonly pixelPrimaryLight: string
  readonly pixelPrimaryShade: string
  readonly pixelFieldShade: string
  readonly pixelWell: string
  readonly pixelWellShade: string
  readonly pixelThumb: string
}

export type CaelestisThemeToken = keyof CaelestisThemeTokens

const PROPERTIES: Record<CaelestisThemeToken, `--caelestis-${string}`> = {
  surface: '--caelestis-surface',
  raisedSurface: '--caelestis-raised-surface',
  text: '--caelestis-text',
  mutedText: '--caelestis-muted-text',
  border: '--caelestis-border',
  focus: '--caelestis-focus',
  primary: '--caelestis-primary',
  warning: '--caelestis-warning',
  success: '--caelestis-success',
  danger: '--caelestis-danger',
  finished: '--caelestis-finished',
  frozen: '--caelestis-frozen',
  radius: '--caelestis-radius',
  pillRadius: '--caelestis-pill-radius',
  font: '--caelestis-font',
  monoFont: '--caelestis-mono-font',
  compactTarget: '--caelestis-compact-target',
  touchTarget: '--caelestis-touch-target',
  shadow: '--caelestis-shadow',
  popoverShadow: '--caelestis-popover-shadow',
  motionDuration: '--caelestis-motion-duration',
  pixelInk: '--caelestis-pixel-ink',
  pixelShadow: '--caelestis-pixel-shadow',
  pixelButton: '--caelestis-pixel-button',
  pixelButtonLight: '--caelestis-pixel-button-light',
  pixelButtonShade: '--caelestis-pixel-button-shade',
  pixelPrimaryLight: '--caelestis-pixel-primary-light',
  pixelPrimaryShade: '--caelestis-pixel-primary-shade',
  pixelFieldShade: '--caelestis-pixel-field-shade',
  pixelWell: '--caelestis-pixel-well',
  pixelWellShade: '--caelestis-pixel-well-shade',
  pixelThumb: '--caelestis-pixel-thumb',
}

export const themeProperty = (token: CaelestisThemeToken): `--caelestis-${string}` =>
  PROPERTIES[token]

export const applyThemeTokens = (
  target: HTMLElement,
  tokens: Partial<CaelestisThemeTokens>,
): void => {
  for (const [token, value] of Object.entries(tokens) as Array<
    [CaelestisThemeToken, string | undefined]
  >) {
    if (value !== undefined) target.style.setProperty(PROPERTIES[token], value)
  }
}
