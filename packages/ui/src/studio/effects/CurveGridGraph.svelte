<script lang="ts" generics="C extends GridCurve">
  import type { ColourChannel } from 'ditherette'
  import Button from '../../foundations/Button.svelte'
  import { channelLabel } from './catalog.js'
  import { canRemoveColumn, type GridCurve, insertColumn, removeColumn, setGridValue, wraps } from './grid.js'
  import { hueAxis } from './tone.js'

  /**
   * A curve over two inputs, as Ditherette web's grid graph: `x` across, `x2` up. Drag a point
   * up or down to change its value, double-click between columns to add one, Delete removes it.
   */
  let {
    id,
    curve,
    onChange,
    valueLabel,
    neutral,
  }: {
    id: string
    curve: C
    onChange: (curve: C) => void
    /** What the curve's values mean, shown with the value field and each point. */
    valueLabel: string
    /** The value that changes nothing: points holding it are drawn hollow. */
    neutral: number
  } = $props()

  /** Values sit on the byte grid, like one-input curves. */
  const BYTE = 255
  const LARGE_STEP = 16
  const WIDTH = 300
  const HEIGHT = 200
  const HIT_RADIUS_PX = 12
  /** Pixels of vertical drag across the whole value range. */
  const DRAG_PIXELS = 150

  let svg = $state<SVGSVGElement>()
  let selected = $state({ row: 0, column: 0 })
  let dragging = $state<{ startY: number; value: number }>()

  const grid = $derived(curve.grid)
  const row = $derived(Math.min(selected.row, grid.rows.length - 1))
  const column = $derived(Math.min(selected.column, grid.columns.length - 1))
  const cellValue = (r: number, c: number): number => grid.values[r]?.[c] ?? neutral
  const value = $derived(cellValue(row, column))
  const toByte = (v: number): number => Math.round(v * BYTE)
  const onGrid = (v: number): number => Math.min(BYTE, Math.max(0, Math.round(v))) / BYTE
  const at = (position: number, axis: 'x' | 'y'): number => (axis === 'x' ? position * WIDTH : (1 - position) * HEIGHT)
  /** "Hue" rather than "OKLCH · Hue": the curve's name already says the model. */
  const channelName = (channel: ColourChannel): string => channelLabel(channel).split(' · ')[1] ?? ''
  const position = (channel: ColourChannel, v: number): string =>
    wraps(channel) ? `${Math.round(v * 360)}°` : `${toByte(v)}`

  const set = (next: number): void => onChange(setGridValue(curve, row, column, onGrid(next * BYTE)))

  const point = (event: MouseEvent): { x: number; y: number; scale: number } => {
    const box = svg?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1)
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, 1 - (event.clientY - box.top) / box.height)),
      scale: box.width / WIDTH,
    }
  }

  const press = (event: PointerEvent): void => {
    if (event.button !== 0 || svg === undefined) return
    const { x, y, scale } = point(event)
    let best: { distance: number; row: number; column: number } | undefined
    grid.rows.forEach((r, rowIndex) =>
      grid.columns.forEach((c, columnIndex) => {
        const distance = Math.hypot((c - x) * WIDTH, (r - y) * HEIGHT) * scale
        if (distance < HIT_RADIUS_PX && (best === undefined || distance < best.distance))
          best = { distance, row: rowIndex, column: columnIndex }
      }),
    )
    if (best === undefined) return
    const hit: { row: number; column: number } = best
    selected = { row: hit.row, column: hit.column }
    dragging = { startY: event.clientY, value: cellValue(hit.row, hit.column) }
    svg.setPointerCapture(event.pointerId)
    svg.querySelector<SVGElement>(`[data-cell="${hit.row}-${hit.column}"]`)?.focus()
  }

  const drag = (event: PointerEvent): void => {
    if (dragging !== undefined) set(dragging.value + (dragging.startY - event.clientY) / DRAG_PIXELS)
  }

  /** Double-clicking between columns adds one there, sampled from the current surface. */
  const addColumn = (event: MouseEvent): void => {
    const { x } = point(event)
    const a = wraps(curve.x) ? Math.min(x, 0.999) : x
    if (grid.columns.some((c) => Math.abs(c - a) * BYTE < 2)) return
    const inserted = insertColumn(curve, onGrid(a * BYTE))
    if (inserted === undefined) return
    onChange(inserted.curve)
    selected = { row, column: inserted.index }
  }

  const keydown = (event: KeyboardEvent, rowIndex: number, columnIndex: number): void => {
    const distance = event.shiftKey ? LARGE_STEP : 1
    const count = grid.columns.length
    const step = (by: number): number =>
      wraps(curve.x) ? (columnIndex + by + count) % count : Math.min(count - 1, Math.max(0, columnIndex + by))
    if (event.key === 'ArrowUp') set((toByte(cellValue(rowIndex, columnIndex)) + distance) / BYTE)
    else if (event.key === 'ArrowDown') set((toByte(cellValue(rowIndex, columnIndex)) - distance) / BYTE)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      selected = { row: rowIndex, column: step(event.key === 'ArrowLeft' ? -1 : 1) }
      svg?.querySelector<SVGElement>(`[data-cell="${rowIndex}-${selected.column}"]`)?.focus()
    } else if (event.key === 'Delete' || event.key === 'Backspace') onChange(removeColumn(curve, columnIndex))
    else return
    event.preventDefault()
  }
</script>

<svg
  bind:this={svg}
  viewBox="0 0 {WIDTH} {HEIGHT}"
  preserveAspectRatio="none"
  role="group"
  aria-label="Curve grid: {channelLabel(curve.x)} across, {channelLabel(curve.x2)} up"
  onpointerdown={press}
  onpointermove={drag}
  onpointerup={() => (dragging = undefined)}
  onpointercancel={() => (dragging = undefined)}
  ondblclick={addColumn}
>
  {#each grid.columns as c (c)}
    <line x1={at(c, 'x')} x2={at(c, 'x')} y1="0" y2={HEIGHT} class="grid" vector-effect="non-scaling-stroke" />
  {/each}
  {#each grid.rows as r (r)}
    <line x1="0" x2={WIDTH} y1={at(r, 'y')} y2={at(r, 'y')} class="grid" vector-effect="non-scaling-stroke" />
  {/each}
  {#each grid.values as cells, rowIndex (rowIndex)}
    {#each cells as cell, columnIndex (columnIndex)}
      {@const x = grid.columns[columnIndex] ?? 0}
      {@const y = grid.rows[rowIndex] ?? 0}
      <rect
        data-cell="{rowIndex}-{columnIndex}"
        x={at(x, 'x') - 4}
        y={at(y, 'y') - 4}
        width="8"
        height="8"
        tabindex="0"
        role="button"
        aria-label="{channelLabel(curve.x)} {position(curve.x, x)}, {channelLabel(curve.x2)} {position(curve.x2, y)}: {valueLabel.toLowerCase()} {toByte(cell)}"
        aria-pressed={rowIndex === row && columnIndex === column}
        class="cell"
        class:active={rowIndex === row && columnIndex === column}
        class:changed={cell !== neutral}
        stroke-width="1.5"
        onfocus={() => (selected = { row: rowIndex, column: columnIndex })}
        onkeydown={(event) => keydown(event, rowIndex, columnIndex)}
      />
    {/each}
  {/each}
</svg>
{#if curve.x.channel === 'hue'}
  <div class="spectrum" style:background-image={hueAxis(curve.x.model)}></div>
{/if}

<div class="point-fields">
  <div class="number">
    <span class="field-label">{channelName(curve.x)}</span>
    <output class="caelestis-field">{position(curve.x, grid.columns[column] ?? 0)}</output>
  </div>
  <div class="number">
    <span class="field-label">{channelName(curve.x2)}</span>
    <output class="caelestis-field">{position(curve.x2, grid.rows[row] ?? 0)}</output>
  </div>
  <label class="number">
    <span class="field-label">{valueLabel}</span>
    <input
      id="{id}-grid-value"
      class="caelestis-field"
      type="number"
      min="0"
      max={BYTE}
      step="1"
      value={toByte(value)}
      onchange={(event) => set(Number(event.currentTarget.value) / BYTE)}
    />
  </label>
  <Button label="Remove column" size="small" disabled={!canRemoveColumn(curve, column)} onclick={() => onChange(removeColumn(curve, column))} />
</div>

<style>
  svg {
    display: block;
    inline-size: 100%;
    aspect-ratio: 3 / 2;
    border: 1px solid var(--caelestis-border);
    background: color-mix(in oklab, var(--caelestis-raised-surface, #eee) 50%, transparent);
    touch-action: none;
    user-select: none;
  }
  .grid { stroke: color-mix(in oklab, currentColor 25%, transparent); }
  .cell { fill: var(--caelestis-surface, white); stroke: currentColor; cursor: ns-resize; outline: none; }
  .cell.changed { fill: currentColor; }
  .cell.active { fill: var(--caelestis-primary, oklch(0.68 0.15 244)); }
  .cell:focus-visible { stroke: var(--caelestis-primary, oklch(0.68 0.15 244)); }
  .spectrum { block-size: 0.5rem; margin-block-start: -0.5rem; border: 1px solid var(--caelestis-border); border-block-start: 0; }
  .point-fields { display: grid; grid-template-columns: 1fr 1fr 1fr auto; align-items: end; gap: 0.35rem; }
  .point-fields .number { flex-direction: column; align-items: stretch; gap: 0.15rem; }
  output { display: block; line-height: 2rem; text-align: end; }
</style>
