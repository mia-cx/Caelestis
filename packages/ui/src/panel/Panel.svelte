<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { cancelSurfaceClose, closeSurface, prefersReducedMotion, shift, surfaceCloseDurationMs, tokenized } from '../foundations/motion.js'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import ModalStyles from '../foundations/ModalStyles.svelte'
  import AppearanceEditor from '../appearance/AppearanceEditor.svelte'
  import TemplateTree from '../tree/TemplateTree.svelte'
  import PanelDrawers from './PanelDrawers.svelte'
  import SettingsPanel from '../settings/SettingsPanel.svelte'
  import type { TemplateTreeIntent } from '../tree/model.js'
  import type { PanelIntent, PanelModel, PanelView } from './model.js'

  let { model, onIntent }: { model: PanelModel; onIntent?: (intent: PanelIntent) => void } = $props()
  let width = $state(0)
  let held = false
  let resizing = $state(false)
  let startX = 0
  let startWidth = 0
  let poppedOut = $state(false)
  let closingPopout = $state(false)
  let dialog = $state<HTMLDialogElement>()
  let popoutButton = $state<HTMLButtonElement>()

  /**
   * Morph between the dialog's box and the docked panel's box. The dialog's parent is `.pane`,
   * which sits exactly where the docked panel is, so `from` maps the current box onto it:
   * forward grows the popout out of the docked spot, reverse lands it back on it just as the
   * docked panel re-renders there. `reverse` fills forwards to hold the docked box through the
   * CSS close. Opacity stays 1 so the `@starting-style` fade doesn't ghost it.
   */
  const morph = (target: HTMLDialogElement, reverse: boolean): void => {
    const parent = target.parentElement
    if (prefersReducedMotion() || parent === null) return
    const style = getComputedStyle(target)
    const duration = surfaceCloseDurationMs(target, reverse ? '--modal-close-dur' : '--modal-open-dur')
    const docked = parent.getBoundingClientRect()
    if (duration <= 0 || docked.width === 0 || docked.height === 0) return
    const box = target.getBoundingClientRect()
    const transform = `translate(${docked.left - box.left}px, ${docked.top - box.top}px) scale(${docked.width / box.width}, ${docked.height / box.height})`
    const at = { transform, transformOrigin: 'top left', opacity: 1 }
    const rest = { transform: 'none', transformOrigin: 'top left', opacity: 1 }
    target.animate(reverse ? [rest, at] : [at, rest], {
      duration,
      easing: style.getPropertyValue('--modal-ease') || 'ease-out',
      fill: reverse ? 'forwards' : 'both',
    })
  }

  // The host hears about the modal after it opens and before it closes, so anything it needs to
  // show above the popout, such as toasts, can move into the dialog while it exists.
  $effect(() => {
    if (poppedOut && !closingPopout && dialog != null && !dialog.open) {
      dialog.showModal()
      emit({ type: 'popout', open: true })
      morph(dialog, false)
    }
  })

  onDestroy(() => { if (dialog != null) cancelSurfaceClose(dialog) })

  const dock = (): void => {
    if (closingPopout || dialog == null) return
    closingPopout = true
    emit({ type: 'popout', open: false })
    morph(dialog, true)
    dialog.close()
    closeSurface(dialog, () => {
      poppedOut = false
      closingPopout = false
      void tick().then(() => popoutButton?.focus())
    })
  }

  const treeIntent = (intent: TemplateTreeIntent, work = false): void => {
    const tree = work ? model.work?.tree : model.tree
    // Map navigation, file pickers, and placement return to the interactive canvas.
    const entry = intent.type === 'action' ? tree?.entries.find((entry) => entry.key === intent.key) : undefined
    const action = intent.type === 'context-menu-action'
      ? tree?.contextMenu?.items.find((item) => item.id === intent.actionId)
      : intent.type === 'action' && entry?.type === 'row'
        ? [...(entry.leadingActions ?? []), ...(entry.actions ?? [])].find((action) => action.id === intent.actionId)
        : entry?.type === 'action' ? entry.action
        : undefined
    if (poppedOut && action?.returnToCanvas === true) void dock()
    emit({ type: work ? 'work-tree' : 'tree', intent })
  }

  const drawerIntent = (intent: PanelIntent): void => {
    if (intent.type === 'work-tree') return treeIntent(intent.intent, true)
    // Claiming and flying act on the map, so the popout returns to the sidebar first.
    if (poppedOut && (intent.type === 'region-claim' || intent.type === 'presence-fly' || intent.type === 'claim-fly')) void dock()
    emit(intent)
  }

  $effect(() => { width = model.width })

  const clamp = (value: number): number =>
    Math.min(model.maxWidth, Math.max(model.minWidth, Math.round(value)))

  const emit = (intent: PanelIntent): void => onIntent?.(intent)

  /**
   * Side-by-side page slide between views (transitions.dev 08). Forward — tree → anything, or
   * settings ↔ appearance — enters from +distance-large and exits toward -distance-large; coming
   * back to the tree reverses it. `dir` reads the current view, so the outgoing page picks the
   * same direction as the incoming one. Distance and blur come from the motion tokens; the
   * duration is resolved per node by `tokenized`.
   */
  const page = tokenized(shift, '--caelestis-duration-fast')
  const pageDir = $derived(model.view === 'tree' ? -1 : 1)

  const navigate = (view: PanelView): void => {
    emit({ type: 'navigate', view: model.view === view ? 'tree' : view })
  }

  const keydown = (event: KeyboardEvent): void => {
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    if (step === 0) return
    event.preventDefault()
    held = true
    width = clamp(width + step)
    emit({ type: 'resize-preview', width })
  }

  const commit = (): void => {
    if (!held && !resizing) return
    held = false
    resizing = false
    emit({ type: 'resize-commit', width })
  }

  const pointerdown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || resizing) return
    event.preventDefault()
    resizing = true
    startX = event.clientX
    startWidth = width
    // Move and up are read from the window, so capture only carries the drag past the page's edge.
    // A pointer that has already ended cannot be captured, which the browser reports as a DOMException.
    if (!(event.currentTarget instanceof Element)) return
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) { if (!(error instanceof DOMException)) throw error }
  }

  const pointermove = (event: PointerEvent): void => {
    if (!resizing) return
    width = clamp(startWidth - (event.clientX - startX))
    emit({ type: 'resize-preview', width })
  }

  const title = $derived(model.view === 'tree' ? (model.title ?? 'Caelestis') : model.view === 'settings' ? 'Settings' : 'Appearance')
</script>

<svelte:window onpointermove={pointermove} onpointerup={commit} onpointercancel={commit} />

{#snippet contents()}
<section class="panel caelestis-panel-surface" aria-label="Caelestis">
  {#if !poppedOut}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class:resizing
    class="resize"
    role="separator"
    aria-label="Resize panel"
    aria-orientation="vertical"
    aria-valuenow={width}
    aria-valuemin={model.minWidth}
    aria-valuemax={model.maxWidth}
    tabindex="0"
    onkeydown={keydown}
    onkeyup={commit}
    onblur={commit}
    onpointerdown={pointerdown}
  ></div>
  {/if}

  <header>
    {#if model.view !== 'tree'}
      <Button label="Back to templates" kind="ghost" size="compact" iconOnly onclick={() => emit({ type: 'navigate', view: 'tree' })}>
        <Icon name="arrowBack" />
      </Button>
    {/if}
    <h2>{title}</h2>
    <Button label="Reload tiles" kind="ghost" size="compact" iconOnly onclick={() => emit({ type: 'reload-tiles' })}>
      <Icon name="reset" />
    </Button>
    <Button bind:element={popoutButton} label={poppedOut ? 'Return to sidebar' : 'Pop out menu'} popup={poppedOut ? undefined : 'dialog'} kind="ghost" size="compact" iconOnly onclick={() => { if (poppedOut) void dock(); else poppedOut = true }}>
      <Icon name={poppedOut ? 'dock' : 'popout'} />
    </Button>
    <Button label="Appearance" kind="ghost" size="compact" iconOnly pressed={model.view === 'appearance'} onclick={() => navigate('appearance')}>
      <Icon name="tune" />
    </Button>
    {#if model.showSettings !== false}
      <Button label="Settings" kind="ghost" size="compact" iconOnly pressed={model.view === 'settings'} onclick={() => navigate('settings')}>
        <Icon name="settings" />
      </Button>
    {/if}
    <Button label="Close" kind="ghost" size="compact" iconOnly onclick={() => { if (poppedOut) void dock(); else emit({ type: 'close' }) }}>
      <Icon name="close" />
    </Button>
  </header>

  <div class="body">
    {#each [model.view] as view (view)}
      <div class="page" in:page|global={{ distance: '--caelestis-distance-large', dx: pageDir, blur: '--caelestis-blur-small' }} out:page|global={{ distance: '--caelestis-distance-large', dx: -pageDir, blur: '--caelestis-blur-small' }}>
        {#if view === 'tree' && model.tree !== undefined}
          <TemplateTree model={model.tree} allowGrid={poppedOut} onIntent={treeIntent} />
          {#if model.work !== undefined}
            <PanelDrawers model={model.work} showOtherClaims={model.showOtherClaims ?? false} onIntent={drawerIntent} />
          {/if}
        {:else if view === 'appearance' && model.appearance !== undefined}
          <AppearanceEditor model={model.appearance} onIntent={(intent) => emit({ type: 'appearance', intent })} />
        {:else if view === 'settings' && model.settings !== undefined}
          <SettingsPanel model={model.settings} onIntent={(intent) => emit({ type: 'settings', intent })} />
        {/if}
      </div>
    {/each}
  </div>
</section>
{/snippet}

<ModalStyles />

{#if poppedOut}
  <dialog bind:this={dialog} class="caelestis-modal" aria-label="Caelestis menu" oncancel={(event) => { event.preventDefault(); if (model.tree?.contextMenu === undefined) void dock() }} onclick={(event) => { if (event.target === dialog) void dock() }}>
    {@render contents()}
  </dialog>
{:else}
  <div class="docked">{@render contents()}</div>
{/if}

<style>
  .docked { block-size: 100%; min-block-size: 0; }
  /* The popout morphs out of the docked panel instead of scaling, so it only fades. */
  dialog {
    --modal-open-dur: var(--caelestis-duration-medium);
    --modal-close-dur: var(--caelestis-duration-fast);
    --modal-scale: none;
    position: fixed; inset: 0; inline-size: 96vw; block-size: 96dvh; max-inline-size: none; max-block-size: none; margin: auto; padding: 0; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius); overflow: visible; color: inherit; background: transparent;
  }
  dialog .panel { border-radius: var(--caelestis-radius); }
  .panel { container: panel / inline-size; }
  .panel { --caelestis-content-inset: 1rem; position: relative; display: flex; flex-direction: column; min-block-size: 0; block-size: 100%; overflow: hidden; border-radius: var(--caelestis-radius); background: var(--caelestis-surface, oklch(0.97 0.01 264)); color: var(--caelestis-text, oklch(0.26 0.025 264)); box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.5rem; padding: 1rem 1.5rem; border-block-end: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7)); }
  h2 { flex: 1; margin: 0; font: 600 0.875rem/1.25 var(--caelestis-font); }
  .body { display: grid; flex: 1; min-block-size: 0; }
  /* Outgoing and incoming pages share one grid cell so the swap never shifts layout. */
  .page { grid-area: 1 / 1; display: flex; flex-direction: column; min-block-size: 0; min-inline-size: 0; }
  .resize { position: absolute; inset-block: 0; inset-inline-start: 0; z-index: 1; inline-size: 6px; cursor: ew-resize; }
  .resize:hover::after, .resize.resizing::after, .resize:focus-visible::after { content: ''; position: absolute; inset: 0 2px 0 1px; border-radius: var(--caelestis-pill-radius); background: var(--caelestis-primary, currentColor); opacity: 0.5; }
  .resize:focus-visible { outline: none; }
  @container panel (max-width: 24rem) {
    header { gap: 0.25rem; padding-inline: 0.75rem; }
  }
</style>
