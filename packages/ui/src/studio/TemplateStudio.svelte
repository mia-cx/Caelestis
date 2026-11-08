<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import {
    type Box,
    collapsePanel,
    DEFAULT_STUDIO_LAYOUT,
    floatPlace,
    isOpen,
    moveFrame,
    movePanel,
    panelsAcross,
    panelsIn,
    type StudioDrop,
    selectPanel,
    togglePanel,
  } from './layout.js'
  import { STUDIO_WINDOWS, type StudioFrame, type StudioLayout, type StudioNode, type StudioRect, type StudioWindowId, type TemplateStudioIntent, type TemplateStudioModel } from './model.js'
  import ImagePicker from './ImagePicker.svelte'
  import StudioStyles from './StudioStyles.svelte'
  import StudioWindow from './StudioWindow.svelte'
  import DimensionsWindow from './windows/DimensionsWindow.svelte'
  import DitherWindow from './windows/DitherWindow.svelte'
  import EffectsWindow from './windows/EffectsWindow.svelte'
  import PaletteWindow from './windows/PaletteWindow.svelte'
  import ScopesWindow from './windows/ScopesWindow.svelte'

  interface Props {
    model: TemplateStudioModel
    /** Where the draft, or the crop being drawn, sits on screen. Crop mode's card goes under it. */
    mapBox?: Box | null
    onIntent: (intent: TemplateStudioIntent) => void
  }
  let { model, mapBox = null, onIntent }: Props = $props()

  /* Layout: the model's saved layout, with this drag applied until the next model arrives. */
  let layout = $state<StudioLayout>(DEFAULT_STUDIO_LAYOUT)
  $effect.pre(() => { layout = model.layout })
  const commitLayout = (next: StudioLayout): void => {
    layout = next
    onIntent({ type: 'layout', layout: next })
  }

  /* Dragging. Every window floats over the map. The empty part of any header in a window moves the
     whole window, with every panel in it; so does the tab of a window's only panel. Any other tab
     moves that panel: out on its own, beside another panel, or behind it as a tab. A window dropped
     on another's panel joins it the same ways. Nothing moves until the pointer travels a few
     pixels, so a click still selects. */
  const DRAG_THRESHOLD_PX = 4
  /** Of a panel's box, the share along each edge that splits beside it; the middle adds a tab. */
  const EDGE_ZONE = 0.25
  /** Where a panel dragged out on its own sits under the pointer. */
  const GHOST_OFFSET = { x: 24, y: 14 }
  type Dragged =
    | { readonly kind: 'panel'; readonly id: StudioWindowId }
    | { readonly kind: 'frame'; readonly frame: number }
  interface Drag {
    readonly what: Dragged
    readonly pointerId: number
    readonly startX: number
    readonly startY: number
    /** The pointer's offset into what moves, and its size. */
    readonly dx: number
    readonly dy: number
    readonly width: number
    readonly height: number
    readonly started: boolean
    readonly x: number
    readonly y: number
    readonly drop: StudioDrop | null
    readonly indicator: Box | null
  }
  let root = $state<HTMLElement>()
  let drag = $state<Drag | null>(null)

  const boxOf = (element: Element | null | undefined): Box | undefined => {
    const rect = element?.getBoundingClientRect()
    return rect === undefined ? undefined : { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }
  const frameElement = (index: number): HTMLElement | null | undefined => root?.querySelector<HTMLElement>(`[data-frame="${index}"]`)
  const titleOf = (id: StudioWindowId): string => STUDIO_WINDOWS.find((window) => window.id === id)?.title ?? id

  const beginDrag = (what: Dragged, event: PointerEvent, box: Box): void => {
    if (event.button !== 0 || drag !== null) return
    event.preventDefault()
    drag = {
      what,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - box.x,
      dy: event.clientY - box.y,
      width: box.width,
      height: box.height,
      started: false,
      x: event.clientX,
      y: event.clientY,
      drop: null,
      indicator: null,
    }
  }
  /** A panel's tab, or with `whole` the rest of its header, which moves its window. */
  const startPanelDrag = (id: StudioWindowId, frame: number, whole: boolean, event: PointerEvent): void => {
    const owner = layout.frames[frame]
    if (whole || (owner !== undefined && panelsIn(owner.root).length === 1)) {
      const box = boxOf(frameElement(frame))
      if (box !== undefined) beginDrag({ kind: 'frame', frame }, event, box)
      return
    }
    const box = boxOf(root?.querySelector(`[data-panels~="${id}"]`))
    if (box !== undefined) beginDrag({ kind: 'panel', id }, event, box)
  }
  /** The panels a drag carries. */
  const carried = (what: Dragged): StudioWindowId[] =>
    what.kind === 'frame' ? panelsIn(layout.frames[what.frame]?.root) : [what.id]

  /** Where the dragged panel or window would land with the pointer at `x`, `y`, and what to highlight. */
  const dropAt = (current: Drag, x: number, y: number): { drop: StudioDrop; indicator: Box | null } => {
    const { what } = current
    const viewport = { width: innerWidth, height: innerHeight }
    const draggedPanels = carried(what)
    // Later windows draw on top: the frontmost comes last.
    for (const element of [...(root?.querySelectorAll<HTMLElement>('[data-window]') ?? [])].reverse()) {
      const box = boxOf(element)
      if (box === undefined || x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height) continue
      // A panel splitting from its own tabs lands beside one that stays.
      const target = (element.dataset.panels ?? '').split(' ').find((id) => !draggedPanels.includes(id as StudioWindowId)) as StudioWindowId | undefined
      if (target === undefined) continue
      const edges = { left: (x - box.x) / box.width, right: 1 - (x - box.x) / box.width, top: (y - box.y) / box.height, bottom: 1 - (y - box.y) / box.height }
      const [nearest, distance] = Object.entries(edges).reduce((best, entry) => (entry[1] < best[1] ? entry : best))
      const zone = distance < EDGE_ZONE ? (nearest as keyof typeof edges) : 'center'
      const half = { left: { ...box, width: box.width / 2 }, right: { ...box, x: box.x + box.width / 2, width: box.width / 2 }, top: { ...box, height: box.height / 2 }, bottom: { ...box, y: box.y + box.height / 2, height: box.height / 2 }, center: box }
      return { drop: { kind: 'attach', target, zone }, indicator: half[zone] }
    }
    const offset = what.kind === 'frame' ? { x: current.dx, y: current.dy } : GHOST_OFFSET
    const floated = { x: x - offset.x, y: y - offset.y, width: current.width, height: current.height }
    return { drop: { kind: 'float', place: floatPlace(floated, viewport) }, indicator: null }
  }

  const moveDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return
    const { drop, indicator } = dropAt(drag, event.clientX, event.clientY)
    drag = { ...drag, started: true, x: event.clientX, y: event.clientY, drop, indicator }
  }
  const endDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return
    const { what, started, drop } = drag
    drag = null
    if (!started || drop === null) return
    commitLayout(what.kind === 'panel' ? movePanel(layout, what.id, drop) : moveFrame(layout, what.frame, drop))
  }
  /** The browser gave up the gesture, so nothing was released anywhere. */
  const cancelDrag = (event: PointerEvent): void => {
    if (drag?.pointerId === event.pointerId) drag = null
  }

  /** A moving frame follows the pointer from its own place, so its panels stay mounted. */
  const followed = (index: number) =>
    drag?.started === true && drag.what.kind === 'frame' && drag.what.frame === index ? drag : null

  /* Too narrow for both columns side by side (two 18rem windows clear of Wplace's controls): one
     sheet along the bottom shows a window at a time; tapping its tab again folds the sheet away to
     uncover the map. */
  const PHONE = '(max-width: 43rem)'
  let phone = $state(typeof matchMedia === 'function' && matchMedia(PHONE).matches)
  $effect(() => {
    const query = matchMedia(PHONE)
    const update = (): void => { phone = query.matches }
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  })
  const uid = $props.id()
  let sheet = $state<StudioWindowId | null>('dimensions')
  const pickSheet = (id: StudioWindowId): void => { sheet = sheet === id ? null : id }

  /* The bar's popups, and crop mode's keys: Enter applies the crop, Escape discards it. */
  let popup = $state<'panels' | 'image' | null>(null)
  const togglePopup = (which: 'panels' | 'image'): void => { popup = popup === which ? null : which }
  /** Loading an image from the Replace image popup closes it. */
  const pickImage = (intent: TemplateStudioIntent): void => {
    popup = null
    onIntent(intent)
  }
  const inField = (event: Event): boolean =>
    event.composedPath().some((node) => node instanceof HTMLElement && node.matches('input, select, textarea'))
  const onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && popup !== null) {
      event.preventDefault()
      event.stopImmediatePropagation()
      popup = null
      return
    }
    if (model.cropping === null || (event.key !== 'Escape' && event.key !== 'Enter')) return
    if (event.key === 'Enter' && inField(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onIntent(event.key === 'Enter' ? { type: 'crop-apply' } : { type: 'crop-mode', on: false })
  }

  /* An image dropped anywhere over the studio becomes its source. */
  let dropping = $state(false)
  const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true
  const onWindowDragover = (event: DragEvent): void => {
    if (!carriesFiles(event) || model.pending) return
    event.preventDefault()
    dropping = true
  }
  const onWindowDragleave = (event: DragEvent): void => {
    if (event.relatedTarget === null) dropping = false
  }
  const onWindowDrop = (event: DragEvent): void => {
    dropping = false
    if (event.defaultPrevented || !carriesFiles(event)) return
    event.preventDefault()
    const file = [...(event.dataTransfer?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'))
    if (file !== undefined && !model.pending) onIntent({ type: 'file', file })
  }
  const onWindowPointerdown = (event: PointerEvent): void => {
    if (popup !== null && !event.composedPath().some((node) => node instanceof Element && node.classList.contains('popup-anchor'))) popup = null
  }

  /* Bar. */
  const replacing = $derived(model.target.kind === 'replace')
  const status = $derived.by((): string => {
    if (model.message !== undefined) return model.message
    // Before its image, the map shows how to load one.
    if (model.loadingSource || model.source === null) return ''
    const processing = model.processing
    switch (processing.state) {
      case 'working':
        return processing.progress === null ? 'Processing…' : `Processing… ${Math.round(processing.progress * 100)}%`
      case 'failed':
        return processing.message
      case 'ready':
        return `${model.output.width} × ${model.output.height} · ${processing.colours === 1 ? '1 colour' : `${processing.colours} colours`}`
      default:
        return ''
    }
  })
  /** Pixels to paint and the engine that made them, for whoever wonders. */
  const statusDetail = $derived(
    model.processing.state === 'ready' && model.engine !== null
      ? `${model.processing.pixels.toLocaleString()} pixels to paint · processed on the ${model.engine.toUpperCase()}`
      : undefined,
  )

  /* Crop mode's card, under the crop on the map, edits the crop being drawn. */
  const CROP_FIELDS = [['x', 'X'], ['y', 'Y'], ['width', 'W'], ['height', 'H']] as const
  const setCropField = (field: (typeof CROP_FIELDS)[number][0], value: number): void => {
    if (model.cropping === null || !Number.isFinite(value)) return
    onIntent({ type: 'crop-draft', crop: { ...model.cropping.draft, [field]: Math.round(value) } })
  }
  const wholeImage = $derived(model.source === null ? null : { x: 0, y: 0, width: model.source.width, height: model.source.height })
  const sameRect = (left: StudioRect | null, right: StudioRect | null): boolean =>
    left !== null && right !== null && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
  /** Not while a crop is being drawn: what would be saved is not what the map shows. */
  const canSave = $derived(
    !model.pending &&
      !model.loadingSource &&
      model.cropping === null &&
      model.processing.state === 'ready' &&
      model.processing.pixels > 0 &&
      model.name.trim() !== '',
  )
</script>

<svelte:window
  onpointermove={moveDrag}
  onpointerup={endDrag}
  onpointercancel={cancelDrag}
  onkeydowncapture={onWindowKeydown}
  onpointerdowncapture={onWindowPointerdown}
  ondragover={onWindowDragover}
  ondragleave={onWindowDragleave}
  ondrop={onWindowDrop}
/>

{#snippet contents(id: StudioWindowId)}
  {#if id === 'dimensions'}
    <DimensionsWindow {model} {onIntent} />
  {:else if id === 'palette'}
    <PaletteWindow {model} {onIntent} />
  {:else if id === 'dither'}
    <DitherWindow {model} {onIntent} />
  {:else if id === 'effects'}
    <EffectsWindow {model} {onIntent} />
  {:else if id === 'scopes'}
    <ScopesWindow {model} {onIntent} />
  {/if}
{/snippet}

<!-- `part` marks the parts a docked frame stacks, which a panel docks between. -->
{#snippet nodeView(node: StudioNode, frame: number)}
  {#if node.kind === 'split'}
    <div class="split" data-axis={node.axis}>
      {#each node.children as child (panelsIn(child).join(' '))}
        {@render nodeView(child, frame)}
      {/each}
    </div>
  {:else}
    <div class="place" class:collapsed={node.collapsed} data-window={node.active} data-panels={node.panels.join(' ')}>
      <StudioWindow
        tabs={node.panels.map((id) => ({ id, title: titleOf(id) }))}
        active={node.active}
        collapsed={node.collapsed}
        onSelect={(id) => commitLayout(selectPanel(layout, id))}
        onDragStart={(id, event) => startPanelDrag(id, frame, false, event)}
        onWindowDragStart={(event) => startPanelDrag(node.active, frame, true, event)}
        onCollapse={(collapsed) => commitLayout(collapsePanel(layout, node.active, collapsed))}
        onClose={(id) => commitLayout(togglePanel(layout, id, false))}
      >
        {@render contents(node.active)}
      </StudioWindow>
    </div>
  {/if}
{/snippet}

{#snippet frameView(frame: StudioFrame, index: number)}
  {@const moving = followed(index)}
  <!-- A moving frame follows the pointer from its own place, so its panels stay mounted. -->
  <div
    class="frame caelestis-panel-surface"
    class:moving={moving !== null}
    data-frame={index}
    style:left={moving === null ? undefined : `${moving.x - moving.dx}px`}
    style:top={moving === null ? undefined : `${moving.y - moving.dy}px`}
  >
    {@render nodeView(frame.root, index)}
  </div>
{/snippet}

<div class="studio" bind:this={root} aria-label="Template studio">
  <div class="bar main caelestis-surface" role="toolbar" aria-label={replacing ? 'Replace template' : 'New template'}>
    <input
      class="name caelestis-field"
      aria-label="Template name"
      placeholder="Template name"
      maxlength="80"
      value={model.name}
      disabled={model.pending}
      oninput={(event) => onIntent({ type: 'name', name: event.currentTarget.value })}
    />
    <p class="status" hidden={status === ''} class:failed={model.processing.state === 'failed' || model.message !== undefined} title={statusDetail} aria-live="polite">{status}</p>
    <div class="tools">
      <div class="popup-anchor">
        <Button label="Replace image" kind="ghost" size="small" popup="dialog" pressed={popup === 'image'} disabled={model.source === null || model.pending} onclick={() => togglePopup('image')} />
        {#if popup === 'image'}
          <div class="popover caelestis-surface" role="dialog" aria-label="Replace image">
            <ImagePicker {model} onIntent={pickImage} />
          </div>
        {/if}
      </div>
      <Button
        label="Crop"
        kind="ghost"
        size="small"
        pressed={model.cropping !== null}
        disabled={model.source === null || model.pending}
        onclick={() => onIntent({ type: 'crop-mode', on: model.cropping === null })}
      />
    </div>
    <div class="group">
      <Button label="Undo" title="Undo" kind="ghost" size="compact" iconOnly disabled={model.pending || !model.history.undo} onclick={() => onIntent({ type: 'undo' })}>
        <Icon name="undo" />
      </Button>
      <Button label="Redo" title="Redo" kind="ghost" size="compact" iconOnly disabled={model.pending || !model.history.redo} onclick={() => onIntent({ type: 'redo' })}>
        <Icon name="redo" />
      </Button>
    </div>
    <div class="windows popup-anchor" hidden={phone}>
      <Button label="Panels" kind="ghost" size="small" popup="menu" pressed={popup === 'panels'} onclick={() => togglePopup('panels')} />
      {#if popup === 'panels'}
        <div class="menu caelestis-menu" role="menu" aria-label="Panels">
          {#each STUDIO_WINDOWS as window (window.id)}
            {@const open = isOpen(layout, window.id)}
            <button
              type="button"
              class="caelestis-menu-item"
              role="menuitemcheckbox"
              aria-checked={open}
              onclick={() => commitLayout(togglePanel(layout, window.id, !open))}
            >
              <span class="check">{#if open}<Icon name="check" size="1rem" />{/if}</span>
              {window.title}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="actions">
      <Button label="Cancel" kind="ghost" size="small" disabled={model.pending} onclick={() => onIntent({ type: 'cancel' })} />
      <Button label={replacing ? 'Replace template' : 'Save'} kind="primary" size="small" disabled={!canSave} onclick={() => onIntent({ type: 'save' })} />
    </div>
    <span class="break" aria-hidden="true"></span>
  </div>

  <!-- Before its image, the middle of the map says how to load one. -->
  {#if model.source === null}
    <div class="first-image caelestis-panel-surface" role="group" aria-label="Image">
      {#if model.loadingSource}
        <p class="lead">Loading image…</p>
      {:else}
        <p class="lead"><strong>Start with an image.</strong> Drop one anywhere, paste it, or load it here.</p>
        <ImagePicker {model} {onIntent} />
      {/if}
    </div>
  {/if}

  <!-- Under the crop on the map. -->
  {#if model.cropping !== null}
    {@const draft = model.cropping.draft}
    {@const content = model.cropping.content}
    <div
      class="crop-card caelestis-panel-surface"
      role="group"
      aria-label="Crop"
      style:--frame-centre={mapBox === null ? undefined : `${mapBox.x + mapBox.width / 2}px`}
      style:--frame-bottom={mapBox === null ? undefined : `${mapBox.y + mapBox.height}px`}
    >
      <div class="crop-fields">
        {#each CROP_FIELDS as [field, label] (field)}
          <label>
            <span>{label}</span>
            <input
              class="caelestis-field"
              type="number"
              inputmode="numeric"
              min={field === 'width' || field === 'height' ? 1 : 0}
              value={draft[field]}
              disabled={field === 'height' && model.output.locked}
              onkeydown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
              onchange={(event) => {
                setCropField(field, event.currentTarget.valueAsNumber)
                event.currentTarget.value = String(model.cropping?.draft[field] ?? draft[field])
              }}
            />
          </label>
        {/each}
      </div>
      <div class="crop-actions">
        <Button label="Apply" kind="primary" size="small" disabled={sameRect(draft, model.crop)} onclick={() => onIntent({ type: 'crop-apply' })} />
        <Button label="Content" title={content === null ? 'Nothing transparent around the image to crop away' : 'Crop to the opaque pixels'} kind="ghost" size="small" disabled={content === null || sameRect(draft, content)} onclick={() => { if (content !== null) onIntent({ type: 'crop-draft', crop: content }) }} />
        <Button label="Reset" title="The whole image" kind="ghost" size="small" disabled={sameRect(draft, wholeImage)} onclick={() => { if (wholeImage !== null) onIntent({ type: 'crop-draft', crop: wholeImage }) }} />
        <Button label="Cancel" kind="ghost" size="small" onclick={() => onIntent({ type: 'crop-mode', on: false })} />
      </div>
    </div>
  {/if}

  {#if dropping}
    <div class="dropping" aria-hidden="true"><p class="caelestis-surface">Drop to use this image</p></div>
  {/if}

  {#if phone}
    <div class="sheet caelestis-panel-surface">
      <div class="tabs" role="tablist" aria-label="Windows">
        {#each STUDIO_WINDOWS as window (window.id)}
          <button
            type="button"
            role="tab"
            id="{uid}-tab-{window.id}"
            aria-selected={sheet === window.id}
            aria-controls="{uid}-sheet"
            onclick={() => pickSheet(window.id)}
          >{window.title}</button>
        {/each}
      </div>
      <!-- Cropping folds the sheet down to its tabs, uncovering the image being cropped. -->
      {#if sheet !== null && model.cropping === null}
        <div class="sheet-body" id="{uid}-sheet" role="tabpanel" aria-labelledby="{uid}-tab-{sheet}">{@render contents(sheet)}</div>
      {/if}
    </div>
  {:else}
    {#each layout.frames as frame, index (panelsIn(frame.root).join(' '))}
      {@const place = frame.place}
      <div class="float" style:--float-x="{place.x}px" style:--float-y="{place.y}px" style:--float-across={panelsAcross(frame.root)} style:inset-inline-start={place.edge === 'start' ? 'var(--float-inset)' : 'auto'} style:inset-inline-end={place.edge === 'end' ? 'var(--float-inset)' : 'auto'}>
        {@render frameView(frame, index)}
      </div>
    {/each}

    {#if drag?.started === true}
      {#if drag.indicator !== null}
        <div class="drop-indicator" style:left="{drag.indicator.x}px" style:top="{drag.indicator.y}px" style:width="{drag.indicator.width}px" style:height="{drag.indicator.height}px"></div>
      {/if}
      {#if drag.what.kind === 'panel'}
        <div class="ghost caelestis-panel-surface" style:left="{drag.x - GHOST_OFFSET.x}px" style:top="{drag.y - GHOST_OFFSET.y}px">{carried(drag.what).map(titleOf).join(', ')}</div>
      {/if}
    {/if}
  {/if}
</div>

<MenuStyles />
<StudioStyles />

<style>
  .studio {
    --studio-inset: 12px;
    --studio-top: calc(var(--studio-inset) + 3.75rem);
    /* Clear of Wplace's buttons along the bottom. Windows start clear of its other controls too
       (`EDGE_PLACES`). */
    --studio-bottom: 76px;
    --studio-window-width: min(18rem, calc(100vw - 2 * var(--studio-inset)));
    position: fixed;
    inset: 0;
    pointer-events: none;
    font: 0.875rem/1.4 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    color: var(--caelestis-text, #222);
  }
  .bar {
    position: absolute;
    inset-block-start: var(--studio-inset);
    inset-inline: calc(var(--studio-window-width) + 2 * var(--studio-inset));
    margin-inline: auto;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    inline-size: fit-content;
    max-inline-size: calc(100vw - 2 * var(--studio-window-width) - 4 * var(--studio-inset));
    min-inline-size: 0;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-box-radius, var(--caelestis-radius, 1rem));
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
    translate: 0 calc(-100% - var(--studio-inset));
    opacity: 0;
    transition: translate var(--caelestis-duration-medium) var(--caelestis-ease-smooth-out), opacity var(--caelestis-duration-medium) var(--caelestis-ease-smooth-out);
  }
  :host([data-state='open']) .bar { translate: 0 0; opacity: 1; }
  :host([data-state='closing']) .bar { translate: 0 calc(-100% - var(--studio-inset)); opacity: 0; pointer-events: none; transition-duration: var(--caelestis-duration-fast); }
  .name { inline-size: 12rem; min-inline-size: 6rem; flex: 0 1 auto; }
  /* A fixed slot, so the bar keeps its size while the readout changes. */
  .status {
    flex: 0 1 12.5rem;
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.failed { color: var(--caelestis-danger, oklch(0.58 0.2 27)); white-space: normal; }
  .group, .tools { display: flex; flex: 0 0 auto; gap: 0.125rem; }
  .bar > :is(.group, .windows, .actions) { padding-inline-start: 0.5rem; border-inline-start: 1px solid var(--caelestis-border); }
  .popup-anchor { position: relative; }
  .popover {
    position: absolute;
    inset-block-start: calc(100% + 6px);
    inset-inline-start: 0;
    z-index: 2;
    box-sizing: border-box;
    inline-size: var(--studio-window-width);
    padding: 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
  }
  /* Centred on the map, where the image will be. */
  .first-image {
    position: absolute;
    inset-block-start: 40%;
    inset-inline-start: 50%;
    translate: -50% -50%;
    box-sizing: border-box;
    display: grid;
    gap: 0.75rem;
    inline-size: var(--studio-window-width);
    padding: 1rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .lead { margin: 0; color: var(--caelestis-muted-text); }
  .lead strong { display: block; margin-block-end: 0.125rem; color: var(--caelestis-text); }
  /* Centred under the crop, as Ditherette's is, but never off screen or under the bar. */
  .crop-card {
    --card-width: min(18rem, calc(100vw - 2 * var(--studio-inset)));
    --card-height: 6rem;
    --gap: 8px;
    position: fixed;
    inset-inline-start: clamp(
      var(--studio-inset),
      calc(var(--frame-centre, 50vw) - var(--card-width) / 2),
      calc(100vw - var(--studio-inset) - var(--card-width))
    );
    inset-block-start: clamp(
      var(--studio-top),
      calc(var(--frame-bottom, 50vh) + var(--gap)),
      calc(100dvh - var(--studio-bottom) - var(--card-height))
    );
    z-index: 2;
    box-sizing: border-box;
    display: grid;
    gap: 0.5rem;
    inline-size: var(--card-width);
    padding: 0.5rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .crop-fields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.375rem; }
  .crop-fields label { display: grid; gap: 0.25rem; color: var(--caelestis-muted-text); font: 600 0.6875rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif); }
  .crop-fields input { box-sizing: border-box; inline-size: 100%; min-block-size: 1.75rem; text-align: end; font-variant-numeric: tabular-nums; }
  .crop-actions { display: flex; justify-content: center; gap: 0.25rem; }
  /* All four on one line. */
  .crop-actions :global(button.small) { --button-padding: 0.5rem; }
  .dropping {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 14%, transparent);
    outline: 3px dashed var(--caelestis-primary, oklch(0.68 0.15 244));
    outline-offset: -12px;
    pointer-events: none;
  }
  .dropping p {
    margin: 0;
    padding: 0.75rem 1.25rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    background: var(--caelestis-surface, white);
    font-weight: 600;
  }
  .windows { position: relative; flex: 0 0 auto; }
  .menu { position: absolute; inset-block-start: calc(100% + 6px); inset-inline-end: 0; z-index: 2; display: flex; flex-direction: column; min-inline-size: 11rem; }
  .menu button { display: flex; align-items: center; gap: 0.4rem; }
  .check { display: inline-grid; inline-size: 1rem; }
  .actions { display: flex; flex: 0 0 auto; gap: 0.25rem; }
  /* One connected window. Its panels keep their whole height; when they outgrow the room the
     window has, the window scrolls as one, never a panel inside it. */
  .frame {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    max-block-size: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, oklch(0.97 0.01 264));
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .frame.moving { position: fixed; z-index: 3; box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  .frame > .split, .frame > .place { flex: 0 0 auto; }
  .split { display: flex; min-inline-size: 0; }
  .split[data-axis='column'] { flex-direction: column; }
  .split[data-axis='column'] > * + * { border-block-start: 1px solid var(--caelestis-border); }
  .split[data-axis='row'] > * + * { border-inline-start: 1px solid var(--caelestis-border); }
  .place { display: flex; flex: 0 0 auto; min-inline-size: 0; }
  /* A saved place from a larger screen is pulled back in: the whole width stays on screen, and
     at least the title bar above Wplace's bottom controls. Below its top, a window takes the
     height down to those controls, its panels scrolling inside. */
  .float {
    --float-inset: max(0px, min(var(--float-x), calc(100vw - var(--float-across, 1) * var(--studio-window-width))));
    --float-top: min(var(--float-y), calc(100dvh - var(--studio-bottom) - 2.5rem));
    position: absolute;
    inset-block-start: var(--float-top);
    display: flex;
    max-block-size: calc(100dvh - var(--float-top) - var(--studio-bottom));
  }
  .float .frame { max-block-size: inherit; }
  .drop-indicator {
    position: fixed;
    z-index: 4;
    box-sizing: border-box;
    border: 2px solid var(--caelestis-primary, oklch(0.68 0.15 244));
    border-radius: min(var(--caelestis-radius, 0.4rem), 0.4rem);
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 18%, transparent);
    pointer-events: none;
  }
  .ghost {
    position: fixed;
    z-index: 5;
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: min(var(--caelestis-radius, 0.4rem), 0.4rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35));
    font: 600 0.8125rem/1.25 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    pointer-events: none;
  }
  @media (max-width: 52rem) {
    /* Between Wplace's zoom buttons and its account button, as claim mode's bar sits. */
    .bar { inset-inline: 3.5rem 7rem; inline-size: auto; max-inline-size: none; flex-wrap: wrap; row-gap: 0.375rem; }
    .bar > :is(.group, .windows, .actions) { padding-inline-start: 0; border: 0; }
    /* Three rows: the name and Save; the tools and Cancel; then the readout. */
    .main .actions { display: contents; }
    .main .name { order: 1; flex: 1 1 0; }
    .main .actions > :global(button:last-child) { order: 2; }
    .main .break { order: 3; flex-basis: 100%; }
    .main .tools { order: 4; }
    .main .group { order: 5; }
    .main .actions > :global(button:first-child) { order: 6; margin-inline-start: auto; }
    .main .status { order: 7; flex-basis: 100%; }
    /* Below the bar, which wraps across the whole width here. */
    .float { --float-top: max(var(--float-y), calc(var(--studio-inset) + 8.5rem)); }
  }
  .break { display: none; }
  @media (max-width: 52rem) { .break { display: block; } }
  /* Clear of Wplace's bottom controls, as claim mode's phone card is. */
  .sheet {
    position: absolute;
    inset: auto max(8px, env(safe-area-inset-right)) calc(4.25rem + env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
    display: flex;
    flex-direction: column;
    max-block-size: 50dvh;
    overflow: hidden;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, 0.7rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  /* The tabs scroll sideways; the fading end says there are more. */
  .tabs { display: flex; flex: 0 0 auto; overflow-x: auto; scrollbar-width: none; mask-image: linear-gradient(to right, #000 calc(100% - 2rem), transparent); }
  .tabs button {
    flex: 0 0 auto;
    min-block-size: 2.75rem;
    padding: 0 0.75rem;
    border: 0;
    border-block-end: 2px solid transparent;
    background: none;
    color: var(--caelestis-muted-text);
    font: 600 0.8125rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  .tabs button[aria-selected='true'] { border-block-end-color: var(--caelestis-primary, oklch(0.68 0.15 244)); color: var(--caelestis-text); }
  .sheet-body {
    --caelestis-content-inset: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0.75rem var(--caelestis-content-inset);
    border-block-start: 1px solid var(--caelestis-border);
  }
  @media (prefers-reduced-motion: reduce) {
    .bar { transition: none; translate: none; }
  }
</style>
