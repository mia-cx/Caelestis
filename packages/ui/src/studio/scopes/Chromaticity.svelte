<script lang="ts">
  import { D65, SPECTRAL_LOCUS, SRGB_PRIMARIES, XY_BOUNDS } from '../colour.js'
  import DensityCanvas from './DensityCanvas.svelte'
  import { chromaticityBackdrop, PLANE_SIZE, paint, type Scatter, underLayer } from './scopes.js'

  /** Samples on the CIE 1931 xy diagram, inside the spectral locus, against the sRGB gamut. */
  let { under, over }: { under?: Scatter | undefined; over?: Scatter | undefined } = $props()

  const LABELLED_NM = [460, 480, 500, 520, 540, 560, 580, 600, 620]
  const LABEL_OFFSET = 0.035
  const GRID = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]

  const image = $derived(
    paint(PLANE_SIZE, PLANE_SIZE, [
      chromaticityBackdrop(),
      ...(under ? [over ? underLayer(under.density) : { density: under.density, colour: under.sums }] : []),
      ...(over ? [{ density: over.density, colour: over.sums }] : []),
    ]),
  )

  /** xy to the graticule's units, with y up. */
  const point = ([x, y]: readonly [number, number]): readonly [number, number] => [x, XY_BOUNDS.y - y]
  const points = (list: readonly (readonly [number, number])[]): string =>
    list.map((xy) => point(xy).join(',')).join(' ')
  const locus = SPECTRAL_LOCUS.map(([, x, y]) => [x, y] as const)
  /** Wavelength labels, pushed outward from the white point so they sit outside the locus. */
  const labels = LABELLED_NM.flatMap((nm) => {
    const found = SPECTRAL_LOCUS.find(([wavelength]) => wavelength === nm)
    if (found === undefined) return []
    const [, x, y] = found
    const [dx, dy] = [x - D65[0], y - D65[1]]
    const length = Math.hypot(dx, dy)
    return [{ nm, at: point([x + (dx / length) * LABEL_OFFSET, y + (dy / length) * LABEL_OFFSET]) }]
  })
</script>

<div class="frame">
  <div class="screen" role="img" aria-label="CIE 1931 chromaticity">
    <DensityCanvas {image} />
    <svg viewBox="0 0 {XY_BOUNDS.x} {XY_BOUNDS.y}">
      {#each GRID as line (line)}
        <line x1={line} x2={line} y2={XY_BOUNDS.y} class="grid" vector-effect="non-scaling-stroke" />
        <line y1={XY_BOUNDS.y - line} y2={XY_BOUNDS.y - line} x2={XY_BOUNDS.x} class="grid" vector-effect="non-scaling-stroke" />
      {/each}
      <polygon points={points(locus)} class="locus" vector-effect="non-scaling-stroke" />
      <polygon points={points(SRGB_PRIMARIES)} class="gamut" vector-effect="non-scaling-stroke" />
      <circle cx={point(D65)[0]} cy={point(D65)[1]} r="0.006" class="white" vector-effect="non-scaling-stroke" />
      {#each labels as label (label.nm)}
        <text x={label.at[0]} y={label.at[1]} text-anchor="middle" dominant-baseline="central" font-size="0.02">{label.nm}</text>
      {/each}
    </svg>
    <span class="caption">sRGB · D65</span>
  </div>
</div>

<style>
  .frame { container-type: size; display: grid; place-items: center; block-size: 100%; }
  .screen { position: relative; aspect-ratio: 8 / 9; inline-size: min(100cqw, calc(100cqh * 8 / 9)); background: black; }
  svg { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; overflow: visible; }
  .grid { stroke: rgb(255 255 255 / 0.06); }
  .locus { fill: none; stroke: rgb(255 255 255 / 0.45); }
  .gamut { fill: none; stroke: rgb(255 255 255 / 0.8); }
  .white { fill: none; stroke: white; }
  text { fill: rgb(255 255 255 / 0.45); }
  .caption { position: absolute; inset-block-end: 0.375rem; inset-inline-end: 0.5rem; color: rgb(255 255 255 / 0.45); font-size: 0.625rem; }
</style>
