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
    panelsIn,
    SNAP_DISTANCE,
    type StudioDrop,
    selectPanel,
    togglePanel,
  } from './layout.js'
  import { STUDIO_WINDOWS, type StudioFrame, type StudioLayout, type StudioNode, type StudioWindowId, type TemplateStudioIntent, type TemplateStudioModel } from './model.js'
  import StudioStyles from './StudioStyles.svelte'
  import StudioWindow from './StudioWindow.svelte'
  import ColorSpaceWindow from './windows/ColorSpaceWindow.svelte'
  import DimensionsWindow from './windows/DimensionsWindow.svelte'
  import DitherWindow from './windows/DitherWindow.svelte'
  import EffectsWindow from './windows/EffectsWindow.svelte'
  import PaletteWindow from './windows/PaletteWindow.svelte'
  import ScopesWindow from './windows/ScopesWindow.svelte'
  import SourceWindow from './windows/SourceWindow.svelte'

  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  /* Layout: the model's saved layout, with this drag applied until the next model arrives. */
  let layout = $state<StudioLayout>(DEFAULT_STUDIO_LAYOUT)
  $effect.pre(() => { layout = model.layout })
  const commitLayout = (next: StudioLayout): void => {
    layout = next
    onIntent({ type: 'layout', layout: next })
  }

  /* Dragging. A panel's tab or title moves that panel: out on its own, into a dock, beside another
     panel, or behind it as a tab. A floating frame moves whole by its grip, or by the title of its
     only panel. Nothing moves until the pointer travels a few pixels, so a click still selects. */
  const DRAG_THRESHOLD_PX = 4
  /** Of a panel's box, the share along each edge that splits beside it; the middle adds a tab. */
  const EDGE_ZONE = 0.25
  /** Where a panel dragged out on its own sits under the pointer. */
  const GHOST_OFFSET = { x: 24, y: 14 }
  type Dragged = { readonly kind: 'panel'; readonly id: StudioWindowId } | { readonly kind: 'frame'; readonly frame: number }
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
  /** A panel's tab or title. The only panel of a floating frame carries its frame with it. */
  const startPanelDrag = (id: StudioWindowId, frame: number, event: PointerEvent): void => {
    const owner = layout.frames[frame]
    const alone = owner?.place.dock === null && panelsIn(owner.root).length === 1
    const box = boxOf(alone ? frameElement(frame) : root?.querySelector(`[data-window="${id}"]`))
    if (box !== undefined) beginDrag(alone ? { kind: 'frame', frame } : { kind: 'panel', id }, event, box)
  }
  const startFrameDrag = (frame: number, event: PointerEvent): void => {
    const box = boxOf(frameElement(frame))
    if (box !== undefined) beginDrag({ kind: 'frame', frame }, event, box)
  }

  /** The parts stacked down an edge's frame, as `placing` counts them, skipping `skip`. */
  const dockParts = (side: 'start' | 'end', skip: (part: Element) => boolean): Element[] =>
    [...(root?.querySelectorAll(`.column.${side} [data-part]`) ?? [])].filter((part) => !skip(part))

  /** Where the dragged panel or frame would land with the pointer at `x`, `y`, and what to highlight. */
  const dropAt = (current: Drag, x: number, y: number): { drop: StudioDrop; indicator: Box | null } => {
    const { what } = current
    const viewport = { width: innerWidth, height: innerHeight }
    const draggedPanels = what.kind === 'panel' ? [what.id] : panelsIn(layout.frames[what.frame]?.root)
    const side = x <= SNAP_DISTANCE ? 'start' : x >= viewport.width - SNAP_DISTANCE ? 'end' : null
    if (side !== null) {
      // A part that is only what is being dragged leaves before the drop, so it does not count.
      const parts = dockParts(side, (part) => (part.getAttribute('data-part') ?? '').split(' ').every((id) => draggedPanels.includes(id as StudioWindowId)))
      const index = parts.filter((part) => { const box = boxOf(part); return box !== undefined && box.y + box.height / 2 < y }).length
      const near = boxOf(parts[Math.min(index, parts.length - 1)])
      const column = boxOf(root?.querySelector(`.column.${side}`))
      const line = near === undefined
        ? column
        : { x: near.x, y: index < parts.length ? near.y - 2 : near.y + near.height - 2, width: near.width, height: 4 }
      return { drop: { kind: 'dock', side, index }, indicator: line ?? null }
    }
    for (const element of root?.querySelectorAll<HTMLElement>('[data-window]') ?? []) {
      const target = element.dataset.window as StudioWindowId
      const box = boxOf(element)
      if (box === undefined || x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height) continue
      const own = (element.dataset.panels ?? '').split(' ')
      if (own.every((id) => draggedPanels.includes(id as StudioWindowId))) continue
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

  const docked = $derived({
    start: layout.frames.findIndex((frame) => frame.place.dock === 'start'),
    end: layout.frames.findIndex((frame) => frame.place.dock === 'end'),
  })
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
  let sheet = $state<StudioWindowId | null>('source')
  const pickSheet = (id: StudioWindowId): void => { sheet = sheet === id ? null : id }

  /* Windows menu. */
  let menuOpen = $state(false)
  const onWindowKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !menuOpen) return
    event.preventDefault()
    event.stopImmediatePropagation()
    menuOpen = false
  }
  const onWindowPointerdown = (event: PointerEvent): void => {
    if (menuOpen && !event.composedPath().some((node) => node instanceof Element && node.classList.contains('windows'))) menuOpen = false
  }

  /* Bar. */
  const replacing = $derived(model.target.kind === 'replace')
  const status = $derived.by((): string => {
    if (model.message !== undefined) return model.message
    if (model.loadingSource) return 'Loading image…'
    if (model.source === null) return 'Choose an image to start.'
    const processing = model.processing
    switch (processing.state) {
      case 'working':
        return processing.progress === null ? 'Processing…' : `Processing… ${Math.round(processing.progress * 100)}%`
      case 'failed':
        return processing.message
      case 'ready':
        return `${model.output.width} × ${model.output.height} · ${processing.pixels.toLocaleString()} px · ${processing.colours === 1 ? '1 colour' : `${processing.colours} colours`}`
      default:
        return ''
    }
  })
  const canSave = $derived(
    !model.pending && !model.loadingSource && model.processing.state === 'ready' && model.processing.pixels > 0 && model.name.trim() !== '',
  )
</script>

<svelte:window onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onkeydowncapture={onWindowKeydown} onpointerdowncapture={onWindowPointerdown} />

{#snippet contents(id: StudioWindowId)}
  {#if id === 'source'}
    <SourceWindow {model} {onIntent} />
  {:else if id === 'dimensions'}
    <DimensionsWindow {model} {onIntent} />
  {:else if id === 'palette'}
    <PaletteWindow {model} {onIntent} />
  {:else if id === 'color-space'}
    <ColorSpaceWindow {model} {onIntent} />
  {:else if id === 'dither'}
    <DitherWindow {model} {onIntent} />
  {:else if id === 'effects'}
    <EffectsWindow {model} {onIntent} />
  {:else if id === 'scopes'}
    <ScopesWindow {model} {onIntent} />
  {/if}
{/snippet}

<!-- `part` marks the parts a docked frame stacks, which a panel docks between. -->
{#snippet nodeView(node: StudioNode, frame: number, part: boolean)}
  {#if node.kind === 'split'}
    <div class="split" data-axis={node.axis} data-part={part ? panelsIn(node).join(' ') : undefined}>
      {#each node.children as child (panelsIn(child).join(' '))}
        {@render nodeView(child, frame, false)}
      {/each}
    </div>
  {:else}
    <div class="place" class:collapsed={node.collapsed} data-window={node.active} data-panels={node.panels.join(' ')} data-part={part ? node.panels.join(' ') : undefined}>
      <StudioWindow
        tabs={node.panels.map((id) => ({ id, title: titleOf(id) }))}
        active={node.active}
        collapsed={node.collapsed}
        onSelect={(id) => commitLayout(selectPanel(layout, id))}
        onDragStart={(id, event) => startPanelDrag(id, frame, event)}
        onCollapse={(collapsed) => commitLayout(collapsePanel(layout, node.active, collapsed))}
        onClose={() => commitLayout(togglePanel(layout, node.active, false))}
      >
        {@render contents(node.active)}
      </StudioWindow>
    </div>
  {/if}
{/snippet}

{#snippet frameView(frame: StudioFrame, index: number)}
  {@const moving = followed(index)}
  {@const stacked = frame.place.dock !== null && frame.root.kind === 'split' && frame.root.axis === 'column'}
  <!-- A moving frame follows the pointer from its own place, so its panels stay mounted. -->
  <div
    class="frame caelestis-panel-surface"
    class:moving={moving !== null}
    data-frame={index}
    style:left={moving === null ? undefined : `${moving.x - moving.dx}px`}
    style:top={moving === null ? undefined : `${moving.y - moving.dy}px`}
  >
    {#if frame.place.dock === null && panelsIn(frame.root).length > 1}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="grip" title="Move window" onpointerdown={(event) => startFrameDrag(index, event)}></div>
    {/if}
    {#if stacked && frame.root.kind === 'split'}
      <div class="split" data-axis="column">
        {#each frame.root.children as child (panelsIn(child).join(' '))}{@render nodeView(child, index, true)}{/each}
      </div>
    {:else}
      {@render nodeView(frame.root, index, frame.place.dock !== null)}
    {/if}
  </div>
{/snippet}

<div class="studio" bind:this={root} aria-label="Template studio">
  <div class="bar caelestis-surface" role="toolbar" aria-label={replacing ? 'Replace template' : 'New template'}>
    <input
      class="name caelestis-field"
      aria-label="Template name"
      placeholder="Template name"
      maxlength="80"
      value={model.name}
      disabled={model.pending}
      oninput={(event) => onIntent({ type: 'name', name: event.currentTarget.value })}
    />
    <p class="status" class:failed={model.processing.state === 'failed' || model.message !== undefined} aria-live="polite">
      {status}{#if model.engine !== null && model.source !== null}<span class="engine">{model.engine === 'gpu' ? 'GPU' : 'CPU'}</span>{/if}
    </p>
    <div class="history">
      <Button label="Undo" title="Undo" kind="ghost" size="compact" iconOnly disabled={model.pending || !model.history.undo} onclick={() => onIntent({ type: 'undo' })}>
        <Icon name="undo" />
      </Button>
      <Button label="Redo" title="Redo" kind="ghost" size="compact" iconOnly disabled={model.pending || !model.history.redo} onclick={() => onIntent({ type: 'redo' })}>
        <Icon name="redo" />
      </Button>
    </div>
    <div class="windows" hidden={phone}>
      <Button label="Windows" title="Windows" kind="ghost" size="compact" iconOnly popup="menu" pressed={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
        <Icon name="gridView" />
      </Button>
      {#if menuOpen}
        <div class="menu caelestis-menu" role="menu" aria-label="Windows">
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
  </div>

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
      {#if sheet !== null}
        <div class="sheet-body" id="{uid}-sheet" role="tabpanel" aria-labelledby="{uid}-tab-{sheet}">{@render contents(sheet)}</div>
      {/if}
    </div>
  {:else}
    {#each ['start', 'end'] as const as side (side)}
      {@const index = docked[side]}
      {@const frame = layout.frames[index]}
      <div class="column {side}">
        {#if frame !== undefined}{@render frameView(frame, index)}{/if}
      </div>
    {/each}

    {#each layout.frames as frame, index (panelsIn(frame.root).join(' '))}
      {#if frame.place.dock === null}
        {@const place = frame.place}
        <div class="float" style:--float-x="{place.x}px" style:--float-y="{place.y}px" style:inset-inline-start={place.edge === 'start' ? 'var(--float-inset)' : 'auto'} style:inset-inline-end={place.edge === 'end' ? 'var(--float-inset)' : 'auto'}>
          {@render frameView(frame, index)}
        </div>
      {/if}
    {/each}

    {#if drag?.started === true}
      {#if drag.indicator !== null}
        <div class="drop-indicator" style:left="{drag.indicator.x}px" style:top="{drag.indicator.y}px" style:width="{drag.indicator.width}px" style:height="{drag.indicator.height}px"></div>
      {/if}
      {#if drag.what.kind === 'panel'}
        <div class="ghost caelestis-panel-surface" style:left="{drag.x - GHOST_OFFSET.x}px" style:top="{drag.y - GHOST_OFFSET.y}px">{titleOf(drag.what.id)}</div>
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
    /* Clear of Wplace's own controls: zoom on the left, its rail on the right, buttons below. */
    --studio-start: 48px;
    --studio-end: 56px;
    --studio-bottom: 76px;
    --studio-window-width: min(18rem, calc(100vw - 2 * var(--studio-inset)));
    position: fixed;
    inset: 0;
    pointer-events: none;
    font: 0.8125rem/1.4 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
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
  .status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status.failed { color: var(--caelestis-danger, oklch(0.58 0.2 27)); }
  .engine {
    padding: 0 0.3rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-pill-radius, 999px);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  .history { display: flex; flex: 0 0 auto; }
  .windows { position: relative; flex: 0 0 auto; }
  .menu { position: absolute; inset-block-start: calc(100% + 6px); inset-inline-end: 0; z-index: 2; display: flex; flex-direction: column; min-inline-size: 11rem; }
  .menu button { display: flex; align-items: center; gap: 0.4rem; }
  .check { display: inline-grid; inline-size: 1rem; }
  .actions { display: flex; flex: 0 0 auto; gap: 0.25rem; }
  .column {
    position: absolute;
    inset-block: var(--studio-top) var(--studio-bottom);
    display: flex;
    flex-direction: column;
  }
  .column.start { inset-inline-start: var(--studio-start); }
  .column.end { inset-inline-end: var(--studio-end); }
  /* One connected window. Its panels keep their own height until the frame runs out of room,
     then share it, each scrolling inside, so every panel stays in view. */
  .frame {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    max-block-size: 100%;
    overflow: hidden;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, oklch(0.97 0.01 264));
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .frame.moving { position: fixed; z-index: 3; box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  .frame > .split, .frame > .place { flex: 0 1 auto; min-block-size: 0; }
  .split { display: flex; min-block-size: 0; min-inline-size: 0; }
  .split[data-axis='column'] { flex-direction: column; }
  .split[data-axis='column'] > * + * { border-block-start: 1px solid var(--caelestis-border); }
  .split[data-axis='row'] > * + * { border-inline-start: 1px solid var(--caelestis-border); }
  /* At least its title bar. */
  .place { display: flex; flex: 0 1 auto; min-block-size: 2.25rem; min-inline-size: 0; }
  .place.collapsed, .split[data-axis='row'] > .place { flex-shrink: 0; }
  .grip {
    flex: 0 0 auto;
    block-size: 0.75rem;
    background: radial-gradient(circle, var(--caelestis-muted-text) 1px, transparent 1.5px) center / 6px 6px repeat-x;
    background-size: 6px 100%;
    opacity: 0.6;
    cursor: grab;
    touch-action: none;
  }
  /* A saved place from a larger screen is pulled back in: the whole width stays on screen, and
     at least the title bar above Wplace's bottom controls. */
  .float {
    --float-inset: min(var(--float-x), calc(100vw - var(--studio-window-width)));
    position: absolute;
    inset-block-start: min(var(--float-y), calc(100dvh - var(--studio-bottom) - 2.5rem));
    display: flex;
    max-block-size: calc(100dvh - var(--studio-top) - var(--studio-bottom));
  }
  .float .frame { max-block-size: inherit; }
  .drop-indicator {
    position: fixed;
    z-index: 4;
    box-sizing: border-box;
    border: 2px solid var(--caelestis-primary, oklch(0.68 0.15 244));
    border-radius: var(--caelestis-control-radius, 0.4rem);
    background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 18%, transparent);
    pointer-events: none;
  }
  .ghost {
    position: fixed;
    z-index: 5;
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-control-radius, 0.4rem);
    background: var(--caelestis-surface, white);
    box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35));
    font: 600 0.8125rem/1.25 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    pointer-events: none;
  }
  @media (max-width: 52rem) {
    /* Between Wplace's zoom buttons and its account button, as claim mode's bar sits. */
    .bar { inset-inline: 3.5rem 7rem; inline-size: auto; max-inline-size: none; flex-wrap: wrap; }
    .status { order: 1; flex-basis: 100%; }
    .column { inset-block-start: calc(var(--studio-inset) + 6.5rem); }
  }
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
  .tabs { display: flex; flex: 0 0 auto; overflow-x: auto; scrollbar-width: none; }
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
