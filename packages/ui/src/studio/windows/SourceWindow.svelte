<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import type { StudioRect, TemplateStudioIntent, TemplateStudioModel } from '../model.js'

  /** The image: a file, the clipboard, or a web address, and the part of it the template uses. */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  /** Arrow keys move the crop by one source pixel, or ten with Shift. */
  const STEP = 1
  const BIG_STEP = 10
  const DIRECTIONS: Partial<Record<string, readonly [number, number]>> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const id = $props.id()

  let url = $state('')
  let dragging = $state(false)
  const chooseFile = (event: Event & { currentTarget: HTMLInputElement }): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file !== undefined) onIntent({ type: 'file', file })
  }
  const drop = (event: DragEvent): void => {
    // Every drop here is the studio's: left to the browser, a file or link would open over Wplace.
    event.preventDefault()
    dragging = false
    const file = [...(event.dataTransfer?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'))
    if (file !== undefined) onIntent({ type: 'file', file })
  }
  const submitUrl = (event: SubmitEvent): void => {
    event.preventDefault()
    if (url.trim() !== '') onIntent({ type: 'url', url: url.trim() })
  }

  /* Crop: drag the area to move it, a corner to resize it, or empty image to draw a new one. */
  type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'draw'
  let stage = $state<HTMLElement | null>(null)
  let cropDrag: { pointerId: number; grip: Grip; startX: number; startY: number; start: StudioRect } | null = null

  const sourcePoint = (event: PointerEvent): { x: number; y: number } | null => {
    if (stage === null || model.source === null) return null
    const rect = stage.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((event.clientX - rect.left) / rect.width) * model.source.width,
      y: ((event.clientY - rect.top) / rect.height) * model.source.height,
    }
  }
  const clampCrop = (x0: number, y0: number, x1: number, y1: number): StudioRect => {
    const width = model.source?.width ?? 1
    const height = model.source?.height ?? 1
    const left = Math.max(0, Math.min(width - 1, Math.round(Math.min(x0, x1))))
    const top = Math.max(0, Math.min(height - 1, Math.round(Math.min(y0, y1))))
    const right = Math.max(left + 1, Math.min(width, Math.round(Math.max(x0, x1))))
    const bottom = Math.max(top + 1, Math.min(height, Math.round(Math.max(y0, y1))))
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  const beginCrop = (event: PointerEvent, grip: Grip): void => {
    if (event.button !== 0 || model.pending) return
    const point = sourcePoint(event)
    if (point === null) return
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    cropDrag = { pointerId: event.pointerId, grip, startX: point.x, startY: point.y, start: model.crop }
  }
  const moveCrop = (event: PointerEvent): void => {
    if (cropDrag === null || event.pointerId !== cropDrag.pointerId || model.source === null) return
    const point = sourcePoint(event)
    if (point === null) return
    const { grip, start, startX, startY } = cropDrag
    const dx = point.x - startX
    const dy = point.y - startY
    const right = start.x + start.width
    const bottom = start.y + start.height
    const next: StudioRect =
      grip === 'move'
        ? {
            ...start,
            x: Math.max(0, Math.min(model.source.width - start.width, Math.round(start.x + dx))),
            y: Math.max(0, Math.min(model.source.height - start.height, Math.round(start.y + dy))),
          }
        : grip === 'draw'
          ? clampCrop(startX, startY, point.x, point.y)
          : grip === 'nw'
            ? clampCrop(start.x + dx, start.y + dy, right, bottom)
            : grip === 'ne'
              ? clampCrop(start.x, start.y + dy, right + dx, bottom)
              : grip === 'sw'
                ? clampCrop(start.x + dx, start.y, right, bottom + dy)
                : clampCrop(start.x, start.y, right + dx, bottom + dy)
    const { crop } = model
    if (next.x !== crop.x || next.y !== crop.y || next.width !== crop.width || next.height !== crop.height)
      onIntent({ type: 'crop', crop: next })
  }
  const endCrop = (event: PointerEvent): void => {
    if (cropDrag?.pointerId === event.pointerId) cropDrag = null
  }
  /** Arrows move the area; Alt with arrows resizes it from its bottom-right corner. */
  const cropKey = (event: KeyboardEvent): void => {
    if (model.source === null || model.pending) return
    const direction = DIRECTIONS[event.key]
    if (direction === undefined) return
    event.preventDefault()
    const step = event.shiftKey ? BIG_STEP : STEP
    const [dx, dy] = [direction[0] * step, direction[1] * step]
    const { x, y, width, height } = model.crop
    onIntent({
      type: 'crop',
      crop: event.altKey
        ? clampCrop(x, y, x + width + dx, y + height + dy)
        : {
            x: Math.max(0, Math.min(model.source.width - width, x + dx)),
            y: Math.max(0, Math.min(model.source.height - height, y + dy)),
            width,
            height,
          },
    })
  }
  const setCropField = (field: keyof StudioRect, value: string): void => {
    const parsed = Math.round(Number(value))
    const next = { ...model.crop, [field]: Number.isFinite(parsed) ? parsed : model.crop[field] }
    onIntent({ type: 'crop', crop: clampCrop(next.x, next.y, next.x + next.width, next.y + next.height) })
  }
  const percent = (value: number, of: number): string => `${(value / of) * 100}%`
  const whole = $derived(
    model.source !== null &&
      model.crop.x === 0 &&
      model.crop.y === 0 &&
      model.crop.width === model.source.width &&
      model.crop.height === model.source.height,
  )
</script>

<fieldset disabled={model.pending}>
  {#if model.source === null}
    <div
      class="drop"
      class:dragging
      role="group"
      aria-label="Image"
      ondragover={(event) => { event.preventDefault(); dragging = true }}
      ondragleave={() => (dragging = false)}
      ondrop={drop}
    >
      <p class="hint">{model.loadingSource ? 'Loading image…' : 'Drop an image here, or paste one.'}</p>
    </div>
  {:else}
    {@const source = model.source}
    <div
      class="stage"
      class:dragging
      role="presentation"
      bind:this={stage}
      style:aspect-ratio="{source.width} / {source.height}"
      ondragover={(event) => { event.preventDefault(); dragging = true }}
      ondragleave={() => (dragging = false)}
      ondrop={drop}
      onpointerdown={(event) => beginCrop(event, 'draw')}
      onpointermove={moveCrop}
      onpointerup={endCrop}
      onpointercancel={endCrop}
    >
      <img src={source.url} alt="" draggable="false" />
      <button
        type="button"
        class="crop"
        aria-label="Crop area, {model.crop.width} by {model.crop.height} at {model.crop.x}, {model.crop.y}. Arrows move it; Alt with arrows resizes it."
        style:left={percent(model.crop.x, source.width)}
        style:top={percent(model.crop.y, source.height)}
        style:width={percent(model.crop.width, source.width)}
        style:height={percent(model.crop.height, source.height)}
        onpointerdown={(event) => beginCrop(event, 'move')}
        onkeydown={cropKey}
      >
        {#each ['nw', 'ne', 'sw', 'se'] as const as corner (corner)}
          <span class="grip {corner}" aria-hidden="true" onpointerdown={(event) => beginCrop(event, corner)}></span>
        {/each}
      </button>
    </div>
    <p class="meta"><span class="name" title={source.name}>{source.name}</span><span>{source.width} × {source.height}</span></p>
    <div class="fields two">
      {#each [['x', 'X'], ['y', 'Y'], ['width', 'W'], ['height', 'H']] as const as [field, label] (field)}
        <label class="number">
          <span>{label}</span>
          <input class="caelestis-field" type="number" min="0" value={model.crop[field]} onchange={(event) => setCropField(field, event.currentTarget.value)} />
        </label>
      {/each}
    </div>
    <div class="actions-row">
      <Button label="Use whole image" size="small" kind="ghost" disabled={whole} onclick={() => onIntent({ type: 'reset-crop' })} />
    </div>
  {/if}
  <div class="actions-row">
    <label class="file caelestis-bevel">
      <span>Choose file</span>
      <input type="file" accept="image/*" onchange={chooseFile} />
    </label>
    <Button label="Paste" size="small" onclick={() => onIntent({ type: 'paste' })} />
  </div>
  <form class="url" onsubmit={submitUrl}>
    <label class="field-label" for="{id}-url">Image address</label>
    <div class="url-row">
      <input id="{id}-url" class="caelestis-field" type="url" inputmode="url" placeholder="https://" bind:value={url} />
      <Button type="submit" label="Load" size="small" disabled={url.trim() === ''} />
    </div>
  </form>
</fieldset>

<style>
  fieldset { display: contents; }
  .drop {
    display: grid;
    place-items: center;
    padding: 1.5rem 0.5rem;
    border: 1px dashed var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    text-align: center;
    transition: border-color var(--caelestis-duration-quick), background-color var(--caelestis-duration-quick);
  }
  .drop.dragging, .stage.dragging {
    border-color: var(--caelestis-primary, oklch(0.68 0.15 244));
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 10%, transparent);
  }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 0;
    color: var(--caelestis-muted-text);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .name { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0 0.75rem;
    min-block-size: 2rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    font-weight: 600;
    font-size: 0.8125rem;
    cursor: pointer;
  }
  .file:focus-within { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 2px; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .url { display: grid; gap: 0.25rem; }
  .url-row { display: flex; gap: 0.35rem; }
  .url-row input { flex: 1; min-inline-size: 0; }
  .stage {
    position: relative;
    inline-size: 100%;
    max-block-size: 16rem;
    overflow: hidden;
    background: repeating-conic-gradient(rgb(0 0 0 / 0.08) 0 25%, transparent 0 50%) 0 0 / 12px 12px;
    touch-action: none;
    user-select: none;
    cursor: crosshair;
  }
  .stage img {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    image-rendering: pixelated;
    pointer-events: none;
  }
  .crop {
    position: absolute;
    box-sizing: border-box;
    padding: 0;
    background: transparent;
    border: 1.5px solid white;
    outline: 1px solid rgb(0 0 0 / 0.6);
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.45);
    cursor: move;
  }
  .crop:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); }
  .grip {
    position: absolute;
    inline-size: 0.9rem;
    block-size: 0.9rem;
    margin: -0.45rem;
    border: 1.5px solid white;
    border-radius: 2px;
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
  }
  .grip.nw { inset-inline-start: 0; inset-block-start: 0; cursor: nwse-resize; }
  .grip.ne { inset-inline-end: 0; inset-block-start: 0; cursor: nesw-resize; }
  .grip.sw { inset-inline-start: 0; inset-block-end: 0; cursor: nesw-resize; }
  .grip.se { inset-inline-end: 0; inset-block-end: 0; cursor: nwse-resize; }
  @media (pointer: coarse) {
    .grip { inline-size: 1.5rem; block-size: 1.5rem; margin: -0.75rem; }
    .file { min-block-size: 2.75rem; }
  }
</style>
