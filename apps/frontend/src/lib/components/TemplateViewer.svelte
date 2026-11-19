<script lang="ts">
  import type { TileKey } from '@caelestis/shared'
  import { osmZoomFor } from '@caelestis/social'
  import { Icon } from '@caelestis/ui'
  import { untrack } from 'svelte'
  import { type CanvasRect, FrameImages, type TimelapseLayout } from '#lib/render.js'

  let {
    layout,
    label,
    hashFor,
    overlayAlpha = 1,
    class: className,
  }: {
    /** Matches the server's capture plan, so every tile this viewer draws has snapshots. */
    layout: TimelapseLayout
    /** Names the artwork for the accessible label. */
    label: string
    /** Select the live canvas or a timelapse frame for each tile. */
    hashFor: (key: TileKey) => string | undefined
    overlayAlpha?: number
    class?: string
  } = $props()

  const world = $derived(layout.bounds)
  const art = $derived(layout.art)

  let container = $state<HTMLDivElement | null>(null)
  let visible = $state<HTMLCanvasElement | null>(null)
  let viewWidth = $state(0)
  let viewHeight = $state(0)

  // World-space point at the view origin plus scale: screen = (world - origin) * zoom.
  let zoom = $state(1)
  let originX = $state(0)
  let originY = $state(0)
  let fitted = false

  const MAX_ZOOM = 40

  const fitRect = (rect: CanvasRect, margin: number): void => {
    if (viewWidth === 0 || viewHeight === 0) return
    zoom = Math.min(viewWidth / (rect.width * margin), viewHeight / (rect.height * margin), MAX_ZOOM)
    originX = rect.x + rect.width / 2 - viewWidth / 2 / zoom
    originY = rect.y + rect.height / 2 - viewHeight / 2 / zoom
  }

  const fitToArt = (): void => fitRect(art, 1.15)
  /** The opening view: the artwork inside the surrounding tiles the server mirrors around it. */
  const fitToSurroundings = (): void => fitRect(world, 1)

  const minZoom = $derived(
    viewWidth === 0
      ? 0.01
      : Math.min(viewWidth / world.width, viewHeight / world.height, 1) * 0.9,
  )

  const clampView = (): void => {
    zoom = Math.min(MAX_ZOOM, Math.max(minZoom, zoom))
    // Keep at least a sliver of the world on screen.
    const slack = 200 / zoom
    originX = Math.min(
      world.x + world.width - slack,
      Math.max(world.x - viewWidth / zoom + slack, originX),
    )
    originY = Math.min(
      world.y + world.height - slack,
      Math.max(world.y - viewHeight / zoom + slack, originY),
    )
  }

  const present = (): void => {
    if (viewWidth === 0) return
    const ctx = visible?.getContext('2d') ?? null
    if (ctx === null) return
    const scale = zoom * (window.devicePixelRatio || 1)
    images.draw(ctx, {
      layout,
      view: { x: originX, y: originY, width: viewWidth / zoom, height: viewHeight / zoom },
      scale,
      // No detail floor: a folder spread across the world needs the coarsest levels to stay cheap.
      basemapZoom: osmZoomFor(scale, 0),
      hashFor,
      overlayAlpha,
    })
  }

  const images = new FrameImages(present)

  // Size the visible canvas to the container at device resolution; first fit once measured.
  $effect(() => {
    const element = container
    const canvas = visible
    if (element === null || canvas === null) return
    const observer = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      viewWidth = element.clientWidth
      viewHeight = element.clientHeight
      canvas.width = Math.max(1, Math.round(viewWidth * dpr))
      canvas.height = Math.max(1, Math.round(viewHeight * dpr))
      if (!fitted && viewWidth > 0) {
        fitted = true
        fitToSurroundings()
      }
      images.invalidate()
    })
    observer.observe(element)
    return () => observer.disconnect()
  })

  $effect(() => {
    void zoom
    void originX
    void originY
    void overlayAlpha
    void hashFor
    void layout
    images.invalidate()
  })

  // A route that swaps its templates (a folder link to a subfolder) reuses this viewer, so reframe.
  $effect(() => {
    void layout
    untrack(fitToSurroundings)
  })

  const zoomAt = (screenX: number, screenY: number, factor: number): void => {
    const worldX = originX + screenX / zoom
    const worldY = originY + screenY / zoom
    zoom = Math.min(MAX_ZOOM, Math.max(minZoom, zoom * factor))
    originX = worldX - screenX / zoom
    originY = worldY - screenY / zoom
    clampView()
  }

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    zoomAt(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      Math.exp(-event.deltaY * 0.0022),
    )
  }

  // Drag pan plus two-finger pinch, both through pointer events.
  const pointers = new Map<number, { x: number; y: number }>()
  let pinchDistance = 0

  const onPointerDown = (event: PointerEvent): void => {
    // Capturing here retargets the eventual click to the container, so a press that begins on a
    // zoom button must not start a drag because capture would swallow its click.
    if (event.target instanceof Element && event.target.closest('button') !== null) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      if (a !== undefined && b !== undefined) pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
    }
  }

  const onPointerMove = (event: PointerEvent): void => {
    const previous = pointers.get(event.pointerId)
    if (previous === undefined) return
    const current = { x: event.clientX, y: event.clientY }
    pointers.set(event.pointerId, current)
    if (pointers.size === 1) {
      originX -= (current.x - previous.x) / zoom
      originY -= (current.y - previous.y) / zoom
      clampView()
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      if (a === undefined || b === undefined) return
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinchDistance > 0) {
        const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
        zoomAt(
          (a.x + b.x) / 2 - bounds.left,
          (a.y + b.y) / 2 - bounds.top,
          distance / pinchDistance,
        )
      }
      pinchDistance = distance
    }
  }

  const onPointerUp = (event: PointerEvent): void => {
    pointers.delete(event.pointerId)
    pinchDistance = 0
  }
</script>

<div
  bind:this={container}
  class={['relative touch-none overflow-hidden bg-base-200 select-none', className]}
  role="application"
  aria-label="pannable view of {label} on the canvas"
  onwheel={onWheel}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
>
  <canvas bind:this={visible} class="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
  ></canvas>

  <div class="absolute end-2 top-2 flex flex-col gap-1">
    <button class="btn btn-xs btn-circle border-base-300 bg-base-100/90" aria-label="zoom in" onclick={() => zoomAt(viewWidth / 2, viewHeight / 2, 1.5)}>
      <Icon name="add" class="size-4.5" />
    </button>
    <button class="btn btn-xs btn-circle border-base-300 bg-base-100/90" aria-label="zoom out" onclick={() => zoomAt(viewWidth / 2, viewHeight / 2, 1 / 1.5)}>
      <Icon name="remove" class="size-4.5" />
    </button>
    <button class="btn btn-xs btn-circle border-base-300 bg-base-100/90" aria-label="fit artwork" onclick={() => { fitToArt(); }}>
      <Icon name="fitScreen" class="size-4.5" />
    </button>
  </div>

  <a
    href="https://www.openstreetmap.org/copyright"
    target="_blank"
    rel="noreferrer"
    class="absolute bottom-1 end-2 rounded-lg bg-base-100/70 px-1.5 text-[10px] text-base-content/70"
  >
    © OpenStreetMap
  </a>
</div>
