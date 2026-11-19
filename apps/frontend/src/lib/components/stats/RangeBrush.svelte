<script lang="ts">
  /**
   * The strip under the chart: the whole fetched range in miniature, with the shown window on it.
   * Drag a grip to resize the window, drag the window to slide it, drag empty track to draw a fresh
   * one. The grips are sliders, so the keyboard does the same.
   */
  import { formatTime } from '#lib/time-format.js'
  import { DRAG_THRESHOLD_PX, followPointer } from './pointer-drag.js'
  import { type PaceRatePoint, snapTime } from './progress-pace.js'
  import { type ChartWindow, windowKeyStep } from './time-window.svelte.js'

  let {
    timeWindow,
    from,
    to,
    resolution,
    width,
    plotLeft,
    plotWidth,
    series,
    playhead,
    dragging = $bindable(false),
  }: {
    timeWindow: ChartWindow
    from: number
    to: number
    resolution: number
    width: number
    /** Where the chart's plot starts and how wide it is, so the strip lines up under it. */
    plotLeft: number
    plotWidth: number
    /** The miniature's outline; single points draw as ticks. */
    series: readonly (readonly PaceRatePoint[])[]
    playhead: number | null
    /** A drag on the strip is under way, so the chart moves its window without a tween. */
    dragging?: boolean
  } = $props()

  const HEIGHT = 40
  const INSET = 4
  const BASELINE = HEIGHT - INSET
  const OBSERVATION_HALF_WIDTH = 2
  const TARGET_SIZE = 44
  const GRIP_TARGET_SIZE = TARGET_SIZE * 1.5

  const view = $derived(timeWindow.view)
  const span = $derived(timeWindow.span)
  const minSelection = $derived(timeWindow.minSelection)
  const keyStep = $derived(windowKeyStep(span, resolution))

  const bx = $derived((t: number) => plotLeft + ((t - from) / Math.max(1, span)) * plotWidth)
  const timeAt = (clientX: number, left: number): number =>
    snapTime(from + ((clientX - left - plotLeft) / plotWidth) * span, resolution, from, to)

  const geometry = $derived.by(() => {
    const max = Math.max(1, ...series.flatMap((segment) => segment.map((point) => point.v)))
    const y = (v: number) => BASELINE - (v / max) * (HEIGHT - 2 * INSET)
    const outline = series
      .filter((segment) => segment.length > 1)
      .map((segment) => {
        const first = segment[0]
        const last = segment.at(-1)
        if (first === undefined || last === undefined) return ''
        const top = segment
          .map((point, index) => `${index === 0 ? 'M' : 'L'}${bx(point.t).toFixed(1)},${y(point.v).toFixed(1)}`)
          .join('')
        return `${top}L${bx(last.t).toFixed(1)},${BASELINE}L${bx(first.t).toFixed(1)},${BASELINE}Z`
      })
      .join('')
    const isolated = series
      .filter((segment) => segment.length === 1)
      .flat()
      .map((point) => ({ x: bx(point.t), y: y(point.v) }))
    return { outline, isolated }
  })

  const shownPlayhead = $derived(
    playhead !== null && playhead >= from && playhead <= to ? playhead : null,
  )

  type Edge = 'head' | 'tail'
  let drag = $state<Edge | 'move' | 'new' | null>(null)

  const moveTargetWidth = $derived(Math.max(TARGET_SIZE, bx(view.to) - bx(view.from)))
  const moveTargetLeft = $derived((bx(view.from) + bx(view.to) - moveTargetWidth) / 2)

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return
    const strip = event.currentTarget as HTMLDivElement
    const target = event.target instanceof Element ? event.target : null
    const grip = target?.closest<HTMLElement>('[data-handle]') ?? null
    const t = timeAt(event.clientX, strip.getBoundingClientRect().left)
    const start = view
    const kind =
      grip?.dataset.handle === 'head'
        ? 'head'
        : grip?.dataset.handle === 'tail'
          ? 'tail'
          : target?.closest('[data-brush-move]') || (t > start.from && t < start.to)
            ? 'move'
            : 'new'
    const grabOffset = t - start.from
    const startX = event.clientX
    let moved = false
    drag = kind
    dragging = true
    event.preventDefault()
    grip?.focus({ preventScroll: true })
    followPointer(event.pointerId, {
      move: (move) => {
        const current = timeAt(move.clientX, strip.getBoundingClientRect().left)
        if (!moved && Math.abs(move.clientX - startX) > DRAG_THRESHOLD_PX) moved = true
        switch (kind) {
          case 'head':
            timeWindow.select({ from: Math.min(current, view.to - minSelection), to: view.to })
            break
          case 'tail':
            timeWindow.select({ from: view.from, to: Math.max(current, view.from + minSelection) })
            break
          case 'move': {
            const size = start.to - start.from
            const next = Math.min(to - size, Math.max(from, current - grabOffset))
            timeWindow.select({ from: next, to: next + size })
            break
          }
          case 'new':
            if (moved) timeWindow.select({ from: Math.min(t, current), to: Math.max(t, current) })
            break
        }
      },
      end: () => {
        drag = null
        dragging = false
      },
    })
  }

  const onGripKey = (edge: Edge, event: KeyboardEvent): void => {
    const step = keyStep * (event.shiftKey ? 10 : 1)
    let delta: number | null = null
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        delta = -step
        break
      case 'ArrowRight':
      case 'ArrowUp':
        delta = step
        break
      case 'PageDown':
        delta = -keyStep * 10
        break
      case 'PageUp':
        delta = keyStep * 10
        break
      case 'Home':
        timeWindow.select(
          edge === 'head' ? { from, to: view.to } : { from: view.from, to: view.from + minSelection },
        )
        break
      case 'End':
        timeWindow.select(
          edge === 'head' ? { from: view.to - minSelection, to: view.to } : { from: view.from, to },
        )
        break
      case 'Escape':
        timeWindow.reset()
        break
      default:
        return
    }
    event.preventDefault()
    if (delta === null) return
    timeWindow.select(
      edge === 'head'
        ? { from: Math.min(view.to - minSelection, Math.max(from, view.from + delta)), to: view.to }
        : { from: view.from, to: Math.max(view.from + minSelection, Math.min(to, view.to + delta)) },
    )
  }

  const grips = $derived<readonly { edge: Edge; t: number; min: number; max: number }[]>([
    { edge: 'head', t: view.from, min: from, max: view.to - minSelection },
    { edge: 'tail', t: view.to, min: view.from + minSelection, max: to },
  ])
</script>

<!-- The strip is a pointer gesture surface; its keyboard equivalent is the two grips inside. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="relative isolate touch-none select-none {drag === 'move'
    ? 'cursor-grabbing'
    : drag === 'head' || drag === 'tail'
      ? 'cursor-ew-resize'
      : 'cursor-crosshair'}"
  style:height="{HEIGHT}px"
  role="group"
  aria-label="time window"
  title="Drag to choose the time window. Double-click to show everything."
  onpointerdown={onPointerDown}
  ondblclick={timeWindow.reset}
>
  <svg {width} height={HEIGHT} shape-rendering="crispEdges" class="block" aria-hidden="true">
    <rect x={plotLeft} y={INSET} width={plotWidth} height={HEIGHT - 2 * INSET} class="fill-base-200" />
    <g class="chart-reveal">
      <path d={geometry.outline} fill="var(--chart-placed)" opacity="0.35" />
      {#each geometry.isolated as point}
        <line
          x1={point.x - OBSERVATION_HALF_WIDTH}
          x2={point.x + OBSERVATION_HALF_WIDTH}
          y1={point.y}
          y2={point.y}
          stroke="var(--chart-placed)"
          stroke-width="2"
        />
      {/each}
    </g>
    <rect
      x={bx(view.from)}
      y={INSET}
      width={Math.max(0, bx(view.to) - bx(view.from))}
      height={HEIGHT - 2 * INSET}
      class="fill-primary/15 stroke-primary/70 {drag === 'move' ? 'cursor-grabbing' : 'cursor-grab'}"
    />
    {#if shownPlayhead !== null}
      <line
        data-brush-playhead
        x1={bx(shownPlayhead)}
        x2={bx(shownPlayhead)}
        y1={INSET}
        y2={BASELINE}
        class="pointer-events-none stroke-primary"
        stroke-width="1.5"
      />
    {/if}
  </svg>
  {#if timeWindow.zoomed}
    <span
      data-brush-move
      class="absolute inset-y-0 z-20 cursor-grab"
      style:left="{moveTargetLeft}px"
      style:width="{moveTargetWidth}px"
      aria-hidden="true"
    ></span>
  {/if}
  {#each grips as grip (grip.edge)}
    <span
      role="slider"
      tabindex="0"
      data-handle={grip.edge}
      aria-label={grip.edge === 'head' ? 'window start' : 'window end'}
      aria-orientation="horizontal"
      aria-valuemin={grip.min}
      aria-valuemax={grip.max}
      aria-valuenow={grip.t}
      aria-valuetext={formatTime(grip.t)}
      class="absolute inset-y-0 z-10 flex cursor-ew-resize items-center outline-none focus-visible:outline-solid focus-visible:outline-[3px] focus-visible:outline-primary {grip.edge ===
      'head'
        ? 'justify-end'
        : 'justify-start'}"
      style:left="{grip.edge === 'head' ? bx(grip.t) - GRIP_TARGET_SIZE : bx(grip.t)}px"
      style:width="{GRIP_TARGET_SIZE}px"
      onkeydown={(event) => onGripKey(grip.edge, event)}
    >
      <span class="h-[calc(100%-8px)] w-1.5 rounded-xs bg-primary" aria-hidden="true"></span>
    </span>
  {/each}
</div>
