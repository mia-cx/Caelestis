<script lang="ts">
  import { planePoint, type Rgb, type VectorPlane } from '../colour.js'
  import DensityCanvas from './DensityCanvas.svelte'
  import { PLANE_SIZE, paint, type Scatter, underLayer, VECTOR_EXTENT } from './scopes.js'

  /** A colour plane with its primary and secondary targets. Greys sit at the centre. */
  let {
    plane,
    under,
    over,
    zoom,
    onZoom,
  }: {
    plane: VectorPlane
    under?: Scatter | undefined
    over?: Scatter | undefined
    /** How many times the plot is magnified, for images with little saturation. */
    zoom: number
    onZoom: (zoom: number) => void
  } = $props()

  const ZOOMED = 2
  const TARGETS: readonly { label: string; rgb: Rgb }[] = [
    { label: 'R', rgb: [1, 0, 0] },
    { label: 'Yl', rgb: [1, 1, 0] },
    { label: 'G', rgb: [0, 1, 0] },
    { label: 'Cy', rgb: [0, 1, 1] },
    { label: 'B', rgb: [0, 0, 1] },
    { label: 'Mg', rgb: [1, 0, 1] },
  ]
  const FULL = 255
  const THREE_QUARTERS = 191
  /** A mid skin tone. The line through it is where most skin falls, whatever the complexion. */
  const SKIN: Rgb = [228, 155, 128]
  const TARGET_SIZE = 0.07
  const LABEL_OFFSET = 1.16
  const EXTENT = VECTOR_EXTENT

  const image = $derived(
    paint(PLANE_SIZE, PLANE_SIZE, [
      ...(under ? [over ? underLayer(under.density) : { density: under.density, colour: under.sums }] : []),
      ...(over ? [{ density: over.density, colour: over.sums }] : []),
    ]),
  )

  /** A colour's spot in the graticule's units: up is +y, the circle's edge at radius 1. */
  const at = ([r, g, b]: Rgb, level = 1): readonly [number, number] => {
    const [u, v] = planePoint(plane, r * level, g * level, b * level, new Float64Array(3))
    return [u * zoom, -v * zoom]
  }
  const targets = $derived(
    TARGETS.map(({ label, rgb }) => ({ label, full: at(rgb, FULL), threeQuarters: at(rgb, THREE_QUARTERS) })),
  )
  const skin = $derived.by(() => {
    const [x, y] = at(SKIN)
    const length = Math.hypot(x, y) || 1
    return [x / length, y / length] as const
  })
</script>

<div class="frame">
  <div class="screen">
    <DensityCanvas {image} />
    <svg viewBox="{-EXTENT} {-EXTENT} {2 * EXTENT} {2 * EXTENT}" role="img" aria-label="Vectorscope, {plane.label}">
      <circle r="1" class="ring" vector-effect="non-scaling-stroke" />
      <circle r="0.5" class="ring faint" vector-effect="non-scaling-stroke" />
      <line x1="-1" x2="1" class="axis" vector-effect="non-scaling-stroke" />
      <line y1="-1" y2="1" class="axis" vector-effect="non-scaling-stroke" />
      <line x2={skin[0]} y2={skin[1]} class="skin" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
      {#each targets as target (target.label)}
        <rect
          x={target.full[0] - TARGET_SIZE / 2}
          y={target.full[1] - TARGET_SIZE / 2}
          width={TARGET_SIZE}
          height={TARGET_SIZE}
          class="target"
          vector-effect="non-scaling-stroke"
        />
        <circle cx={target.threeQuarters[0]} cy={target.threeQuarters[1]} r="0.014" class="dot" />
        <text
          x={target.full[0] * LABEL_OFFSET}
          y={target.full[1] * LABEL_OFFSET}
          text-anchor="middle"
          dominant-baseline="central"
          font-size="0.07">{target.label}</text
        >
      {/each}
    </svg>
    <span class="caption">{plane.label}</span>
    <button type="button" class="zoom" aria-pressed={zoom === ZOOMED} aria-label="Magnify 2×" onclick={() => onZoom(zoom === ZOOMED ? 1 : ZOOMED)}>2×</button>
  </div>
</div>

<style>
  .frame { container-type: size; display: grid; place-items: center; block-size: 100%; }
  .screen { position: relative; aspect-ratio: 1; inline-size: min(100cqw, 100cqh); background: black; }
  svg { position: absolute; inset: 0; inline-size: 100%; block-size: 100%; }
  .ring { fill: none; stroke: rgb(255 255 255 / 0.25); }
  .ring.faint { stroke: rgb(255 255 255 / 0.08); }
  .axis { stroke: rgb(255 255 255 / 0.1); }
  .skin { stroke: rgb(253 230 138 / 0.45); }
  .target { fill: none; stroke: rgb(255 255 255 / 0.55); }
  .dot { fill: rgb(255 255 255 / 0.45); }
  text { fill: rgb(255 255 255 / 0.6); font-weight: 600; }
  .caption { position: absolute; inset-block-end: 0.375rem; inset-inline-start: 0.5rem; color: rgb(255 255 255 / 0.45); font-size: 0.625rem; }
  .zoom {
    position: absolute;
    inset-block-start: 0.375rem;
    inset-inline-end: 0.375rem;
    padding: 0.125rem 0.5rem;
    border: 0;
    border-radius: 0.25rem;
    background: transparent;
    color: rgb(255 255 255 / 0.55);
    font-size: 0.6875rem;
    cursor: pointer;
  }
  .zoom[aria-pressed='true'] { background: rgb(255 255 255 / 0.15); color: white; }
</style>
