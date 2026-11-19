<script module lang="ts">
  /** Names the source of an imported progress value; Eralyon is the external archive. */
  export const ARCHIVE_SOURCE = 'Eralyon snapshot'

  /** One reader of the pace table: a painter, or everyone together. */
  export interface PaceRow {
    readonly id: string
    readonly name: string
    readonly rates: readonly { readonly window: string; readonly value: number; readonly colour: string }[]
  }
</script>

<script lang="ts">
  /**
   * The readout beside the chart's crosshair. It follows the pointer anywhere on screen, beside it
   * and flipped away from the viewport's edges; a keyboard walk, with no pointer, pins it to the
   * walked point instead.
   */
  import { formatExactCount } from '@caelestis/shared'
  import { prefersReducedMotion } from '@caelestis/ui/motion'
  import { cubicOut } from 'svelte/easing'
  import type { TransitionConfig } from 'svelte/transition'
  import { formatTime } from '#lib/time-format.js'
  import type { Readout } from './pace-model.js'

  let {
    readout,
    now,
    includesImport,
    rows,
    windowCount,
    pointer,
    pinned,
    plot,
  }: {
    readout: Readout | null
    /** The readout is the live right edge. */
    now: boolean
    /** Some pace line at the readout reaches back into imported archive progress. */
    includesImport: boolean
    rows: readonly PaceRow[]
    /** How many rolling windows the rows show, which sets the card's width. */
    windowCount: number
    pointer: { readonly x: number; readonly y: number } | null
    /** Where the walked point sits on screen; read again whenever anything scrolls. */
    pinned: () => { readonly x: number; readonly y: number } | null
    /** Over this element, the wheel scrolls a card that overflows the screen instead of the page. */
    plot: SVGSVGElement | undefined
  } = $props()

  const GAP = 16
  const EDGE = 8
  let viewportWidth = $state(typeof window === 'undefined' ? 1_024 : window.innerWidth)
  let viewportHeight = $state(typeof window === 'undefined' ? 768 : window.innerHeight)
  const width = $derived(
    Math.min(Math.max(0, viewportWidth - 2 * EDGE), Math.max(260, 140 + 112 * windowCount)),
  )
  let card = $state<HTMLDivElement>()
  let height = $state(0)

  let scrolled = $state(0)
  $effect(() => {
    if (readout === null || pointer !== null) return
    const onScroll = (): void => {
      scrolled++
    }
    // Capture: a scrolling container's own scroll events never bubble to the window.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => window.removeEventListener('scroll', onScroll, { capture: true })
  })
  const anchor = $derived.by(() => {
    if (readout === null) return null
    if (pointer !== null) return pointer
    void scrolled
    return pinned()
  })
  const place = $derived.by(() => {
    if (anchor === null) return null
    const flipX = anchor.x + GAP + width > viewportWidth - EDGE
    const flipY = anchor.y + GAP + height > viewportHeight - EDGE
    const left = flipX ? anchor.x - GAP - width : anchor.x + GAP
    const top = flipY ? anchor.y - GAP - height : anchor.y + GAP
    return {
      left: Math.max(EDGE, Math.min(viewportWidth - width - EDGE, left)),
      top: Math.max(EDGE, Math.min(viewportHeight - height - EDGE, top)),
      origin: `${flipX ? '100%' : '0'} ${flipY ? '100%' : '0'}`,
    }
  })

  $effect(() => {
    if (plot === undefined) return
    const onWheel = (event: WheelEvent): void => {
      if (card === undefined || card.scrollHeight <= card.clientHeight) return
      event.preventDefault()
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? card.clientHeight
            : 1
      card.scrollTop += event.deltaY * unit
    }
    plot.addEventListener('wheel', onWheel, { passive: false })
    return () => plot.removeEventListener("wheel", onWheel)
  })

  /** The card lives on the body, so no clipped or transformed ancestor confines it to the chart. */
  const onBody = (node: HTMLElement) => {
    document.body.append(node)
    return () => node.remove()
  }

  /** Pops from the anchored corner, on the transitions.dev tooltip timings. */
  const pop = (_node: Element, { duration }: { duration: number }): TransitionConfig => ({
    duration: prefersReducedMotion() ? 0 : duration,
    easing: cubicOut,
    css: (t) => `opacity:${t};transform:scale(${0.98 + 0.02 * t})`,
  })
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} />

{#if readout !== null && place !== null}
  <div
    class="pointer-events-none fixed z-50 overflow-y-auto overscroll-contain rounded-lg border border-base-300 bg-base-100 px-2.5 py-1.5 text-xs shadow-sm"
    data-pace-tooltip
    {@attach onBody}
    bind:this={card}
    bind:offsetHeight={height}
    in:pop={{ duration: 150 }}
    out:pop={{ duration: 100 }}
    style:transform-origin={place.origin}
    style:top="{place.top}px"
    style:left="{place.left}px"
    style:width="{width}px"
    style:max-height="{viewportHeight - 2 * EDGE}px"
  >
    <div class="font-medium tabular-nums">
      {formatTime(readout.t)}{#if now}<span class="ms-1 text-base-content/50">now</span>{/if}
    </div>
    {#if readout.archive}<div class="text-base-content/60">{ARCHIVE_SOURCE}</div>{/if}
    <div class="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-xs" style:background="var(--chart-correct)"></span>
        <span class="text-base-content/70">correct</span>
        <span>{readout.correct?.toLocaleString() ?? 'No coverage'}</span>
      </span>
      <span class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-xs bg-error"></span>
        <span class="text-base-content/70">mismatched</span>
        <span>{readout.mismatched?.toLocaleString() ?? 'No coverage'}</span>
      </span>
    </div>
    {#if includesImport}
      <p class="mt-2 text-base-content/60">Includes imported net progress.</p>
    {/if}
    {#if rows.length > 0}
      <div class="mt-2 flex items-center justify-between border-t border-base-300 pt-1.5 text-base-content/60">
        <span>Pace</span><span>px/h</span>
      </div>
      <div class="divide-y divide-base-300/60 tabular-nums">
        {#each rows as row (row.id)}
          <div
            data-pace-row={row.id}
            class="grid items-start gap-x-3 gap-y-1 py-1.5 {width < 480 && windowCount > 2
              ? 'grid-cols-1'
              : 'grid-cols-[6rem_minmax(0,1fr)]'}"
          >
            <span class="break-words font-medium">{row.name}</span>
            <div class="grid gap-x-3 gap-y-1" style:grid-template-columns="repeat(auto-fit, minmax(5.5rem, 1fr))">
              {#each row.rates as rate (rate.window)}
                <span data-pace-rate={rate.window} class="flex items-center gap-1 whitespace-nowrap">
                  <span class="size-1.5 shrink-0 rounded-full" style:background={rate.colour} aria-hidden="true"></span>
                  <span class="text-base-content/70">{rate.window}</span>
                  <span class="ms-auto">{formatExactCount(Math.round(rate.value * 10) / 10)}</span>
                </span>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
