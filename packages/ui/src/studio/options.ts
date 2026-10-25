/**
 * The template studio's choices, in menu order, with the names and descriptions Ditherette web
 * gives them. The userscript turns the ids into a Ditherette recipe.
 */

export type ResizeId =
  | 'nearest'
  | 'bilinear'
  | 'trilinear'
  | 'bicubic'
  | 'bicubic-scale-aware'
  | 'lanczos2'
  | 'lanczos2-scale-aware'
  | 'lanczos3'
  | 'lanczos3-scale-aware'
  | 'area'

export const RESIZE_MODES = [
  { id: 'nearest', label: 'Nearest' },
  { id: 'bilinear', label: 'Bilinear' },
  { id: 'trilinear', label: 'Trilinear' },
  { id: 'bicubic', label: 'Bicubic' },
  { id: 'bicubic-scale-aware', label: 'Bicubic AA (slow)' },
  { id: 'lanczos2', label: 'Lanczos2' },
  { id: 'lanczos2-scale-aware', label: 'Lanczos2 AA (slow)' },
  { id: 'lanczos3', label: 'Lanczos3' },
  { id: 'lanczos3-scale-aware', label: 'Lanczos3 AA (slow)' },
  { id: 'area', label: 'Area / Box' },
] as const satisfies readonly { id: ResizeId; label: string }[]

/** Which part of the source stays pinned when the output's proportions differ; Area ignores it. */
export type ResizeAnchor =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right'

/** Row-major, so arrow keys move by one across and three down. */
export const ANCHORS = [
  { id: 'top-left', label: 'Top left' },
  { id: 'top', label: 'Top' },
  { id: 'top-right', label: 'Top right' },
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'bottom-right', label: 'Bottom right' },
] as const satisfies readonly { id: ResizeAnchor; label: string }[]

export type AlphaMode = 'preserve' | 'premultiplied' | 'matte'

export const ALPHA_MODES = [
  { id: 'preserve', label: 'Preserve transparency' },
  { id: 'premultiplied', label: 'Premultiplied' },
  { id: 'matte', label: 'Matte' },
] as const satisfies readonly { id: AlphaMode; label: string }[]

export type ColorSpaceId =
  | 'oklab'
  | 'srgb'
  | 'linear-rgb'
  | 'weighted-rgb'
  | 'weighted-rgb-601'
  | 'weighted-rgb-709'
  | 'oklch'
  | 'oklch-circular-hue'
  | 'oklch-euclidean'
  | 'cielab'
  | 'cielab-ciede2000'
  | 'cielch'
  | 'cielch-circular-hue'
  | 'cielch-euclidean'
  | 'ycbcr'

export const COLOR_SPACES = [
  {
    id: 'oklab',
    label: 'OKLab',
    description:
      'Picks the palette colour that looks closest, balancing brightness, colourfulness, and hue. The best place to start.',
  },
  {
    id: 'srgb',
    label: 'sRGB',
    description:
      'Compares raw screen values. Results tend to be duller than with OKLab, and shadows drift in brightness.',
  },
  {
    id: 'linear-rgb',
    label: 'Linear RGB',
    description:
      'Compares amounts of light. Dark colours measure as nearly the same, so shadows lose the most detail of any mode.',
  },
  {
    id: 'weighted-rgb',
    label: 'Weighted RGB',
    description:
      'A quick fix for sRGB that weighs green most, and red or blue more depending on how red the colour is. A little closer to what you see than sRGB.',
  },
  {
    id: 'weighted-rgb-601',
    label: 'Weighted RGB · Rec.601',
    description:
      'Weighs green most and blue least, as TV brightness does. Shading holds up better than in sRGB, but blues can fade to grey.',
  },
  {
    id: 'weighted-rgb-709',
    label: 'Weighted RGB · Rec.709',
    description:
      'Like Rec.601, with even more weight on green. The best shading of the RGB modes, and the most blues fading to grey.',
  },
  {
    id: 'oklch',
    label: 'OKLCH',
    description:
      'OKLab described by lightness, chroma, and hue angle instead of two colour axes. Hue counts only as much as the duller of two colours is colourful, so vivid areas keep their hue and stay more colourful than with OKLab.',
  },
  {
    id: 'oklch-circular-hue',
    label: 'OKLCH · circular hue',
    description:
      'Measures the same distance as OKLab, so it picks exactly the same colours. It only differs with Dither in selected space: error then spreads as lightness, chroma, and hue, which leaves dithered areas duller.',
  },
  {
    id: 'oklch-euclidean',
    label: 'OKLCH · Euclidean',
    description:
      'Compares hue angle as a plain number, which outweighs lightness and chroma. Hue stays closest of any mode, but greys pick up colour, brightness drifts, and reds either side of 0° count as opposites.',
  },
  {
    id: 'cielab',
    label: 'CIELAB ΔE76',
    description:
      'The classic perceptual space, older than OKLab. It holds hue more closely than OKLab, but brightness drifts more.',
  },
  {
    id: 'cielab-ciede2000',
    label: 'CIELAB ΔE2000',
    description:
      "CIE's 2000 correction to CIELAB for blues, greys, and vivid colours. It keeps more colour than OKLab at some cost in brightness, and it's the slowest mode.",
  },
  {
    id: 'cielch',
    label: 'CIELCh',
    description:
      'CIELAB described by lightness, chroma, and hue angle. As in OKLCH, hue counts only as much as the duller of two colours is colourful.',
  },
  {
    id: 'cielch-circular-hue',
    label: 'CIELCh · circular hue',
    description:
      'Measures the same distance as CIELAB ΔE76, so it picks exactly the same colours. It only differs with Dither in selected space, where error spreads as lightness, chroma, and hue.',
  },
  {
    id: 'cielch-euclidean',
    label: 'CIELCh · Euclidean',
    description:
      "Compares hue angle as a plain number, but CIELCh's angle is tiny next to its lightness and chroma, so hue barely counts, except across 0°, where reds either side count as far apart. Otherwise it matches brightness and colourfulness and lets hue change freely.",
  },
  {
    id: 'ycbcr',
    label: 'YCbCr',
    description:
      'Splits brightness from colour, as video does, and weighs them equally. Results land close to the weighted RGB modes.',
  },
] as const satisfies readonly { id: ColorSpaceId; label: string; description: string }[]

export type DitherId =
  | 'none'
  | 'bayer-2'
  | 'bayer-4'
  | 'bayer-8'
  | 'bayer-16'
  | 'ordered-3x1'
  | 'ordered-4x1'
  | 'ordered-4x2'
  | 'ordered-5x3'
  | 'floyd-steinberg'
  | 'sierra'
  | 'sierra-lite'
  | 'atkinson'
  | 'jarvis-judice-ninke'
  | 'stucki'
  | 'burkes'
  | 'two-row-sierra'
  | 'fan'
  | 'shiau-fan'
  | 'shiau-fan-2'
  | 'simple-2d'
  | 'random'
  | 'blue-noise'
  | 'yliluoma-2'
  | 'yliluoma-4'
  | 'yliluoma-8'
  | 'yliluoma-16'

/** Ordered thresholds, error diffusion, noise, or Yliluoma's two-colour mixing. */
export type DitherFamily = 'none' | 'ordered' | 'error-diffusion' | 'noise' | 'mixing'

export interface DitherOption {
  readonly id: DitherId
  readonly label: string
  readonly family: DitherFamily
  readonly description: string
}

const yliluoma = (size: 2 | 4 | 8 | 16, description: string) =>
  ({
    id: `yliluoma-${size}`,
    label: `Yliluoma ${size}×${size}`,
    family: 'mixing',
    description,
  }) as const

const orderedTile = (tile: '3x1' | '4x1' | '4x2' | '5x3', description: string) =>
  ({
    id: `ordered-${tile}`,
    label: `Ordered ${tile.replace('x', '×')}`,
    family: 'ordered',
    description,
  }) as const

const kernel = <const Id extends DitherId>(id: Id, label: string, description: string) =>
  ({ id, label, family: 'error-diffusion', description }) as const

export const DITHER_ALGORITHMS = [
  {
    id: 'none',
    label: 'None',
    family: 'none',
    description:
      'Maps every pixel directly to its nearest palette colour. No texture is added, so edges stay clean, but smooth gradients can collapse into harsh flat bands.',
  },
  {
    id: 'bayer-2',
    label: 'Bayer 2×2',
    family: 'ordered',
    description:
      'Tiny ordered matrix with a loud checker texture. Good for chunky retro structure and previewing threshold strength; repetition is very obvious.',
  },
  {
    id: 'bayer-4',
    label: 'Bayer 4×4',
    family: 'ordered',
    description:
      'Balanced ordered matrix with visible but manageable texture. A practical default when you want crisp, deterministic dithering without diffusion trails.',
  },
  {
    id: 'bayer-8',
    label: 'Bayer 8×8',
    family: 'ordered',
    description:
      'Larger ordered matrix that spreads thresholds across more pixels. Gradients look smoother than 4×4, but the repeating tile is still part of the look.',
  },
  {
    id: 'bayer-16',
    label: 'Bayer 16×16',
    family: 'ordered',
    description:
      'Fine ordered matrix with the least chunky Bayer texture. Best when you want deterministic dithering that reads smoother at normal viewing distance.',
  },
  orderedTile(
    '3x1',
    'A three-pixel tile, one row tall, so every row repeats the same thresholds. Texture forms vertical lines with only three levels: coarse and deliberately stripy.',
  ),
  orderedTile(
    '4x1',
    'A four-pixel tile, one row tall. The same vertical-line texture as 3×1, with one more step between tones.',
  ),
  orderedTile(
    '4x2',
    'Eight threshold levels in a tile twice as wide as it is tall. The texture sits between the 4×1 lines and a square Bayer 4×4.',
  ),
  orderedTile(
    '5x3',
    'Fifteen threshold levels in a hand-designed tile by Joel Yliluoma. Its odd size avoids the power-of-two grid look of Bayer matrices.',
  ),
  kernel(
    'floyd-steinberg',
    'Floyd–Steinberg',
    'Classic error diffusion that pushes quantisation error into four nearby future pixels. Gradients look organic, but texture can form worms and directional streaks.',
  ),
  kernel(
    'sierra',
    'Sierra',
    'Spreads error across a wider three-row neighbourhood. Softer and less speckled than Floyd–Steinberg, at the cost of a slightly blurrier texture.',
  ),
  kernel(
    'sierra-lite',
    'Sierra Lite',
    'Small diffusion kernel with strong directionality. Fast and punchy, useful when Floyd–Steinberg feels too busy but direct quantisation is too banded.',
  ),
  kernel(
    'atkinson',
    'Atkinson',
    'The classic Macintosh kernel. It passes on only three quarters of the error, so highlights and shadows settle into flat colour while midtones keep a crisp, high-contrast texture.',
  ),
  kernel(
    'jarvis-judice-ninke',
    'Jarvis–Judice–Ninke',
    'Spreads error over twelve pixels across three rows. Gradients come out very smooth with few worms, but fine detail softens.',
  ),
  kernel(
    'stucki',
    'Stucki',
    'The same twelve-pixel reach as Jarvis–Judice–Ninke, with more weight on the nearest pixels. Just as smooth, with crisper edges.',
  ),
  kernel(
    'burkes',
    'Burkes',
    'A two-row cut of Stucki that sends error to seven pixels. Close to the Stucki look while touching one row fewer.',
  ),
  kernel(
    'two-row-sierra',
    'Two-row Sierra',
    'The two-row variant of Sierra, also called Sierra2. Seven pixels share the error, a middle ground between Sierra and Sierra Lite.',
  ),
  kernel(
    'fan',
    'Fan',
    'A four-pixel kernel by Zhigang Fan that reaches two pixels back on the next row. It breaks up the worms Floyd–Steinberg leaves in smooth areas.',
  ),
  kernel(
    'shiau-fan',
    'Shiau–Fan',
    'A four-pixel kernel weighted in eighths, designed to reduce worm artefacts in highlights and shadows.',
  ),
  kernel(
    'shiau-fan-2',
    'Shiau–Fan 2',
    'The five-pixel Shiau–Fan kernel, reaching three pixels back on the next row. Worms break up further for a more even texture.',
  ),
  kernel(
    'simple-2d',
    'Simple 2D',
    'Sends half the error right and half straight down. The simplest kernel: fast, with a cruder texture than Floyd–Steinberg.',
  ),
  {
    id: 'random',
    label: 'Random',
    family: 'noise',
    description:
      'Adds deterministic white-noise thresholding before palette matching. It avoids visible tiles, but the result is grainier and less structured than ordered matrices.',
  },
  {
    id: 'blue-noise',
    label: 'Blue noise',
    family: 'noise',
    description:
      'Thresholds against a 32×32 void-and-cluster tile. The grain is fine and evenly spread, so gradients read smoother than white noise without the crosshatch of a Bayer matrix.',
  },
  yliluoma(
    2,
    'Coarse two-colour mixing with a visible 2×2 pattern. Flat areas become exact palette blends at a few mixing ratios.',
  ),
  yliluoma(
    4,
    'Two-colour mixing over a 4×4 pattern. A good balance between smooth blends and a readable, retro texture.',
  ),
  yliluoma(
    8,
    'Two-colour mixing over an 8×8 pattern. More mixing ratios make gradients smoother, at a slower search.',
  ),
  yliluoma(
    16,
    'Two-colour mixing over a 16×16 pattern. The finest blends and the slowest search; best for small outputs.',
  ),
] as const satisfies readonly DitherOption[]

export type DitherPlacement = 'everywhere' | 'adaptive'

export const PLACEMENT_MODES = [
  { id: 'everywhere', label: 'Everywhere' },
  { id: 'adaptive', label: 'Adaptive' },
] as const satisfies readonly { id: DitherPlacement; label: string }[]
