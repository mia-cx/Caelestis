<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { collapseWindow, dockedWindows, dropWindow, placementOf, toggleWindow, type Box } from './layout.js'
  import { STUDIO_WINDOWS, type StudioLayout, type StudioWindowId, type TemplateStudioIntent, type TemplateStudioModel } from './model.js'
  import StudioStyles from './StudioStyles.svelte'
  import StudioWindow from './StudioWindow.svelte'
  import DimensionsWindow from './windows/DimensionsWindow.svelte'
  import SourceWindow from './windows/SourceWindow.svelte'

  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  /* Layout: the model's saved layout, with this drag applied until the next model arrives. */
  let layout = $state<StudioLayout>({})
  $effect.pre(() => { layout = model.layout })
  const commitLayout = (next: StudioLayout): void => {
    layout = next
    onIntent({ type: 'layout', layout: next })
  }

  let root = $state<HTMLElement>()
  let drag = $state<{ id: StudioWindowId; pointerId: number; dx: number; dy: number; x: number; y: number; width: number; height: number } | null>(null)

  const windowBox = (id: StudioWindowId): Box | undefined => {
    const rect = root?.querySelector(`[data-window="${id}"]`)?.getBoundingClientRect()
    return rect === undefined ? undefined : { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  }
  const startDrag = (id: StudioWindowId, event: PointerEvent): void => {
    if (event.button !== 0 || drag !== null) return
    const box = windowBox(id)
    if (box === undefined) return
    event.preventDefault()
    drag = { id, pointerId: event.pointerId, dx: event.clientX - box.x, dy: event.clientY - box.y, ...box }
  }
  const moveDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return
    drag = { ...drag, x: event.clientX - drag.dx, y: event.clientY - drag.dy }
  }
  const endDrag = (event: PointerEvent): void => {
    if (drag === null || event.pointerId !== drag.pointerId) return
    const { id, x, y, width, height } = drag
    const boxes: Partial<Record<StudioWindowId, Box>> = {}
    for (const other of STUDIO_WINDOWS) {
      const box = other.id === id ? undefined : windowBox(other.id)
      if (box !== undefined) boxes[other.id] = box
    }
    drag = null
    commitLayout(dropWindow(layout, id, { x, y, width, height }, { width: innerWidth, height: innerHeight }, boxes))
  }

  const columns = $derived({
    start: dockedWindows(layout, 'start').filter((id) => id !== drag?.id),
    end: dockedWindows(layout, 'end').filter((id) => id !== drag?.id),
  })
  const floating = $derived(
    STUDIO_WINDOWS.map((window) => window.id).filter((id) => {
      const placement = placementOf(layout, id)
      return placement.open && placement.dock === null && id !== drag?.id
    }),
  )
  const titleOf = (id: StudioWindowId): string => STUDIO_WINDOWS.find((window) => window.id === id)?.title ?? id

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
    !model.pending && model.processing.state === 'ready' && model.processing.pixels > 0 && model.name.trim() !== '',
  )
</script>

<svelte:window onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={endDrag} onkeydowncapture={onWindowKeydown} onpointerdowncapture={onWindowPointerdown} />

{#snippet contents(id: StudioWindowId)}
  {#if id === 'source'}
    <SourceWindow {model} {onIntent} />
  {:else if id === 'dimensions'}
    <DimensionsWindow {model} {onIntent} />
  {/if}
{/snippet}

{#snippet frame(id: StudioWindowId)}
  {@const placement = placementOf(layout, id)}
  <div class="slot" data-window={id}>
    <StudioWindow
      title={titleOf(id)}
      collapsed={placement.collapsed}
      dragging={drag?.id === id}
      onDragStart={(event) => startDrag(id, event)}
      onCollapse={(collapsed) => commitLayout(collapseWindow(layout, id, collapsed))}
      onClose={() => commitLayout(toggleWindow(layout, id, false))}
    >
      {@render contents(id)}
    </StudioWindow>
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
    <div class="windows">
      <Button label="Windows" title="Windows" kind="ghost" size="compact" iconOnly popup="menu" pressed={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
        <Icon name="gridView" />
      </Button>
      {#if menuOpen}
        <div class="menu caelestis-menu" role="menu" aria-label="Windows">
          {#each STUDIO_WINDOWS as window (window.id)}
            {@const open = placementOf(layout, window.id).open}
            <button
              type="button"
              class="caelestis-menu-item"
              role="menuitemcheckbox"
              aria-checked={open}
              onclick={() => commitLayout(toggleWindow(layout, window.id, !open))}
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

  {#each ['start', 'end'] as const as side (side)}
    <div class="column {side}">
      {#each columns[side] as id (id)}{@render frame(id)}{/each}
    </div>
  {/each}

  {#each floating as id (id)}
    {@const placement = placementOf(layout, id)}
    {#if placement.dock === null}
      <div class="float" style:inset-inline-start={placement.edge === 'start' ? `${placement.x}px` : 'auto'} style:inset-inline-end={placement.edge === 'end' ? `${placement.x}px` : 'auto'} style:inset-block-start="{placement.y}px">
        {@render frame(id)}
      </div>
    {/if}
  {/each}

  {#if drag !== null}
    <div class="float dragged" style:left="{drag.x}px" style:top="{drag.y}px">{@render frame(drag.id)}</div>
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
    gap: 8px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: none;
  }
  .column.start { inset-inline-start: var(--studio-start); }
  .column.end { inset-inline-end: var(--studio-end); }
  .slot { display: flex; flex: 0 0 auto; min-block-size: 0; }
  .float { position: absolute; max-block-size: calc(100dvh - var(--studio-top) - var(--studio-bottom)); }
  .float .slot { max-block-size: inherit; }
  .dragged { z-index: 3; }
  @media (max-width: 52rem) {
    .bar { inset-inline: var(--studio-inset); max-inline-size: none; flex-wrap: wrap; }
    .status { order: 1; flex-basis: 100%; }
    .column { inset-block-start: calc(var(--studio-inset) + 6.5rem); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar { transition: none; translate: none; }
  }
</style>
