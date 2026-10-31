<script lang="ts">
  import type { CurvePoints } from 'ditherette'
  import { tick } from 'svelte'
  import Button from '../../foundations/Button.svelte'
  import { type CurvePoint, evaluateCurve, evaluatePeriodicCurve, MAX_CURVE_POINTS, MIN_CURVE_POINT_GAP } from './spline.js'
  import { type Neutral, tonePath } from './tone.js'

  /**
   * An editable curve, as Ditherette web's curve graph: click to add a point, drag points to
   * reshape it, arrows nudge the focused point, Delete removes it.
   */
  interface Props {
    id: string
    points: CurvePoints
    onChange: (points: CurvePoints) => void
    /** The edited curve's colour. */
    colour: string
    /** Other curves drawn thin behind the edited one. */
    behind?: readonly { points: CurvePoints; colour: string }[]
    /** Names for the point fields: what x reads and what y sets. */
    axes?: { x: string; y: string }
    /** The dashed line where the curve changes nothing. */
    neutral?: Neutral
    /**
     * A hue x axis: the curve wraps, its end points stay at 0 and 1 with one shared y, and other
     * points dragged past one edge continue at the other.
     */
    periodic?: boolean
    /** A CSS gradient drawn under the x axis. */
    spectrum?: string | undefined
  }
  let {
    id,
    points,
    onChange,
    colour,
    behind = [],
    axes = { x: 'Input', y: 'Output' },
    neutral = 'diagonal',
    periodic = false,
    spectrum,
  }: Props = $props()

  /** Edited points sit on the byte grid, so neighbours stay well above the package's x gap. */
  const BYTE = 255
  const LARGE_STEP = 16
  const SIZE = 256
  const SAMPLES = 128
  const HIT_RADIUS_PX = 10

  let svg = $state<SVGSVGElement>()
  let selected = $state(0)
  let dragging = $state<number>()

  /** `selected` can outlive a shorter curve after a channel switch, so fields use this. */
  const active = $derived(Math.min(selected, points.length - 1))
  const current = $derived(points[active] ?? [0, 0])
  const curvePath = (curve: CurvePoints): string =>
    tonePath((x) => (periodic ? evaluatePeriodicCurve(curve, x) : evaluateCurve(curve, x)), SIZE, SAMPLES)
  const isEnd = (index: number): boolean => periodic && (index === 0 || index === points.length - 1)
  const toByte = (value: number): number => Math.round(value * BYTE)
  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
  const xAt = (index: number): number => points[index]?.[0] ?? 0

  /**
   * Move one point on the byte grid and return its new index. Points stay strictly between their
   * neighbours, except on a periodic axis, where they wrap around the seam and may pass them.
   */
  const place = (index: number, xByte: number, yByte: number): number => {
    if (!Number.isFinite(xByte) || !Number.isFinite(yByte)) return index
    const y = clamp(Math.round(yByte), 0, BYTE) / BYTE
    if (isEnd(index)) {
      const next: CurvePoint[] = points.slice()
      next[0] = [0, y]
      next[next.length - 1] = [1, y]
      onChange(next)
      return index
    }
    if (periodic) {
      const target = Math.round(xByte)
      const cycled = ((target % BYTE) + BYTE) % BYTE
      // Bytes 0 and 255 are the seam: step over it in the direction of travel.
      const wrapped = cycled === 0 ? (target <= 0 ? BYTE - 1 : 1) : cycled
      const taken = points.some(([px], other) => other !== index && toByte(px) === wrapped)
      const x = taken ? xAt(index) : wrapped / BYTE
      const rest = points.filter((_, other) => other !== index)
      const at = rest.findIndex(([px]) => px > x)
      onChange([...rest.slice(0, at), [x, y], ...rest.slice(at)])
      return at
    }
    // Analysed knots sit off the byte grid, closer than a byte apart: one whose byte is unchanged
    // keeps its exact x, and a moved one stays the package's gap from its neighbours.
    const xByteNow = toByte(xAt(index))
    const min = index > 0 ? xAt(index - 1) + MIN_CURVE_POINT_GAP : 0
    const max = index < points.length - 1 ? xAt(index + 1) - MIN_CURVE_POINT_GAP : 1
    const x = Math.round(xByte) === xByteNow ? xAt(index) : clamp(Math.round(xByte) / BYTE, min, max)
    const next: CurvePoint[] = points.slice()
    next[index] = [x, y]
    onChange(next)
    return index
  }

  const remove = (index: number): void => {
    if (points.length <= 2 || isEnd(index)) return
    onChange(points.filter((_, other) => other !== index))
    selected = Math.max(0, index - 1)
  }

  const pointerBytes = (event: PointerEvent): { x: number; y: number; pixelsPerByte: number } => {
    const box = svg?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1)
    const x = (event.clientX - box.left) / box.width
    return {
      // Pointer capture keeps reporting past the edges, which a periodic axis wraps.
      x: (periodic ? x : clamp(x, 0, 1)) * BYTE,
      y: clamp(1 - (event.clientY - box.top) / box.height, 0, 1) * BYTE,
      pixelsPerByte: box.width / BYTE,
    }
  }

  /** Grab the nearest point, or add one on the curve's grid and drag it. */
  const press = (event: PointerEvent): void => {
    if (event.button !== 0 || svg === undefined) return
    const { x, y, pixelsPerByte } = pointerBytes(event)
    const distances = points.map(([px, py]) => Math.hypot(px * BYTE - x, py * BYTE - y))
    const nearest = distances.indexOf(Math.min(...distances))
    let index = nearest
    if ((distances[nearest] ?? Number.POSITIVE_INFINITY) * pixelsPerByte > HIT_RADIUS_PX) {
      const xByte = Math.round(x)
      const taken = points.some(([px]) => Math.abs(toByte(px) - xByte) < 1)
      if (points.length >= MAX_CURVE_POINTS || taken) return
      index = points.findIndex(([px]) => toByte(px) > xByte)
      if (index < 0) index = points.length
      const next: CurvePoint[] = points.slice()
      next.splice(index, 0, [xByte / BYTE, Math.round(y) / BYTE])
      onChange(next)
    }
    selected = index
    dragging = index
    svg.setPointerCapture(event.pointerId)
    svg.querySelector<SVGElement>(`[data-point="${index}"]`)?.focus()
  }

  const drag = (event: PointerEvent): void => {
    if (dragging === undefined) return
    const { x, y } = pointerBytes(event)
    dragging = selected = place(dragging, x, y)
  }

  const MOVES: Partial<Record<string, readonly [number, number]>> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  }
  const keydown = (event: KeyboardEvent, index: number): void => {
    const move = MOVES[event.key]
    if (move !== undefined) {
      const distance = event.shiftKey ? LARGE_STEP : 1
      const point = points[index] ?? [0, 0]
      selected = place(index, toByte(point[0]) + move[0] * distance, toByte(point[1]) + move[1] * distance)
      // A wrapped point changes places, so keep focus on it.
      if (selected !== index)
        void tick().then(() => svg?.querySelector<SVGElement>(`[data-point="${selected}"]`)?.focus())
    } else if (event.key === 'Delete' || event.key === 'Backspace') remove(index)
    else return
    event.preventDefault()
  }

  const start = $derived({ diagonal: SIZE, flat: SIZE / 2, full: 0 }[neutral])
  const end = $derived({ diagonal: 0, flat: SIZE / 2, full: 0 }[neutral])
</script>

<svg
  bind:this={svg}
  viewBox="0 0 {SIZE} {SIZE}"
  role="group"
  aria-label="Curve. Click to add a point, and drag points to reshape it."
  onpointerdown={press}
  onpointermove={drag}
  onpointerup={() => (dragging = undefined)}
  onpointercancel={() => (dragging = undefined)}
>
  {#each [0.25, 0.5, 0.75] as line (line)}
    <line x1={line * SIZE} x2={line * SIZE} y1="0" y2={SIZE} class="grid" />
    <line y1={line * SIZE} y2={line * SIZE} x1="0" x2={SIZE} class="grid" />
  {/each}
  <line x1="0" y1={start} x2={SIZE} y2={end} class="neutral" />
  {#each behind as curve, index (index)}
    <path d={curvePath(curve.points)} fill="none" stroke={curve.colour} stroke-width="1.5" opacity="0.7" />
  {/each}
  <path d={curvePath(points)} fill="none" stroke={colour} stroke-width="2" />
  {#each points as [x, y], index (index)}
    <rect
      data-point={index}
      x={x * SIZE - 5}
      y={(1 - y) * SIZE - 5}
      width="10"
      height="10"
      tabindex="0"
      role="button"
      aria-label="Point {index + 1}: {axes.x.toLowerCase()} {toByte(x)}, {axes.y.toLowerCase()} {toByte(y)}"
      aria-pressed={index === active}
      class="point"
      class:active={index === active}
      stroke-width="1.5"
      onfocus={() => (selected = index)}
      onkeydown={(event) => keydown(event, index)}
      ondblclick={() => remove(index)}
    />
  {/each}
</svg>
{#if spectrum !== undefined}
  <div class="spectrum" style:background-image={spectrum}></div>
{/if}

<div class="point-fields">
  <label class="number">
    <span class="field-label">{axes.x}</span>
    <input
      id="{id}-point-input"
      class="caelestis-field"
      type="number"
      min="0"
      max={BYTE}
      step="1"
      value={toByte(current[0])}
      disabled={isEnd(active)}
      onchange={(event) => (selected = place(active, Number(event.currentTarget.value), toByte(current[1])))}
    />
  </label>
  <label class="number">
    <span class="field-label">{axes.y}</span>
    <input
      id="{id}-point-output"
      class="caelestis-field"
      type="number"
      min="0"
      max={BYTE}
      step="1"
      value={toByte(current[1])}
      onchange={(event) => place(active, toByte(current[0]), Number(event.currentTarget.value))}
    />
  </label>
  <Button label="Remove point" size="small" disabled={points.length <= 2 || isEnd(active)} onclick={() => remove(active)} />
</div>

<style>
  svg {
    display: block;
    inline-size: 100%;
    aspect-ratio: 1;
    border: 1px solid var(--caelestis-border);
    background: color-mix(in oklab, var(--caelestis-raised-surface, #eee) 50%, transparent);
    touch-action: none;
    user-select: none;
  }
  .grid { stroke: var(--caelestis-border); }
  .neutral { stroke: color-mix(in oklab, currentColor 40%, transparent); stroke-dasharray: 4 4; }
  .point { fill: var(--caelestis-surface, white); stroke: currentColor; cursor: grab; outline: none; }
  .point.active { fill: var(--caelestis-primary, oklch(0.68 0.15 244)); }
  .point:focus-visible { stroke: var(--caelestis-primary, oklch(0.68 0.15 244)); }
  .spectrum { block-size: 0.5rem; margin-block-start: -0.5rem; border: 1px solid var(--caelestis-border); border-block-start: 0; }
  .point-fields { display: grid; grid-template-columns: 1fr 1fr auto; align-items: end; gap: 0.35rem; }
  .point-fields .number { flex-direction: column; align-items: stretch; gap: 0.15rem; }
</style>
