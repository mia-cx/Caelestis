<script lang="ts">
import type { Template } from '@caelestis/shared'
import { osmZoomFor } from '@caelestis/social'
import { FrameImages, timelapseLayout } from '#lib/render.js'
import { useApp } from '#lib/state/app.svelte.js'

let { template, class: className }: { template: Template; class?: string } = $props()

const app = useApp()

// The same surroundings the viewer opens on and the timelapse captures, so a card shows the artwork
// in its neighbourhood over the map rather than cropped to its own tiles.
const layout = $derived(timelapseLayout([template]))
const rect = $derived.by(() => {
  const { bounds } = layout
  const x = Math.floor(bounds.x)
  const y = Math.floor(bounds.y)
  return {
    x,
    y,
    width: Math.ceil(bounds.x + bounds.width) - x,
    height: Math.ceil(bounds.y + bounds.height) - y,
  }
})

let container = $state<HTMLDivElement | null>(null)
let canvasElement = $state<HTMLCanvasElement | null>(null)
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

const draw = (): void => {
  const ctx = canvasElement?.getContext('2d') ?? null
  if (ctx === null) return
  images.draw(ctx, {
    layout,
    view: rect,
    scale,
    // The slippy zoom for the card's on-screen density rather than the rect's native resolution.
    basemapZoom: osmZoomFor(shownHeight / rect.height),
    hashFor: (key) => app.canvas.get(key)?.hash,
    overlayAlpha: 1,
  })
}
const images = new FrameImages(draw)

$effect(draw)
</script>

<div
  bind:this={container}
  bind:clientHeight={shownHeight}
  class={['relative overflow-hidden bg-base-200', className]}
  style:aspect-ratio="{rect.width} / {rect.height}"
>
  {#if seen && scale > 0}
    <canvas
      bind:this={canvasElement}
      width={Math.ceil(rect.width * scale)}
      height={Math.ceil(rect.height * scale)}
      class="pixelated absolute inset-0 h-full w-full"
      aria-label="{template.name} over the observed canvas"
    ></canvas>
  {/if}
</div>
