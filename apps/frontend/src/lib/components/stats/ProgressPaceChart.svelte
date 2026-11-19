<script module lang="ts">
  /** The plot's height, which the panel's loading and error states keep too. */
  export const CHART_HEIGHT = 240
</script>

<script lang="ts">
  import { formatCount, formatPixels, type HistoryBucket, type PainterTotal } from '@caelestis/shared'
  import { prefersReducedMotion } from '@caelestis/ui/motion'
  import { untrack } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { Tween } from 'svelte/motion'
  import { fade } from 'svelte/transition'
  import { formatTime } from '#lib/time-format.js'
  import PaceHoverCard, { ARCHIVE_SOURCE, type PaceRow } from './PaceHoverCard.svelte'
  import PacePicker from './PacePicker.svelte'
  import {
    brushSeries,
    hasActivity,
    lerpProgress,
    paceLines,
    painterLines,
    painterSource,
    progressSegments,
    type Readout,
    readoutAt,
    snapTimes,
  } from './pace-model.js'
  import type { PaceSelection } from './pace-selection.svelte.js'
  import { painterColour, painterLabel } from './painter-identity.js'
  import PainterPicker from './PainterPicker.svelte'
  import type { ObservedProgressSample } from './progress-history.js'
  import { DRAG_THRESHOLD_PX, followPointer } from './pointer-drag.js'
  import {
    axisScale,
    clipSeries,
    lerpRate,
    nearestSorted,
    type PaceRatePoint,
    type PainterHistorySource,
    paceAt,
    snapTime,
    timeTickStep,
  } from './progress-pace.js'
  import RangeBrush from './RangeBrush.svelte'
  import RangePresets from './RangePresets.svelte'
  import { DAY_SECONDS } from './stats-scope.svelte.js'
  import { ChartWindow, type TimeWindow } from './time-window.svelte.js'

  let {
    samples,
    buckets,
    resolution,
    from,
    to,
    live,
    paces,
    painters,
    painterHistories,
    playhead = null,
    onSeek,
    onScrubStart,
  }: {
    /**
     * Saved observations merged with imported archive samples, ending with the current or frozen
     * counts at `to`. Placement reports are not a net canvas-change ledger.
     */
    samples: readonly ObservedProgressSample[]
    buckets: readonly HistoryBucket[]
    /** Bucket width in seconds; buckets are summed across templates per bucket start. */
    resolution: number
    from: number
    to: number
    /** The right edge is now: the canvas is still being painted, so the last point is live. */
    live: boolean
    /** Which pace lines are drawn; whoever fetches `painterHistories` reads the same. */
    paces: PaceSelection
    /** Who painted in the range, leading first: the picker's list. */
    painters: readonly PainterTotal[]
    /** The selected painters' retained sources for the enabled rolling windows. */
    painterHistories: readonly PainterHistorySource[]
    /** A timelapse's recorded time, drawn as a playhead wherever it falls inside the range. */
    playhead?: number | null
    /**
     * Links the plot to that timelapse: a click seeks to the time under the pointer and a drag
     * that starts on the playhead scrubs it. Whoever owns the timelapse clamps and applies the
     * time; the chart only draws `playhead`. Absent, the plot keeps its zoom-only gestures.
     */
    onSeek?: (t: number) => void
    /** Capture the playback state before a drag; the returned callback rolls back cancellation. */
    onScrubStart?: () => () => void
  } = $props()

  const timeWindow = new ChartWindow(() => ({ from, to, resolution }))
  const view = $derived(timeWindow.view)

  const segments = $derived(progressSegments(samples))
  const paceWindows = $derived(paceLines(samples, to))
  const painterPaces = $derived(painterLines(paces, painters, painterHistories, to))
  const active = $derived(hasActivity(samples, buckets, painterHistories, to))
  const anchor = $derived(samples.findLast((sample) => sample.at === to))
  const enabledPaces = $derived(
    paces.allUsers
      ? paceWindows.filter((pace) => paces.windows.has(pace.key) && pace.segments.length > 0)
      : [],
  )
  /** The painter under the picker's pointer or keyboard, drawn on top with the others dimmed. */
  let spotlightPainter = $state<number | null>(null)

  const paceColor = (rank: number): string =>
    `color-mix(in oklch shorter hue, var(--pace-short) ${Math.round(100 - rank * 100)}%, var(--pace-long))`
  const paceWidth = (rank: number): number => 1.5 + rank * 1.25

  const paceOptions = $derived(
    paceWindows.map((pace) => ({
      key: pace.key,
      colour: paceColor(pace.rank),
      selected: paces.windows.has(pace.key),
      available:
        pace.segments.length > 0 ||
        (painterSource(painterHistories, pace)?.buckets.length ?? 0) > 0,
    })),
  )

  let width = $state(640)
  const height = CHART_HEIGHT
  const pad = { top: 18, right: 48, bottom: 22, left: 48 }
  const plotWidth = $derived(Math.max(1, width - pad.left - pad.right))
  const plotHeight = height - pad.top - pad.bottom

  // The axis tops come from the target window, so a zoom re-fits to where it is going.
  const targetPaces = $derived(
    enabledPaces.flatMap((pace) =>
      pace.segments.flatMap((segment) => clipSeries(segment, view.from, view.to, lerpRate)),
    ),
  )
  const rightMin = $derived(Math.min(0, ...targetPaces.map((point) => point.v)))
  const leftScale = $derived(
    axisScale(
      Math.max(
        0,
        ...segments.flatMap((segment) =>
          clipSeries(segment, view.from, view.to, lerpProgress).map(
            (point) => point.v + point.mismatched,
          ),
        ),
      ),
      4,
      1,
    ),
  )
  const rightScale = $derived(
    axisScale(
      Math.max(
        0,
        ...targetPaces.map((point) => point.v),
        ...painterPaces.flatMap((line) =>
          clipSeries(line.series, view.from, view.to, lerpRate).map((point) => point.v),
        ),
      ),
      4,
    ),
  )

  // The drawn domain and both axis tops chase their targets, so a preset, a plot-drag zoom, or a
  // toggled pace line re-fits the plot instead of snapping it. A brush drag moves the window
  // under the pointer while the axis tops keep gliding, and reduced motion turns every tween and
  // transition into a cut.
  const REFIT_MS = 400
  const motion = (ms: number): number => (prefersReducedMotion() ? 0 : ms)
  const shownWindow = new Tween(
    untrack(() => ({ from: view.from, to: view.to })),
    { duration: REFIT_MS, easing: cubicOut },
  )
  const shownAxes = new Tween(
    untrack(() => ({ leftMax: leftScale.max, rightMax: rightScale.max })),
    { duration: REFIT_MS, easing: cubicOut },
  )
  let brushDragging = $state(false)
  $effect(() => {
    const duration = brushDragging ? 0 : motion(REFIT_MS)
    void shownWindow.set({ from: view.from, to: view.to }, { duration })
  })
  $effect(() => {
    void shownAxes.set(
      { leftMax: leftScale.max, rightMax: rightScale.max },
      { duration: motion(REFIT_MS) },
    )
  })
  const shownView = $derived<TimeWindow>({
    from: shownWindow.current.from,
    to: shownWindow.current.to,
  })

  const visibleProgressSegments = $derived(
    segments
      .map((segment) => clipSeries(segment, shownView.from, shownView.to, lerpProgress))
      .filter((segment) => segment.length > 1),
  )
  const isolatedProgressPoints = $derived(
    segments
      .filter((segment) => segment.length === 1)
      .flat()
      .filter((point) => point.t >= shownView.from && point.t <= shownView.to),
  )
  // Imported stretches draw dashed and meet the observed stroke at a shared point.
  const activePaces = $derived(
    enabledPaces.flatMap((pace) =>
      pace.segments.map((fullSeries, index) => {
        const series = clipSeries(fullSeries, shownView.from, shownView.to, lerpRate)
        const imported = series.filter((point) => point.t <= pace.importedUntil)
        const observed = series.filter((point) => point.t >= pace.importedUntil)
        const strokes = [
          ...(imported.length > 0 ? [{ series: imported, imported: true }] : []),
          ...(observed.some((point) => point.t > pace.importedUntil)
            ? [{ series: observed, imported: false }]
            : []),
        ]
        return { ...pace, id: `${pace.key}:${index}`, fullSeries, strokes, series }
      }),
    ),
  )
  // A painter line holds its last rate to the right edge.
  const activePainterLines = $derived(
    painterPaces.map((line) => {
      const series = clipSeries(line.series, shownView.from, shownView.to, lerpRate)
      const last = series.at(-1)
      if (last !== undefined && last.t < shownView.to) series.push({ ...last, t: shownView.to })
      return { ...line, series }
    }),
  )
  const painterLineOpacity = (wplaceUserId: number): number =>
    spotlightPainter === null || spotlightPainter === wplaceUserId ? 0.9 : 0.25

  const x = $derived(
    (t: number) =>
      pad.left + ((t - shownView.from) / Math.max(1, shownView.to - shownView.from)) * plotWidth,
  )
  const yLeft = $derived(
    (v: number) => height - pad.bottom - (v / shownAxes.current.leftMax) * plotHeight,
  )
  const yRight = $derived(
    (v: number) =>
      height - pad.bottom - ((v - rightMin) / (shownAxes.current.rightMax - rightMin)) * plotHeight,
  )
  /** The time under a pointer, given the plot's left edge and displayed domain. */
  const timeIn = (range: TimeWindow, clientX: number, left: number): number =>
    range.from + ((clientX - left - pad.left) / plotWidth) * (range.to - range.from)

  const linePath = (series: readonly PaceRatePoint[]): string =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${yRight(p.v).toFixed(1)}`)
      .join('')

  const tickStep = $derived(timeTickStep(shownView.to - shownView.from, plotWidth))
  const xTicks = $derived.by(() => {
    const ticks: number[] = []
    for (let t = Math.ceil(shownView.from / tickStep) * tickStep; t < shownView.to; t += tickStep) {
      ticks.push(t)
    }
    return ticks
  })

  const formatTick = (t: number): string => {
    const date = new Date(t * 1000)
    const rangeStart = new Date(shownView.from * 1_000)
    const rangeEnd = new Date((shownView.to - 1) * 1_000)
    const crossesDay =
      rangeStart.getFullYear() !== rangeEnd.getFullYear() ||
      rangeStart.getMonth() !== rangeEnd.getMonth() ||
      rangeStart.getDate() !== rangeEnd.getDate()
    const crossesOffset = rangeStart.getTimezoneOffset() !== rangeEnd.getTimezoneOffset()
    if (!crossesDay) {
      return date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        ...(crossesOffset ? { timeZoneName: 'shortOffset' } : {}),
      })
    }
    const crossesYear = rangeStart.getFullYear() !== rangeEnd.getFullYear()
    return date.toLocaleString(undefined, {
      ...(crossesYear ? { year: 'numeric' } : {}),
      month: 'short',
      day: 'numeric',
      ...(tickStep < DAY_SECONDS || crossesOffset ? { hour: '2-digit', minute: '2-digit' } : {}),
      ...(crossesOffset ? { timeZoneName: 'shortOffset' } : {}),
    })
  }

  const hoverSnapTimes = $derived(
    snapTimes(
      samples,
      [...activePaces.map((pace) => pace.series), ...activePainterLines.map((line) => line.series)],
      shownView,
    ),
  )
  let hover = $state<Readout | null>(null)
  /** What the keyboard walk just landed on, for assistive technology. Pointer hovers stay quiet. */
  let announce = $state('')
  let pointer = $state<{ x: number; y: number } | null>(null)
  let plotSvg = $state<SVGSVGElement>()

  const hoverAt = (t: number | null): void => {
    if (t === null) hover = null
    else if (hover?.t !== t) hover = readoutAt(samples, visibleProgressSegments, t)
  }
  const hoverPointer = (clientX: number, left: number): void =>
    hoverAt(nearestSorted(hoverSnapTimes, timeIn(shownView, clientX, left)))

  /** Each painter appears once, with their available rolling windows in chart order. */
  const hoverPaceRows = $derived.by((): PaceRow[] => {
    if (hover === null) return []
    const { t } = hover
    const rows = new Map<string, { name: string; rates: PaceRow['rates'][number][] }>()
    const add = (
      id: string,
      name: string,
      window: string,
      colour: string,
      series: readonly PaceRatePoint[],
    ): void => {
      const value = paceAt(series, t)
      if (value === null) return
      const row = rows.get(id) ?? { name, rates: [] }
      row.rates.push({ window, value, colour })
      rows.set(id, row)
    }
    for (const pace of activePaces) add('all', 'All users', pace.key, paceColor(pace.rank), pace.series)
    for (const line of activePainterLines) {
      add(
        String(line.painter.wplaceUserId),
        painterLabel(line.painter),
        line.window,
        painterColour(line.painter.wplaceUserId),
        line.series,
      )
    }
    return [...rows].map(([id, row]) => ({ id, ...row }))
  })
  const hoverWindowCount = $derived(
    new Set([
      ...activePaces.map((pace) => pace.key),
      ...activePainterLines.map((line) => line.window),
    ]).size,
  )
  const hoverIncludesImport = $derived(
    hover !== null &&
      activePaces.some(
        (pace) =>
          hover !== null &&
          hover.t - pace.seconds < pace.importedUntil &&
          paceAt(pace.series, hover.t) !== null,
      ),
  )
  const walkedPoint = (): { x: number; y: number } | null => {
    const rect = plotSvg?.getBoundingClientRect()
    return hover === null || rect === undefined
      ? null
      : { x: rect.left + x(hover.t), y: rect.top + pad.top }
  }

  const liveEdge = $derived(
    live && view.to === to && anchor?.correct != null ? { t: to, correct: anchor.correct } : null,
  )

  // The plot draws the playhead only inside the shown window; the brush keeps it in view across
  // the whole range, so a zoomed reader still sees where playback is.
  const linked = $derived(onSeek !== undefined)
  const playheadShown = $derived(
    playhead !== null && playhead >= shownView.from && playhead <= shownView.to ? playhead : null,
  )
  /** How far from the playhead a press still grabs it. Fingers need more room than a mouse. */
  const playheadGrabHalfWidth = (pointerType: string): number =>
    pointerType === 'mouse' ? 10 : 22
  const overPlayhead = (clientX: number, left: number, pointerType: string): boolean =>
    linked &&
    playheadShown !== null &&
    Math.abs(clientX - left - x(playheadShown)) <= playheadGrabHalfWidth(pointerType)
  /** The pointer is on the playhead, or dragging it: the cursor says so. */
  let nearPlayhead = $state(false)
  let scrubbing = $state(false)

  const painterMetricNoun = 'placed pixels'
  const hoverSummary = (point: Readout): string => {
    const paceValues = activePaces.flatMap((pace) => {
      const value = paceAt(pace.series, point.t)
      return value === null ? [] : [`${pace.key} pace ${formatCount(value)} px/h`]
    })
    const painterValues = activePainterLines.flatMap((line) => {
      const value = paceAt(line.series, point.t)
      return value === null
        ? []
        : [`${painterLabel(line.painter)} ${line.window} ${painterMetricNoun} ${formatCount(value)} px/h`]
    })
    return [
      `${formatTime(point.t)}${point.t === liveEdge?.t ? ' (now)' : ''}`,
      ...(point.archive ? [ARCHIVE_SOURCE] : []),
      point.correct === null ? 'No completion coverage' : `${point.correct.toLocaleString()} correct`,
      point.mismatched === null
        ? 'No mismatch coverage'
        : `${point.mismatched.toLocaleString()} mismatched`,
      ...paceValues,
      ...painterValues,
    ].join(', ')
  }

  const onPlotKey = (event: KeyboardEvent): void => {
    const times = hoverSnapTimes
    if (times.length === 0) return
    const index = hover === null ? -1 : times.indexOf(hover.t)
    let next: number | undefined
    switch (event.key) {
      case 'ArrowLeft':
        next = times[index < 0 ? times.length - 1 : Math.max(0, index - 1)]
        break
      case 'ArrowRight':
        next = times[index < 0 ? times.length - 1 : Math.min(times.length - 1, index + 1)]
        break
      case 'Home':
        next = times[0]
        break
      case 'End':
        next = times[times.length - 1]
        break
      case 'Escape':
        if (hover !== null) hover = null
        else if (timeWindow.zoomed) timeWindow.reset()
        else return
        event.preventDefault()
        return
      case 'Enter':
      case ' ':
        if (onSeek === undefined || hover === null) return
        onSeek(hover.t)
        announce = `Timelapse moved to ${formatTime(hover.t)}`
        event.preventDefault()
        return
      default:
        return
    }
    event.preventDefault()
    if (next === undefined) return
    pointer = null
    hoverAt(next)
    announce = hover === null ? '' : hoverSummary(hover)
  }

  // A press that moves under the drag threshold is a click. On a linked chart that seeks the
  // timelapse; a press that starts on the playhead and moves scrubs it instead of zooming.
  // Everything else zooms.
  let plotDrag = $state<TimeWindow | null>(null)

  const onPlotPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || hoverSnapTimes.length === 0) return
    const plot = event.currentTarget as SVGSVGElement
    const seek = onSeek
    const scrub =
      seek !== undefined &&
      overPlayhead(event.clientX, plot.getBoundingClientRect().left, event.pointerType)
    const cancelScrub = scrub ? onScrubStart?.() : undefined
    const dragView = { from: shownView.from, to: shownView.to }
    void shownWindow.set(dragView, { duration: 0 })
    const clampView = (t: number): number => Math.min(dragView.to, Math.max(dragView.from, t))
    const start = clampView(timeIn(dragView, event.clientX, plot.getBoundingClientRect().left))
    const startX = event.clientX
    let moved = false
    event.preventDefault()
    plot.focus({ preventScroll: true })
    followPointer(event.pointerId, {
      move: (move) => {
        const left = plot.getBoundingClientRect().left
        const current = clampView(timeIn(dragView, move.clientX, left))
        if (!moved && Math.abs(move.clientX - startX) > DRAG_THRESHOLD_PX) moved = true
        if (moved && scrub && seek !== undefined) {
          scrubbing = true
          seek(current)
        } else if (moved) {
          plotDrag = { from: start, to: current }
        }
        hoverPointer(move.clientX, left)
      },
      end: (end, cancelled) => {
        // A cancelled press, such as a touch the browser took for scrolling, never seeks.
        if (cancelled && moved && scrub) cancelScrub?.()
        if (!cancelled && !moved && seek !== undefined) seek(start)
        const drag = plotDrag
        plotDrag = null
        scrubbing = false
        if (drag !== null) {
          timeWindow.select({
            from: snapTime(Math.min(drag.from, drag.to), resolution, from, to),
            to: snapTime(Math.max(drag.from, drag.to), resolution, from, to),
          })
        }
        if (cancelled) return
        const bounds = plot.getBoundingClientRect()
        const inside =
          end.clientX >= bounds.left &&
          end.clientX <= bounds.right &&
          end.clientY >= bounds.top &&
          end.clientY <= bounds.bottom
        if (!inside) hover = null
      },
    })
  }

  const chartLabel = $derived(
    `Cumulative pixels painted and rolling pace from ${formatTime(view.from)} to ${formatTime(view.to)}${
      painters.length > 0
        ? `, with ${painterMetricNoun} pace lines for ${paces.painters.size} of ${painters.length} painters`
        : ''
    }. Use the arrow keys to read values.${
      linked ? ' Click, or press Enter on a value, to move the timelapse there.' : ''
    }`,
  )
</script>

<div class="chart flex flex-col gap-3" bind:clientWidth={width}>
  <div class="flex flex-wrap items-center gap-x-5 gap-y-2.5 text-xs">
    <div class="flex items-center gap-4 text-base-content/70">
      <span class="inline-flex items-center gap-2">
        <span
          class="size-3 rounded-xs"
          style:background="var(--chart-correct)"
        ></span>
        correct
      </span>
      <span class="inline-flex items-center gap-2">
        <span class="size-3 rounded-xs bg-error"></span>
        mismatched
      </span>
    </div>

    <div class="flex items-center gap-2" role="group" aria-label="pace lines">
      <span class="text-base-content/65">pace</span>
      <PacePicker options={paceOptions} onToggle={paces.toggleWindow} />
    </div>

    {#if painters.length > 0 || paceWindows.some((pace) => pace.segments.length > 0)}
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="whose pace lines">
        <span class="text-base-content/65">who</span>
        <PainterPicker
          options={painters}
          selected={paces.painters}
          onToggle={paces.togglePainter}
          onSetAll={paces.setAllPainters}
          allUsersShown={paces.allUsers}
          onToggleAllUsers={paces.toggleAllUsers}
          onHover={(wplaceUserId) => {
            spotlightPainter = wplaceUserId
          }}
        />
      </div>
    {/if}

    {#if active}
      <div class="ms-auto flex items-center gap-2">
        <span class="text-base-content/65">range</span>
        <RangePresets
          presets={timeWindow.presets}
          active={timeWindow.activePreset}
          onPreset={timeWindow.preset}
          onAll={timeWindow.reset}
        />
      </div>
    {/if}
  </div>

  {#if active}
    <div class="relative">
      <!-- The image is focusable so keyboard users can walk the data points; the live region below
           reads each one out. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <!-- Whole pixels: every line, area and dash lands on the grid, jaggies included. -->
      <svg
        shape-rendering="crispEdges"
        {width}
        {height}
        role="img"
        tabindex="0"
        aria-label={chartLabel}
        class="block touch-pan-y {scrubbing || nearPlayhead
          ? 'cursor-ew-resize'
          : 'cursor-crosshair'} rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        bind:this={plotSvg}
        onpointermove={(event) => {
          pointer = { x: event.clientX, y: event.clientY }
          if (plotDrag === null && !brushDragging && !scrubbing) {
            const left = event.currentTarget.getBoundingClientRect().left
            hoverPointer(event.clientX, left)
            nearPlayhead = overPlayhead(event.clientX, left, event.pointerType)
          }
        }}
        onpointerleave={() => {
          nearPlayhead = false
          if (plotDrag === null && !scrubbing) {
            hover = null
            pointer = null
          }
        }}
        onpointerdown={onPlotPointerDown}
        ondblclick={timeWindow.reset}
        onkeydown={onPlotKey}
      >
        {#each leftScale.ticks as tick (tick)}
          {#if yLeft(tick) >= pad.top}
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={yLeft(tick)}
              y2={yLeft(tick)}
              class="stroke-base-content/10"
            />
            <text
              x={pad.left - 8}
              y={yLeft(tick) + 3}
              text-anchor="end"
              aria-label={formatPixels(tick)}
              class="fill-base-content/50 text-[12px] tabular-nums"><title>{formatPixels(tick)}</title>{formatCount(tick)}</text
            >
          {/if}
        {/each}
        {#if activePaces.length > 0 || activePainterLines.length > 0}
          {#if rightMin < 0}
            <text x={width - pad.right + 8} y={yRight(rightMin) + 3} class="fill-base-content/50 text-[12px] tabular-nums">{formatCount(rightMin)}</text>
          {/if}
          {#each rightScale.ticks as tick (tick)}
            {#if yRight(tick) >= pad.top}
              <text
                x={width - pad.right + 8}
                y={yRight(tick) + 3}
                text-anchor="start"
                aria-label={`${formatPixels(tick)} per hour`}
                class="fill-base-content/40 text-[12px] tabular-nums"
                ><title>{formatPixels(tick)} per hour</title>{formatCount(tick)}</text
              >
            {/if}
          {/each}
        {/if}
        <text x={pad.left - 8} y={9} text-anchor="end" class="fill-base-content/40 text-[12px]">px</text>
        {#if activePaces.length > 0 || activePainterLines.length > 0}
          <text x={width - pad.right + 8} y={9} text-anchor="start" class="fill-base-content/40 text-[12px]"
            >px/h</text
          >
        {/if}
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={height - pad.bottom}
          y2={height - pad.bottom}
          class="stroke-base-content/20"
        />
        {#each xTicks as tick (tick)}
          <line
            x1={x(tick)}
            x2={x(tick)}
            y1={height - pad.bottom}
            y2={height - pad.bottom + 4}
            class="stroke-base-content/20"
          />
          <text
            x={x(tick)}
            y={height - 6}
            text-anchor="middle"
            class="fill-base-content/50 text-[12px] tabular-nums"
          >
            {formatTick(tick)}
          </text>
        {/each}

        <g class="chart-reveal">
          {#each activePaces as pace (pace.id)}
            {#each pace.strokes as stroke (stroke.imported)}
            <path
              in:fade={{ duration: motion(250) }}
              out:fade={{ duration: motion(150) }}
              d={linePath(stroke.series)}
              fill="none"
              stroke={paceColor(pace.rank)}
              stroke-width={paceWidth(pace.rank)}
              stroke-dasharray={stroke.imported ? '3 3' : undefined}
              stroke-linejoin="round"
            />
            {/each}
            {#if pace.series.length === 1}
              <circle cx={x(pace.series[0].t)} cy={yRight(pace.series[0].v)} r="3" fill={paceColor(pace.rank)} />
            {/if}
          {/each}

          {#each visibleProgressSegments as segment (segment[0].t)}
            {@const archived = segment.some(point => point.archive)}
            {@const line = segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${yLeft(point.v).toFixed(1)}`).join('')}
            {@const mismatchedLine = segment.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${yLeft(point.v + point.mismatched).toFixed(1)}`).join('')}
            <path
              d={`${line}L${x(segment[segment.length - 1].t).toFixed(1)},${yLeft(0).toFixed(1)}L${x(segment[0].t).toFixed(1)},${yLeft(0).toFixed(1)}Z`}
              fill="var(--chart-correct)" opacity="0.3" />
            <path
              d={`${mismatchedLine}${[...segment].reverse().map((point) => `L${x(point.t).toFixed(1)},${yLeft(point.v).toFixed(1)}`).join('')}Z`}
              class="fill-error" opacity="0.25" />
            {#if segment.some((point) => point.mismatched > 0)}
              <path d={mismatchedLine} fill="none" class="stroke-error"
                stroke-width="1.5" stroke-dasharray={archived ? '3 3' : undefined} stroke-linejoin="round" />
            {/if}
            <path d={line} fill="none" stroke="var(--chart-correct)"
              stroke-width="1.5" stroke-dasharray={archived ? '3 3' : undefined} stroke-linejoin="round" />
          {/each}


          {#each isolatedProgressPoints as point (point.t)}
            <g>
              <path d={`M${Math.max(pad.left, x(point.t) - 3)},${yLeft(point.v)}H${Math.min(width - pad.right, x(point.t) + 3)}`}
                stroke="var(--chart-correct)" stroke-width="2" />
              {#if point.mismatched > 0}<path d={`M${Math.max(pad.left, x(point.t) - 3)},${yLeft(point.v + point.mismatched)}H${Math.min(width - pad.right, x(point.t) + 3)}`}
                class="stroke-error" stroke-width="2" />{/if}
            </g>
          {/each}

          {#each activePainterLines as line (`${line.painter.wplaceUserId}:${line.window}`)}
            <path
              in:fade={{ duration: motion(250) }}
              out:fade={{ duration: motion(150) }}
              d={linePath(line.series)}
              fill="none"
              stroke={painterColour(line.painter.wplaceUserId)}
              stroke-width={paceWidth(line.rank)}
              stroke-opacity={painterLineOpacity(line.painter.wplaceUserId)}
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          {/each}

          {#if liveEdge !== null}
            <circle
              cx={x(liveEdge.t)}
              cy={yLeft(liveEdge.correct)}
              r="4"
              fill="var(--chart-correct)"
              class="motion-safe:animate-ping"
              style:transform-box="fill-box"
              style:transform-origin="center"
              opacity="0.6"
            />
            <circle
              cx={x(liveEdge.t)}
              cy={yLeft(liveEdge.correct)}
              r="3"
              fill="var(--chart-correct)"
              class="stroke-base-100"
              stroke-width="1.5"
            />
          {/if}
        </g>

        {#if playheadShown !== null}
          <g data-playhead>
            <line
              x1={x(playheadShown)}
              x2={x(playheadShown)}
              y1={pad.top}
              y2={height - pad.bottom}
              class="stroke-primary"
              stroke-width="1.5"
            />
            <path
              d={`M${(x(playheadShown) - 5).toFixed(1)},${pad.top - 9}h10l-5,8z`}
              class="fill-primary"
            />
          </g>
        {/if}

        {#if plotDrag !== null}
          <rect
            data-plot-selection
            out:fade={{ duration: motion(150) }}
            x={Math.min(x(plotDrag.from), x(plotDrag.to))}
            y={pad.top}
            width={Math.abs(x(plotDrag.to) - x(plotDrag.from))}
            height={plotHeight}
            class="fill-primary/10 stroke-primary/50"
          />
        {/if}

        {#if hover !== null}
          <g in:fade={{ duration: motion(150) }} out:fade={{ duration: motion(100) }}>
            <line
              x1={x(hover.t)}
              x2={x(hover.t)}
              y1={pad.top}
              y2={height - pad.bottom}
              class="stroke-base-content/25"
            />
            {#if hover.correct !== null}<circle
              cx={x(hover.t)}
              cy={yLeft(hover.correct)}
              r="3"
              fill="var(--chart-correct)"
              class="stroke-base-100"
              stroke-width="1.5"
            />{/if}
            {#each activePaces as pace (pace.id)}
              {@const value = paceAt(pace.series, hover.t)}
              {#if value !== null}
                <circle
                  cx={x(hover.t)}
                  cy={yRight(value)}
                  r="3"
                  fill={paceColor(pace.rank)}
                  class="stroke-base-100"
                  stroke-width="1.5"
                />
              {/if}
            {/each}
            {#each activePainterLines as line (`${line.painter.wplaceUserId}:${line.window}`)}
              {@const value = paceAt(line.series, hover.t)}
              {#if value !== null}
                <circle
                  cx={x(hover.t)}
                  cy={yRight(value)}
                  r="3"
                  fill={painterColour(line.painter.wplaceUserId)}
                  class="stroke-base-100"
                  stroke-width="1.5"
                />
              {/if}
            {/each}
          </g>
        {/if}
      </svg>

      <PaceHoverCard
        readout={hover}
        now={hover !== null && hover.t === liveEdge?.t}
        includesImport={hoverIncludesImport}
        rows={hoverPaceRows}
        windowCount={hoverWindowCount}
        {pointer}
        pinned={walkedPoint}
        plot={plotSvg}
      />
      <div class="sr-only" aria-live="polite">{announce}</div>
    </div>

    <RangeBrush
      {timeWindow}
      {from}
      {to}
      {resolution}
      {width}
      plotLeft={pad.left}
      {plotWidth}
      series={brushSeries(samples, segments, buckets, { from, to, resolution })}
      {playhead}
      bind:dragging={brushDragging}
    />
  {:else}
    <div
      style:height="{CHART_HEIGHT}px"
      class="flex items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/50"
    >
      No paint activity reported in this window.
    </div>
  {/if}
</div>

<style>
  /*
   * Progress chart load motion. The series and the brush's minimap wipe in from the left when the
   * chart mounts, so the history arrives as one stroke of time rather than a fade. The clip is
   * released once the wipe has run; the negative insets keep stroke caps and the live marker's halo
   * out of the clip while it is active. Pace lines switched on later only fade, so the wipe stays a
   * once-per-load moment, and the global reduced-motion rule in app.css turns it into a cut.
   */
  .chart :global(.chart-reveal) {
    clip-path: none;
    animation: chart-reveal 600ms ease-out;
  }
  @keyframes chart-reveal {
    from {
      clip-path: inset(-12px 100% -12px -12px);
    }
    to {
      clip-path: inset(-12px -12px -12px -12px);
    }
  }
</style>
