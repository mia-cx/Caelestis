import type { ColourChannel, CurvePoints, Effect, OneInputCurve } from 'ditherette'

export type EffectKind = Effect['effect']
export type EffectOf<K extends EffectKind> = Extract<Effect, { effect: K }>
export type ChannelName = ColourChannel['channel']
/** Every colour model available to curves and scopes. */
export type CurveModel = ColourChannel['model']

type ChannelInfo = { readonly name: ChannelName; readonly label: string }
type ModelChannels = readonly [ChannelInfo, ChannelInfo, ChannelInfo]
const channel = (name: ChannelName, label: string): ChannelInfo => ({ name, label })
const RGB: ModelChannels = [
  channel('red', 'Red'),
  channel('green', 'Green'),
  channel('blue', 'Blue'),
]
const LAB: ModelChannels = [channel('lightness', 'Lightness'), channel('a', 'a'), channel('b', 'b')]
const LCH: ModelChannels = [
  channel('lightness', 'Lightness'),
  channel('chroma', 'Chroma'),
  channel('hue', 'Hue'),
]

/** Every colour model a curve can read or change, with its channels in canonical order. */
export const CURVE_MODELS: readonly {
  readonly id: CurveModel
  readonly label: string
  readonly channels: ModelChannels
}[] = [
  { id: 'srgb', label: 'RGB', channels: RGB },
  { id: 'linear-rgb', label: 'Linear RGB', channels: RGB },
  {
    id: 'hsl',
    label: 'HSL',
    channels: [
      channel('hue', 'Hue'),
      channel('saturation', 'Saturation'),
      channel('lightness', 'Lightness'),
    ],
  },
  {
    id: 'hsv',
    label: 'HSV',
    channels: [
      channel('hue', 'Hue'),
      channel('saturation', 'Saturation'),
      channel('value', 'Value'),
    ],
  },
  { id: 'oklab', label: 'OKLab', channels: LAB },
  { id: 'oklch', label: 'OKLCH', channels: LCH },
  { id: 'cielab', label: 'CIELAB', channels: LAB },
  { id: 'cielch', label: 'CIELCh', channels: LCH },
  {
    id: 'ycbcr',
    label: 'YCbCr',
    channels: [channel('luma', 'Luma'), channel('cb', 'Cb'), channel('cr', 'Cr')],
  },
]

/** Every channel a curve can read or change, grouped by model. */
export const CURVE_CHANNELS: readonly {
  readonly label: string
  readonly channel: ColourChannel
}[] = CURVE_MODELS.flatMap((model) =>
  model.channels.map(({ name, label }) => ({
    label: `${model.label} · ${label}`,
    // Each model lists only its own channels, so every pair is a valid ColourChannel.
    channel: { model: model.id, channel: name } as ColourChannel,
  })),
)

export const channelKey = ({ model, channel }: ColourChannel) => `${model}:${channel}`
export const channelLabel = (channel: ColourChannel): string =>
  CURVE_CHANNELS.find((option) => channelKey(option.channel) === channelKey(channel))?.label ??
  channelKey(channel)
export const sameChannel = (left: ColourChannel, right: ColourChannel) =>
  channelKey(left) === channelKey(right)

/** The most curves one curves step holds. */
export const MAX_CURVES = 16

export const STRAIGHT: CurvePoints = [
  [0, 0],
  [1, 1],
]
/** A neutral adjustment: no change anywhere. */
export const FLAT: CurvePoints = [
  [0, 0.5],
  [1, 0.5],
]

/**
 * A neutral curve from `x` to `y`: a remap on the diagonal when it reads and writes one channel,
 * otherwise a flat adjustment.
 */
export function neutralCurve(x: ColourChannel, y: ColourChannel): OneInputCurve {
  return sameChannel(x, y)
    ? { kind: 'remap', x, y, points: STRAIGHT }
    : { kind: 'adjust', x, y, points: FLAT }
}

/** New curves steps start with a lightness curve that bends tone without shifting hue. */
const OKLCH_LIGHTNESS: ColourChannel = { model: 'oklch', channel: 'lightness' }

type CatalogEntry<K extends EffectKind> = {
  /** Name shown in menus and given to new instances. */
  readonly label: string
  /** A neutral step: adding it leaves the image unchanged, except palette fit. */
  readonly create: () => EffectOf<K>
}

/** Every built-in effect the website offers, in menu order. */
export const EFFECTS: { readonly [K in EffectKind]: CatalogEntry<K> } = {
  levels: {
    label: 'Levels',
    create: () => ({
      effect: 'levels',
      enabled: true,
      channel: 'rgb',
      input: { black: 0, white: 1 },
      gamma: 1,
      output: { black: 0, white: 1 },
    }),
  },
  curves: {
    label: 'Curves',
    create: () => ({
      effect: 'curves',
      enabled: true,
      curves: [neutralCurve(OKLCH_LIGHTNESS, OKLCH_LIGHTNESS)],
    }),
  },
  'brightness-contrast': {
    label: 'Brightness and contrast',
    create: () => ({ effect: 'brightness-contrast', enabled: true, brightness: 0, contrast: 0 }),
  },
  exposure: {
    label: 'Exposure',
    create: () => ({ effect: 'exposure', enabled: true, stops: 0 }),
  },
  'white-balance': {
    label: 'White balance',
    create: () => ({ effect: 'white-balance', enabled: true, temperature: 0, tint: 0 }),
  },
  'hue-saturation': {
    label: 'Hue and saturation',
    create: () => ({
      effect: 'hue-saturation',
      enabled: true,
      hue: 0,
      saturation: 0,
      lightness: 0,
    }),
  },
  'palette-fit': {
    label: 'Palette fit',
    create: () => ({
      effect: 'palette-fit',
      enabled: true,
      look: 'fitted',
      space: 'oklab',
      strength: 1,
      curves: null,
    }),
  },
  recolour: {
    label: 'Palette fit (legacy)',
    create: () => ({ effect: 'recolour', enabled: true, strength: 1, recipe: null }),
  },
}

export const EFFECT_KINDS = Object.keys(EFFECTS) as EffectKind[]

/** Kinds the add-effect menu offers; legacy kinds stay loadable but cannot be added. */
export const ADDABLE_KINDS = EFFECT_KINDS.filter((kind) => kind !== 'recolour')

/** The working spaces a palette-fit step can analyse in, with their select labels. */
export const FIT_SPACES = [
  { id: 'oklab', label: 'OKLab' },
  { id: 'cielab', label: 'CIELab' },
] as const

/** The package accepts at most 64 steps. */
export const MAX_EFFECT_LAYERS = 64
