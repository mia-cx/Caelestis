<script lang="ts">
import {
  type CanvasTileSummary,
  type Template,
  type TileKey,
  timelapseCaptureRect,
} from '@caelestis/shared'
import {
  drawCanvasTiles,
  drawTemplateChunks,
  osmImage,
  osmSpan,
  osmTileDrawRect,
  osmZoomFor,
} from '#lib/render.js'
import { cn } from '#lib/utils.js'

let {
  template,
  canvas,
  overlayAlpha = 1,
  class: className,
}: {
  template: Template
  /** Latest observed tile per key; missing keys stay transparent (never scanned). */
  canvas: ReadonlyMap<TileKey, CanvasTileSummary>
  /** 0 hides the template art, 1 paints it solid over the observed canvas. */
  overlayAlpha?: number
  class?: string
} = $props()

// The same surroundings the viewer opens on and the timelapse captures, so a card shows the artwork
// in its neighbourhood over the map rather than cropped to its own tiles.
const rect = $derived.by(() => {
  const capture = timelapseCaptureRect(template.bbox)
  const x = Math.floor(capture.x)
  const y = Math.floor(capture.y)
  return {
    x,
    y,
    width: Math.ceil(capture.x + capture.width) - x,
    height: Math.ceil(capture.y + capture.height) - y,
  }
})

let container = $state<HTMLDivElement | null>(null)
let shownHeight = $state(0)
/** Set once the card first nears the viewport; nothing loads or allocates before that. */
let seen = $state(false)

$effect(() => {
  const element = container
  if (element === null || seen) return
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) seen = true
    },
    { rootMargin: '200px' },
  )
  observer.observe(element)
  return () => observer.disconnect()
})

// Canvas pixels per world pixel: the card's device resolution rounded up to a power of two, so
// small resizes keep the drawing, and never above 1:1.
const scale = $derived(
  shownHeight === 0
    ? 0
    : Math.min(1, 2 ** Math.ceil(Math.log2((shownHeight * devicePixelRatio) / rect.height))),
)
const canvasWidth = $derived(Math.ceil(rect.width * scale))
const canvasHeight = $derived(Math.ceil(rect.height * scale))

let osmLayer = $state<HTMLCanvasElement | null>(null)
let tilesLayer = $state<HTMLCanvasElement | null>(null)
let artLayer = $state<HTMLCanvasElement | null>(null)

/** A layer's context drawing in world pixels, cleared, or null before the layer exists. */
const worldContext = (layer: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
  const ctx = layer?.getContext('2d') ?? null
  if (ctx === null) return null
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return ctx
}

// The basemap under everything, like wplace itself, at the slippy zoom for the card's on-screen
// density rather than the rect's native resolution. Derived, so a resize within one zoom keeps it.
const osmZoom = $derived(osmZoomFor(shownHeight / rect.height))
$effect(() => {
  const ctx = worldContext(osmLayer)
  if (ctx === null) return
  const controller = new AbortController()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  const z = osmZoom
  const span = osmSpan(z)
  for (let ty = Math.floor(rect.y / span); ty <= Math.floor((rect.y + rect.height - 1) / span); ty++) {
    for (let tx = Math.floor(rect.x / span); tx <= Math.floor((rect.x + rect.width - 1) / span); tx++) {
      osmImage(z, ((tx % 2 ** z) + 2 ** z) % 2 ** z, ty)
        .then((image) => {
          if (controller.signal.aborted) return
          const tile = osmTileDrawRect(tx, ty, span, scale)
          ctx.drawImage(image, tile.x - rect.x, tile.y - rect.y, tile.width, tile.height)
        })
        .catch(() => {})
    }
  }
  return () => controller.abort()
})

// The observed canvas and the template art live on separate stacked layers, so the overlay
// slider is a CSS opacity change rather than a recomposite of every image.
$effect(() => {
  const ctx = worldContext(tilesLayer)
  if (ctx === null) return
  const controller = new AbortController()
  ctx.imageSmoothingEnabled = false
  drawCanvasTiles(ctx, rect, (key) => canvas.get(key)?.hash, controller.signal, () => {})
  return () => controller.abort()
})

$effect(() => {
  const ctx = worldContext(artLayer)
  if (ctx === null) return
  const controller = new AbortController()
  ctx.imageSmoothingEnabled = false
  drawTemplateChunks(ctx, rect, template, 1, controller.signal, () => {})
  return () => controller.abort()
})
</script>

<div
  bind:this={container}
  bind:clientHeight={shownHeight}
  class={cn('relative overflow-hidden bg-base-200', className)}
  style:aspect-ratio="{rect.width} / {rect.height}"
>
  {#if seen && scale > 0}
    <canvas
      bind:this={osmLayer}
      width={canvasWidth}
      height={canvasHeight}
      class="absolute inset-0 h-full w-full"
      aria-hidden="true"
    ></canvas>
    <canvas
      bind:this={tilesLayer}
      width={canvasWidth}
      height={canvasHeight}
      class="pixelated absolute inset-0 h-full w-full"
      aria-label="observed canvas under {template.name}"
    ></canvas>
    <canvas
      bind:this={artLayer}
      width={canvasWidth}
      height={canvasHeight}
      class="pixelated absolute inset-0 h-full w-full"
      style:opacity={overlayAlpha}
      aria-label="{template.name} template art"
    ></canvas>
  {/if}
</div>
