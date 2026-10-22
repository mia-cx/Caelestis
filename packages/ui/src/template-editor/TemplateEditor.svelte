<script lang="ts">
  import { shift, tokenized } from '../foundations/motion.js'
  import Button from '../foundations/Button.svelte'
  import Icon, { type IconName } from '../foundations/Icon.svelte'
  import SliderRow from '../foundations/SliderRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import type {
    TemplateEditorDitherMethod,
    TemplateEditorIntent,
    TemplateEditorMatching,
    TemplateEditorModel,
    TemplateEditorPaletteScope,
    TemplateEditorRect,
    TemplateEditorResize,
    TemplateEditorTool,
  } from '../types.js'

  let { model, onIntent }: { model: TemplateEditorModel; onIntent: (intent: TemplateEditorIntent) => void } =
    $props()

  const TOOLS: readonly { id: TemplateEditorTool; label: string; icon: IconName }[] = [
    { id: 'image', label: 'Image', icon: 'image' },
    { id: 'crop', label: 'Crop', icon: 'crop' },
    { id: 'place', label: 'Size and position', icon: 'move' },
    { id: 'palette', label: 'Palette', icon: 'palette' },
    { id: 'match', label: 'Colour matching', icon: 'colourMatch' },
    { id: 'dither', label: 'Dithering', icon: 'dither' },
  ]
  const SCOPES: readonly { id: TemplateEditorPaletteScope; label: string }[] = [
    { id: 'owned', label: 'Owned' },
    { id: 'free', label: 'Free' },
    { id: 'premium', label: 'Premium' },
    { id: 'all', label: 'All' },
  ]
  const RESIZES: readonly { id: TemplateEditorResize; label: string }[] = [
    { id: 'area', label: 'Area average' },
    { id: 'nearest', label: 'Nearest pixel' },
    { id: 'bilinear', label: 'Bilinear' },
    { id: 'lanczos3', label: 'Lanczos' },
  ]
  const MATCHINGS: readonly { id: TemplateEditorMatching; label: string }[] = [
    { id: 'oklab-euclidean', label: 'Oklab' },
    { id: 'cielab-ciede2000', label: 'CIEDE2000' },
    { id: 'cielab-euclidean', label: 'CIELAB' },
    { id: 'srgb-compuphase', label: 'Weighted RGB' },
    { id: 'srgb-euclidean', label: 'RGB' },
  ]
  const DITHERS: readonly { group: string; methods: readonly { id: TemplateEditorDitherMethod; label: string }[] }[] = [
    { group: 'Error diffusion', methods: [
      { id: 'floyd-steinberg', label: 'Floyd–Steinberg' },
      { id: 'atkinson', label: 'Atkinson' },
      { id: 'sierra', label: 'Sierra' },
      { id: 'sierra-lite', label: 'Sierra Lite' },
    ] },
    { group: 'Ordered', methods: [
      { id: 'bayer', label: 'Bayer' },
      { id: 'yliluoma', label: 'Yliluoma' },
      { id: 'blue-noise', label: 'Blue noise' },
    ] },
  ]
  const DIFFUSION: readonly TemplateEditorDitherMethod[] = ['floyd-steinberg', 'atkinson', 'sierra', 'sierra-lite']
  /** Arrow keys move the crop by one source pixel, or ten with Shift. */
  const STEP = 1
  const BIG_STEP = 10

  const busy = $derived(model.pending)
  const hasSource = $derived(model.source !== null)
  const replacing = $derived(model.target.kind === 'replace')
  const windowTitle = $derived(TOOLS.find((tool) => tool.id === model.tool)?.label ?? '')
  const selectedCount = $derived(model.palette.colours.filter((colour) => colour.selected).length)
  const isDiffusion = $derived(DIFFUSION.includes(model.dither.method))
  const hasSize = $derived(model.dither.method === 'bayer' || model.dither.method === 'yliluoma')
  const hasStrength = $derived(isDiffusion || model.dither.method === 'bayer' || model.dither.method === 'blue-noise')

  const toolDisabled = (tool: TemplateEditorTool): boolean =>
    tool !== 'image' && (!hasSource || (model.limited && (tool === 'crop' || tool === 'match' || tool === 'dither')))

  const status = $derived.by((): string => {
    if (model.message !== undefined) return model.message
    if (model.loadingSource) return 'Loading image…'
    if (!hasSource) return 'Choose an image to start.'
    const processing = model.processing
    switch (processing.state) {
      case 'working':
        return processing.progress === null ? 'Processing…' : `Processing… ${Math.round(processing.progress * 100)}%`
      case 'failed':
        return processing.message
      case 'ready':
        return `${model.size.width} × ${model.size.height} · ${processing.pixels.toLocaleString()} px · ${processing.colours === 1 ? '1 colour' : `${processing.colours} colours`}`
      default:
        return ''
    }
  })
  const canSave = $derived(!busy && model.processing.state === 'ready' && model.processing.pixels > 0 && model.name.trim() !== '')

  const toggleTool = (tool: TemplateEditorTool): void =>
    onIntent({ type: 'tool', tool: model.tool === tool ? null : tool })

  const whole = (value: string, fallback: number): number => {
    const parsed = Math.round(Number(value))
    return Number.isFinite(parsed) ? parsed : fallback
  }

  /* Source: file, clipboard, URL, or a dropped file. */
  let url = $state('')
  let dragging = $state(false)
  const chooseFile = (event: Event & { currentTarget: HTMLInputElement }): void => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file !== undefined) onIntent({ type: 'file', file })
  }
  const drop = (event: DragEvent): void => {
    dragging = false
    const file = [...(event.dataTransfer?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'))
    if (file === undefined) return
    event.preventDefault()
    onIntent({ type: 'file', file })
  }
  const submitUrl = (event: SubmitEvent): void => {
    event.preventDefault()
    if (url.trim() !== '') onIntent({ type: 'url', url: url.trim() })
  }

  /* Crop: drag the area to move it, a corner to resize it, or empty image to draw a new one. */
  type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'draw'
  let stage = $state<HTMLElement | null>(null)
  let cropDrag: { pointerId: number; grip: Grip; startX: number; startY: number; start: TemplateEditorRect } | null = null

  const sourcePoint = (event: PointerEvent): { x: number; y: number } | null => {
    if (stage === null || model.source === null) return null
    const rect = stage.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return {
      x: ((event.clientX - rect.left) / rect.width) * model.source.width,
      y: ((event.clientY - rect.top) / rect.height) * model.source.height,
    }
  }
  const clampCrop = (x0: number, y0: number, x1: number, y1: number): TemplateEditorRect => {
    const width = model.source?.width ?? 1
    const height = model.source?.height ?? 1
    const left = Math.max(0, Math.min(width - 1, Math.round(Math.min(x0, x1))))
    const top = Math.max(0, Math.min(height - 1, Math.round(Math.min(y0, y1))))
    const right = Math.max(left + 1, Math.min(width, Math.round(Math.max(x0, x1))))
    const bottom = Math.max(top + 1, Math.min(height, Math.round(Math.max(y0, y1))))
    return { x: left, y: top, width: right - left, height: bottom - top }
  }
  const beginCrop = (event: PointerEvent, grip: Grip): void => {
    if (event.button !== 0 || busy) return
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
    let next: TemplateEditorRect
    switch (grip) {
      case 'move': {
        const x = Math.max(0, Math.min(model.source.width - start.width, Math.round(start.x + dx)))
        const y = Math.max(0, Math.min(model.source.height - start.height, Math.round(start.y + dy)))
        next = { ...start, x, y }
        break
      }
      case 'draw':
        next = clampCrop(startX, startY, point.x, point.y)
        break
      case 'nw':
        next = clampCrop(start.x + dx, start.y + dy, right, bottom)
        break
      case 'ne':
        next = clampCrop(start.x, start.y + dy, right + dx, bottom)
        break
      case 'sw':
        next = clampCrop(start.x + dx, start.y, right, bottom + dy)
        break
      case 'se':
        next = clampCrop(start.x, start.y, right + dx, bottom + dy)
        break
    }
    if (next.x !== model.crop.x || next.y !== model.crop.y || next.width !== model.crop.width || next.height !== model.crop.height)
      onIntent({ type: 'crop', crop: next })
  }
  const endCrop = (event: PointerEvent): void => {
    if (cropDrag?.pointerId === event.pointerId) cropDrag = null
  }
  /** Arrows move the area; Alt with arrows resizes it from its bottom-right corner. */
  const cropKey = (event: KeyboardEvent): void => {
    if (model.source === null || busy) return
    const step = event.shiftKey ? BIG_STEP : STEP
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (delta === undefined) return
    event.preventDefault()
    const [dx = 0, dy = 0] = delta
    const { x, y, width, height } = model.crop
    const next = event.altKey
      ? clampCrop(x, y, x + width + dx, y + height + dy)
      : {
          x: Math.max(0, Math.min(model.source.width - width, x + dx)),
          y: Math.max(0, Math.min(model.source.height - height, y + dy)),
          width,
          height,
        }
    onIntent({ type: 'crop', crop: next })
  }
  const setCropField = (field: keyof TemplateEditorRect, value: string): void => {
    const next = { ...model.crop, [field]: whole(value, model.crop[field]) }
    onIntent({ type: 'crop', crop: clampCrop(next.x, next.y, next.x + next.width, next.y + next.height) })
  }
  const percent = (value: number, of: number): string => `${(value / of) * 100}%`

  const windowIn = tokenized(shift, '--caelestis-duration-fast')
  const windowOut = tokenized(shift, '--caelestis-duration-quick')
  const statusSwap = tokenized(shift, '--caelestis-duration-quick')

  /** Escape closes the open tool window before anything else hears it. */
  const onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || model.tool === null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onIntent({ type: 'tool', tool: null })
  }
</script>

<svelte:window onkeydowncapture={onWindowKeydown} />

<div class="mode" aria-label="Template editor">
  <nav class="drawer caelestis-surface" aria-label="Editor tools">
    {#each TOOLS as tool (tool.id)}
      <button
        type="button"
        class="tool"
        class:active={model.tool === tool.id}
        title={tool.label}
        aria-label={tool.label}
        aria-expanded={model.tool === tool.id}
        aria-controls="template-editor-window"
        data-tool={tool.id}
        disabled={busy || toolDisabled(tool.id)}
        onclick={() => toggleTool(tool.id)}
      >
        <Icon name={tool.icon} size="1.25rem" />
      </button>
    {/each}
  </nav>

  {#if model.tool !== null}
    <section
      id="template-editor-window"
      class="window caelestis-surface"
      aria-label={windowTitle}
      in:windowIn|global={{ scale: '--caelestis-scale-large', blur: '--caelestis-blur-small' }}
      out:windowOut|global={{ scale: '--caelestis-scale-large', blur: '--caelestis-blur-small' }}
    >
      <header class="window-head">
        <h2>{windowTitle}</h2>
        <button type="button" class="close" aria-label="Close {windowTitle}" onclick={() => onIntent({ type: 'tool', tool: null })}>
          <Icon name="close" size="1rem" />
        </button>
      </header>
      <fieldset class="window-body" disabled={busy}>
        {#if model.tool === 'image'}
          <div
            class="drop"
            class:dragging
            role="group"
            aria-label="Image"
            ondragover={(event) => { event.preventDefault(); dragging = true }}
            ondragleave={() => (dragging = false)}
            ondrop={drop}
          >
            {#if model.source !== null}
              <img class="thumb" src={model.source.url} alt="" />
              <p class="meta"><span class="meta-name" title={model.source.name}>{model.source.name}</span><span>{model.source.width} × {model.source.height}</span></p>
            {:else}
              <p class="meta">{model.loadingSource ? 'Loading image…' : 'Drop an image here.'}</p>
            {/if}
          </div>
          <div class="actions-row">
            <label class="file caelestis-bevel">
              <Icon name="uploadFile" size="1rem" />
              <span>Choose file</span>
              <input type="file" accept="image/*" onchange={chooseFile} />
            </label>
            <Button label="Paste" size="small" onclick={() => onIntent({ type: 'paste' })}>
              <Icon name="paste" size="1rem" />
            </Button>
          </div>
          <form class="url" onsubmit={submitUrl}>
            <label class="field-label" for="template-editor-url">Image address</label>
            <div class="url-row">
              <input id="template-editor-url" class="caelestis-field" type="url" inputmode="url" placeholder="https://" bind:value={url} />
              <Button type="submit" label="Load" size="small" disabled={url.trim() === ''} />
            </div>
          </form>
        {:else if model.tool === 'crop' && model.source !== null}
          {@const source = model.source}
          <div
            class="stage"
            role="presentation"
            bind:this={stage}
            style:aspect-ratio={`${source.width} / ${source.height}`}
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
          <div class="fields four">
            {#each [['x', 'X'], ['y', 'Y'], ['width', 'W'], ['height', 'H']] as const as [field, label] (field)}
              <label class="number">
                <span>{label}</span>
                <input class="caelestis-field" type="number" min="0" value={model.crop[field]} onchange={(event) => setCropField(field, event.currentTarget.value)} />
              </label>
            {/each}
          </div>
          <div class="actions-row">
            <Button label="Use whole image" size="small" kind="ghost" disabled={model.crop.x === 0 && model.crop.y === 0 && model.crop.width === source.width && model.crop.height === source.height} onclick={() => onIntent({ type: 'crop', crop: { x: 0, y: 0, width: source.width, height: source.height } })} />
          </div>
        {:else if model.tool === 'place'}
          <p class="field-label">Position</p>
          <div class="fields two">
            <label class="number">
              <span>X</span>
              <input class="caelestis-field" type="number" value={model.origin.x} onchange={(event) => onIntent({ type: 'origin', x: whole(event.currentTarget.value, model.origin.x), y: model.origin.y })} />
            </label>
            <label class="number">
              <span>Y</span>
              <input class="caelestis-field" type="number" value={model.origin.y} onchange={(event) => onIntent({ type: 'origin', x: model.origin.x, y: whole(event.currentTarget.value, model.origin.y) })} />
            </label>
          </div>
          <div class="actions-row">
            <Button label="Centre in view" size="small" onclick={() => onIntent({ type: 'centre' })}>
              <Icon name="fitScreen" size="1rem" />
            </Button>
          </div>
          <p class="hint">Drag the image on the map to move it. Arrow keys nudge it.</p>
          <p class="field-label">Size</p>
          <div class="fields two">
            <label class="number">
              <span>W</span>
              <input class="caelestis-field" type="number" min="1" value={model.size.width} disabled={model.size.locked || model.limited} onchange={(event) => onIntent({ type: 'size', width: Math.max(1, whole(event.currentTarget.value, model.size.width)), height: model.size.height })} />
            </label>
            <label class="number">
              <span>H</span>
              <input class="caelestis-field" type="number" min="1" value={model.size.height} disabled={model.size.locked || model.limited} onchange={(event) => onIntent({ type: 'size', width: model.size.width, height: Math.max(1, whole(event.currentTarget.value, model.size.height)) })} />
            </label>
          </div>
          {#if model.size.locked}
            <p class="hint">A replacement keeps the template’s size.</p>
          {:else if !model.limited}
            <label class="option">
              <Toggle label="Keep proportions" compact checked={model.size.keepProportions} onChange={(keep) => onIntent({ type: 'keep-proportions', keep })} />
              <span>Keep proportions</span>
            </label>
            <div class="actions-row">
              <Button label="Original size" size="small" kind="ghost" disabled={model.size.width === model.crop.width && model.size.height === model.crop.height} onclick={() => onIntent({ type: 'size', width: model.crop.width, height: model.crop.height })} />
            </div>
          {/if}
          {#if !model.limited}
            <label class="select">
              <span class="field-label">Resampling</span>
              <select class="caelestis-select" value={model.size.resize} onchange={(event) => onIntent({ type: 'resize', resize: event.currentTarget.value as TemplateEditorResize })}>
                {#each RESIZES as resize (resize.id)}<option value={resize.id}>{resize.label}</option>{/each}
              </select>
            </label>
          {/if}
        {:else if model.tool === 'palette'}
          <div class="scopes" role="group" aria-label="Palette">
            {#each SCOPES as scope (scope.id)}
              <button type="button" class="choice caelestis-bevel" class:active={model.palette.scope === scope.id} aria-pressed={model.palette.scope === scope.id} disabled={scope.id === 'owned' && !model.palette.ownedKnown} onclick={() => onIntent({ type: 'scope', scope: scope.id })}>{scope.label}</button>
            {/each}
          </div>
          <div class="swatches" role="group" aria-label="Colours">
            {#each model.palette.colours as colour (colour.index)}
              <button type="button" class="swatch" data-on={colour.selected} style:background={colour.hex} aria-label="{colour.name}, {colour.kind}" aria-pressed={colour.selected} title="{colour.name} · {colour.kind}" onclick={() => onIntent({ type: 'colour', index: colour.index, selected: !colour.selected })}></button>
            {/each}
          </div>
          <p class="hint">{selectedCount === 1 ? '1 colour' : `${selectedCount} colours`}</p>
        {:else if model.tool === 'match'}
          <label class="select">
            <span class="field-label">Colour distance</span>
            <select class="caelestis-select" value={model.matching} onchange={(event) => onIntent({ type: 'matching', matching: event.currentTarget.value as TemplateEditorMatching })}>
              {#each MATCHINGS as matching (matching.id)}<option value={matching.id}>{matching.label}</option>{/each}
            </select>
          </label>
          <SliderRow label="Transparent below" compact value={model.threshold} defaultValue={128} min={0} max={255} step={1} format={(value) => `${Math.round((value / 255) * 100)}%`} onCommit={(threshold) => onIntent({ type: 'threshold', threshold })} onReset={(threshold) => onIntent({ type: 'threshold', threshold })} />
        {:else if model.tool === 'dither'}
          <label class="select">
            <span class="field-label">Method</span>
            <select class="caelestis-select" value={model.dither.method} onchange={(event) => onIntent({ type: 'dither', dither: { method: event.currentTarget.value as TemplateEditorDitherMethod } })}>
              <option value="none">None</option>
              {#each DITHERS as group (group.group)}
                <optgroup label={group.group}>
                  {#each group.methods as method (method.id)}<option value={method.id}>{method.label}</option>{/each}
                </optgroup>
              {/each}
            </select>
          </label>
          {#if hasSize}
            <label class="select">
              <span class="field-label">Pattern size</span>
              <select class="caelestis-select" value={model.dither.size} onchange={(event) => onIntent({ type: 'dither', dither: { size: event.currentTarget.value as TemplateEditorModel['dither']['size'] } })}>
                {#each ['2', '4', '8', '16'] as const as size (size)}<option value={size}>{size} × {size}</option>{/each}
              </select>
            </label>
          {/if}
          {#if hasStrength}
            <SliderRow label="Strength" compact value={model.dither.strength} defaultValue={isDiffusion ? 1 : 0.5} min={0} max={1} step={0.05} format={(value) => `${Math.round(value * 100)}%`} onCommit={(strength) => onIntent({ type: 'dither', dither: { strength } })} onReset={(strength) => onIntent({ type: 'dither', dither: { strength } })} />
          {/if}
          {#if isDiffusion}
            <label class="option">
              <Toggle label="Serpentine scan" compact checked={model.dither.serpentine} onChange={(serpentine) => onIntent({ type: 'dither', dither: { serpentine } })} />
              <span>Serpentine scan</span>
            </label>
          {/if}
        {/if}
      </fieldset>
    </section>
  {/if}

  <div class="bar caelestis-surface" role="toolbar" aria-label="Template">
    <div class="row">
      <label class="name">
        <span class="visually-hidden">Template name</span>
        <input class="caelestis-field" type="text" maxlength="256" placeholder="Template name" value={model.name} disabled={busy || replacing} oninput={(event) => onIntent({ type: 'name', name: event.currentTarget.value })} />
      </label>
      <p class="status" class:failed={model.processing.state === 'failed' || model.message !== undefined} role="status" title={status}>
        {#each [status] as text (text)}<span class="status-text" in:statusSwap|global={{ distance: '--caelestis-distance-micro', dy: 1, blur: '--caelestis-blur-small' }} out:statusSwap|global={{ distance: '--caelestis-distance-micro', dy: -1, blur: '--caelestis-blur-small' }}>{text}</span>{/each}
      </p>
      <div class="actions">
        <Button label="Cancel" size="compact" kind="ghost" disabled={busy} onclick={() => onIntent({ type: 'cancel' })} />
        <Button label={replacing ? 'Replace template' : 'Create template'} size="compact" kind="primary" disabled={!canSave} onclick={() => onIntent({ type: 'save' })} />
      </div>
    </div>
  </div>
</div>

<style>
  .mode {
    --mode-open-dur: var(--caelestis-duration-medium);
    --mode-close-dur: var(--caelestis-duration-fast);
    --mode-ease: var(--caelestis-ease-smooth-out);
    --drawer-inset: 12px;
    --tool-size: 2.25rem;
    position: fixed;
    inset: 0;
    pointer-events: none;
    font: 0.8125rem/1.4 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    color: var(--caelestis-text, #222);
  }
  .caelestis-surface {
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-box-radius, var(--caelestis-radius, 1rem));
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  /* Enter/exit rides `translate`, driven through the host's data-state, as in claim mode. */
  .drawer {
    --rest-translate: 0 -50%;
    --hidden-translate: calc(-100% - 12px) -50%;
    position: absolute;
    inset-inline-start: var(--drawer-inset);
    inset-block-start: 50%;
    translate: var(--hidden-translate);
    opacity: 0;
    transition:
      translate var(--mode-open-dur) var(--mode-ease),
      opacity var(--mode-open-dur) var(--mode-ease);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
  }
  :host([data-state='open']) .drawer { translate: var(--rest-translate); opacity: 1; }
  :host([data-state='closing']) .drawer {
    translate: var(--hidden-translate);
    opacity: 0;
    pointer-events: none;
    transition-duration: var(--mode-close-dur);
  }
  .tool, .close {
    display: grid;
    place-items: center;
    border: 0;
    border-radius: calc(var(--caelestis-radius, 0.7rem) - 2px);
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition:
      background-color var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out, ease-out),
      color var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out, ease-out);
  }
  .tool {
    inline-size: var(--tool-size);
    block-size: var(--tool-size);
  }
  .tool:disabled { opacity: 0.4; cursor: default; }
  .tool:hover:not(:disabled, .active), .close:hover {
    background: color-mix(in oklab, currentColor 10%, transparent);
  }
  .tool.active {
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
    color: white;
  }
  .tool:focus-visible, .close:focus-visible, .crop:focus-visible, .swatch:focus-visible {
    outline: 2px solid var(--caelestis-focus, currentColor);
    outline-offset: -2px;
  }

  .window {
    position: absolute;
    inset-inline-start: calc(var(--drawer-inset) + var(--tool-size) + 8px + 2px + 8px);
    inset-block-start: 50%;
    translate: 0 -50%;
    transform-origin: left center;
    display: flex;
    flex-direction: column;
    inline-size: 18rem;
    max-block-size: calc(100dvh - 9rem);
    box-sizing: border-box;
  }
  :host([data-state='closing']) .window { opacity: 0; pointer-events: none; transition: opacity var(--mode-close-dur); }
  .window-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.25rem 0.85rem;
  }
  h2 { margin: 0; font-size: 0.85rem; font-weight: 600; }
  .close { inline-size: 1.75rem; block-size: 1.75rem; }
  .window-body {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-block-size: 0;
    margin: 0;
    padding: 0.25rem 0.85rem 0.85rem;
    overflow-y: auto;
    border: 0;
  }
  .window-body:disabled { opacity: 0.7; }

  .drop {
    display: grid;
    gap: 0.4rem;
    justify-items: center;
    padding: 0.5rem;
    border: 1px dashed var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    transition: border-color var(--caelestis-duration-quick), background-color var(--caelestis-duration-quick);
  }
  .drop.dragging {
    border-color: var(--caelestis-primary, oklch(0.68 0.15 244));
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 10%, transparent);
  }
  .thumb {
    max-inline-size: 100%;
    max-block-size: 8rem;
    image-rendering: pixelated;
    object-fit: contain;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    inline-size: 100%;
    margin: 0;
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
  }
  .meta-name { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta:only-child { justify-content: center; padding-block: 1.5rem; }
  .actions-row { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .file {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
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

  .field-label { margin: 0; color: var(--caelestis-muted-text); font-size: 0.75rem; }
  .hint { margin: 0; color: var(--caelestis-muted-text); font-size: 0.75rem; }
  .caelestis-field, .caelestis-select {
    box-sizing: border-box;
    block-size: 2rem;
    padding: 0 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.5rem);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .caelestis-field:disabled { opacity: 0.6; }
  .fields { display: grid; gap: 0.35rem; }
  .fields.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fields.four { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .number { display: flex; align-items: center; gap: 0.3rem; min-inline-size: 0; color: var(--caelestis-muted-text); }
  .number input { flex: 1; min-inline-size: 0; inline-size: 100%; padding-inline: 0.35rem; }
  .select { display: grid; gap: 0.25rem; }
  .option { display: inline-flex; align-items: center; gap: 0.4rem; color: var(--caelestis-muted-text); }

  .stage {
    position: relative;
    inline-size: 100%;
    max-block-size: 16rem;
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
  .stage { overflow: hidden; }
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

  .scopes { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .choice {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-pill-radius, 999px);
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: 600 0.75rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  .choice.active {
    background: var(--caelestis-primary, oklch(0.68 0.15 244));
    border-color: transparent;
    color: white;
  }
  .choice:disabled { opacity: 0.5; cursor: default; }
  .swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: 0.35rem; }
  .swatch {
    position: relative;
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid rgb(0 0 0 / 0.25);
    border-radius: var(--caelestis-pill-radius, calc(0.7rem + 1px));
    outline: 2px solid transparent;
    outline-offset: 1px;
    opacity: 0.35;
    cursor: pointer;
    transition: opacity 100ms ease-out, outline-color 100ms ease-out;
  }
  .swatch[data-on='true'] { outline-color: var(--caelestis-text); opacity: 1; }

  .bar {
    translate: 0 calc(-100% - 12px);
    opacity: 0;
    transition:
      translate var(--mode-open-dur) var(--mode-ease),
      opacity var(--mode-open-dur) var(--mode-ease);
    position: absolute;
    inset-block-start: 12px;
    inset-inline: 8rem;
    margin-inline: auto;
    box-sizing: border-box;
    inline-size: fit-content;
    max-inline-size: calc(100vw - 16rem);
    padding: 0.5rem 0.75rem;
  }
  :host([data-state='open']) .bar { translate: 0 0; opacity: 1; }
  :host([data-state='closing']) .bar {
    translate: 0 calc(-100% - 12px);
    opacity: 0;
    pointer-events: none;
    transition-duration: var(--mode-close-dur);
  }
  .row {
    display: grid;
    grid-template-columns: 12rem minmax(14rem, auto) auto;
    align-items: center;
    gap: 1rem;
    min-block-size: 2.25rem;
  }
  .name input { inline-size: 100%; }
  .status {
    display: grid;
    margin: 0;
    padding-inline: 0.75rem;
    border-inline: 1px solid var(--caelestis-border);
    min-inline-size: 0;
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .status.failed { color: var(--caelestis-error, oklch(0.6 0.2 25)); font-weight: 500; }
  .status-text { grid-area: 1 / 1; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; gap: 0.35rem; }
  .visually-hidden {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 56rem) {
    .bar { inset-inline: 3.5rem 7rem; inline-size: auto; max-inline-size: none; }
    .row { grid-template-columns: minmax(0, 1fr) auto; gap: 0.35rem 0.75rem; }
    .status { grid-row: 2; grid-column: 1 / -1; padding-inline: 0; border-inline: 0; }
  }

  /* Phones: one card above Wplace's bottom controls, tools along its top edge, the open tool
     window in the middle, and the name and actions at the bottom. */
  @media (max-width: 40rem) {
    .mode {
      inset: auto max(8px, env(safe-area-inset-right)) calc(4.25rem + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
      display: flex;
      flex-direction: column;
      max-block-size: calc(100dvh - 6rem);
      border: 1px solid var(--caelestis-border);
      border-radius: var(--caelestis-radius, 0.7rem);
      background: var(--caelestis-surface, white);
      box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
      pointer-events: auto;
      translate: 0 calc(100% + 4.25rem + env(safe-area-inset-bottom));
      opacity: 0;
      transition:
        translate var(--mode-open-dur) var(--mode-ease),
        opacity var(--mode-open-dur) var(--mode-ease);
    }
    :host([data-state='open']) .mode { translate: 0 0; opacity: 1; }
    :host([data-state='closing']) .mode {
      translate: 0 calc(100% + 4.25rem + env(safe-area-inset-bottom));
      opacity: 0;
      transition-duration: var(--mode-close-dur);
    }
    .caelestis-surface { border: 0; border-radius: 0; background: transparent; box-shadow: none; }
    .drawer, .bar, .window { position: static; translate: none; opacity: 1; transition: none; }
    :host([data-state='closing']) :is(.drawer, .bar, .window) { translate: none; opacity: 1; pointer-events: none; }
    .drawer { flex-direction: row; justify-content: space-around; border-block-end: 1px solid var(--caelestis-border); }
    .tool { --tool-size: 2.75rem; }
    .window { inline-size: auto; max-block-size: 45dvh; border-block-end: 1px solid var(--caelestis-border); }
    .bar { inline-size: auto; margin: 0; padding: 0.5rem; }
    .row { grid-template-columns: minmax(0, 1fr); }
    .status { grid-row: auto; }
    .actions { justify-content: stretch; }
    .actions :global(button) { flex: 1 1 0; min-block-size: 2.75rem; }
    .caelestis-field, .caelestis-select, .file { block-size: 2.75rem; min-block-size: 2.75rem; }
    .swatches { grid-template-columns: repeat(8, 1fr); }
  }

  @media (prefers-reduced-motion: reduce) {
    .mode, .drawer, .bar, .tool, .swatch, .drop { transition: none !important; }
  }
</style>
