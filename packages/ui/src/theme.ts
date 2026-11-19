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
  readonly primaryContent: string
  readonly warning: string
  readonly warningContent: string
  readonly success: string
  readonly successContent: string
  readonly danger: string
  readonly dangerContent: string
  readonly radius: string
  readonly pillRadius: string
  readonly font: string
  readonly monoFont: string
  readonly touchTarget: string
  readonly shadow: string
  readonly popoverShadow: string
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
  readonly durationStagger: string
  readonly durationMicro: string
  readonly durationQuick: string
  readonly durationFast: string
  readonly durationMedium: string
  readonly easeSmoothOut: string
  readonly easeBounce: string
  readonly distanceMicro: string
  readonly distanceSmall: string
  readonly distanceBase: string
  readonly distanceMedium: string
  readonly distanceLarge: string
  readonly scaleLarge: string
  readonly scaleMedium: string
  readonly scaleSmall: string
  readonly scaleTiny: string
  readonly blurSmall: string
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
  primaryContent: '--caelestis-primary-content',
  warning: '--caelestis-warning',
  warningContent: '--caelestis-warning-content',
  success: '--caelestis-success',
  successContent: '--caelestis-success-content',
  danger: '--caelestis-danger',
  dangerContent: '--caelestis-danger-content',
  radius: '--caelestis-radius',
  pillRadius: '--caelestis-pill-radius',
  font: '--caelestis-font',
  monoFont: '--caelestis-mono-font',
  touchTarget: '--caelestis-touch-target',
  shadow: '--caelestis-shadow',
  popoverShadow: '--caelestis-popover-shadow',
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
  durationStagger: '--caelestis-duration-stagger',
  durationMicro: '--caelestis-duration-micro',
  durationQuick: '--caelestis-duration-quick',
  durationFast: '--caelestis-duration-fast',
  durationMedium: '--caelestis-duration-medium',
  easeSmoothOut: '--caelestis-ease-smooth-out',
  easeBounce: '--caelestis-ease-bounce',
  distanceMicro: '--caelestis-distance-micro',
  distanceSmall: '--caelestis-distance-small',
  distanceBase: '--caelestis-distance-base',
  distanceMedium: '--caelestis-distance-medium',
  distanceLarge: '--caelestis-distance-large',
  scaleLarge: '--caelestis-scale-large',
  scaleMedium: '--caelestis-scale-medium',
  scaleSmall: '--caelestis-scale-small',
  scaleTiny: '--caelestis-scale-tiny',
  blurSmall: '--caelestis-blur-small',
}

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
