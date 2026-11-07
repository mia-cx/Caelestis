<script lang="ts">
  import type { Snippet } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { StudioWindowId } from './model.js'

  /**
   * One place in a studio frame: a tab for each of its panels, a collapse button, and the panel in
   * front. Dragging a tab moves that panel; dragging the rest of the header moves the whole window
   * it belongs to. The studio owns where either lands.
   */
  interface Props {
    tabs: readonly { readonly id: StudioWindowId; readonly title: string }[]
    active: StudioWindowId
    collapsed: boolean
    onSelect: (id: StudioWindowId) => void
    onDragStart: (id: StudioWindowId, event: PointerEvent) => void
    onWindowDragStart: (event: PointerEvent) => void
    onCollapse: (collapsed: boolean) => void
    onClose: (id: StudioWindowId) => void
    children: Snippet
  }
  let { tabs, active, collapsed, onSelect, onDragStart, onWindowDragStart, onCollapse, onClose, children }: Props = $props()

  const id = $props.id()
  const title = $derived(tabs.find((tab) => tab.id === active)?.title ?? '')

  /** Arrow keys move between tabs, as a tab list does; Delete closes the focused one. */
  const tabKey = (event: KeyboardEvent, index: number): void => {
    if (event.key === 'Delete') {
      event.preventDefault()
      onClose(tabs[index]?.id ?? active)
      return
    }
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]
    if (next === undefined) return
    onSelect(next.id)
    ;(event.currentTarget as HTMLElement).closest('[role="tablist"]')?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }
</script>

<section class="window" aria-labelledby="{id}-{active}">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={(event) => { if ((event.target as Element).closest('button') === null) onWindowDragStart(event) }}>
    <div class="tabs" role="tablist">
      {#each tabs as tab, index (tab.id)}
        <div class="tab" class:active={tab.id === active}>
          <button
            type="button"
            role="tab"
            id="{id}-{tab.id}"
            data-tab={tab.id}
            aria-selected={tab.id === active}
            aria-controls="{id}-body"
            tabindex={tab.id === active ? 0 : -1}
            onpointerdown={(event) => onDragStart(tab.id, event)}
            onclick={() => onSelect(tab.id)}
            onkeydown={(event) => tabKey(event, index)}
          >{tab.title}</button>
          <!-- Delete on the tab closes it from the keyboard. -->
          <button type="button" class="close" tabindex="-1" aria-label="Close {tab.title}" title="Close" onclick={() => onClose(tab.id)}>
            <Icon name="close" size="0.875rem" />
          </button>
        </div>
      {/each}
    </div>
    <Button label={collapsed ? `Expand ${title}` : `Collapse ${title}`} title={collapsed ? 'Expand' : 'Collapse'} kind="ghost" size="compact" iconOnly onclick={() => onCollapse(!collapsed)}>
      <Icon name={collapsed ? 'expandMore' : 'expandLess'} />
    </Button>
  </header>
  {#if !collapsed}
    <div class="body" id="{id}-body" role="tabpanel" aria-labelledby="{id}-{active}">{@render children()}</div>
  {/if}
</section>

<style>
  .window {
    --caelestis-content-inset: 0.75rem;
    display: flex;
    flex-direction: column;
    inline-size: var(--studio-window-width, 18rem);
    min-block-size: 0;
    max-block-size: 100%;
    overflow: hidden;
  }
  /* The tabs, then empty header to drag the window by. */
  header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
    min-inline-size: 0;
    padding: 0.25rem;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .tabs {
    display: flex;
    flex: 1;
    gap: 0.125rem;
    min-inline-size: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tab {
    /* Square in pixel style, whose radius is 0; gently rounded in classic. */
    --tab-radius: min(var(--caelestis-radius, 0.4rem), 0.4rem);
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    border-radius: var(--tab-radius);
    color: var(--caelestis-muted-text);
  }
  .tab.active {
    background: var(--caelestis-raised-surface, oklch(0.92 0.01 264));
    box-shadow: inset 0 -2px var(--caelestis-primary, oklch(0.68 0.15 244));
    color: var(--caelestis-text);
  }
  .tab button {
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  [role='tab'] {
    padding: 0.3rem 0.125rem 0.3rem 0.5rem;
    font: 600 0.875rem/1.25 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: grab;
  }
  .close {
    display: grid;
    place-items: center;
    inline-size: 1.5rem;
    block-size: 1.5rem;
    padding: 0;
    border-radius: var(--tab-radius);
    opacity: 0.7;
  }
  .close:hover { opacity: 1; }
  .tab button:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: -2px; }
  @media (pointer: coarse) {
    .close { inline-size: 2.25rem; block-size: 2.25rem; }
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-block-size: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    padding: 0.75rem var(--caelestis-content-inset) var(--caelestis-content-inset);
    border-block-start: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
  }
</style>
