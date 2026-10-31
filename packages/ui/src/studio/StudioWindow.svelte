<script lang="ts">
  import type { Snippet } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { StudioWindowId } from './model.js'

  /**
   * One place in a studio frame: its panels as tabs, or one panel's title, collapse and close
   * buttons, and the panel in front. Dragging a tab or the title moves that panel; the studio
   * owns where it lands.
   */
  interface Props {
    tabs: readonly { readonly id: StudioWindowId; readonly title: string }[]
    active: StudioWindowId
    collapsed: boolean
    onSelect: (id: StudioWindowId) => void
    onDragStart: (id: StudioWindowId, event: PointerEvent) => void
    onCollapse: (collapsed: boolean) => void
    onClose: () => void
    children: Snippet
  }
  let { tabs, active, collapsed, onSelect, onDragStart, onCollapse, onClose, children }: Props = $props()

  const id = $props.id()
  const title = $derived(tabs.find((tab) => tab.id === active)?.title ?? '')
  const grouped = $derived(tabs.length > 1)

  /** Arrow keys move between tabs, as a tab list does. */
  const tabKey = (event: KeyboardEvent, index: number): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]
    if (next === undefined) return
    onSelect(next.id)
    ;(event.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus()
  }
</script>

<section class="window" aria-labelledby="{id}-{active}">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={(event) => { if ((event.target as Element).closest('button') === null) onDragStart(active, event) }}>
    {#if grouped}
      <div class="tabs" role="tablist">
        {#each tabs as tab, index (tab.id)}
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
        {/each}
      </div>
    {:else}
      <h3 id="{id}-{active}">{title}</h3>
    {/if}
    <Button label={collapsed ? `Expand ${title}` : `Collapse ${title}`} title={collapsed ? 'Expand' : 'Collapse'} kind="ghost" size="compact" iconOnly onclick={() => onCollapse(!collapsed)}>
      <Icon name={collapsed ? 'expandMore' : 'expandLess'} />
    </Button>
    <Button label="Close {title}" title="Close" kind="ghost" size="compact" iconOnly onclick={onClose}>
      <Icon name="close" />
    </Button>
  </header>
  {#if !collapsed}
    <div class="body" id="{id}-body" role={grouped ? 'tabpanel' : undefined}>{@render children()}</div>
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
  header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.125rem;
    min-inline-size: 0;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  h3 { flex: 1; margin: 0; font: 600 0.8125rem/1.25 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif); }
  .tabs {
    display: flex;
    flex: 1;
    gap: 0.125rem;
    min-inline-size: 0;
    margin-inline-start: -0.5rem;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs button {
    flex: 0 0 auto;
    padding: 0.3rem 0.5rem;
    border: 0;
    border-radius: var(--caelestis-control-radius, 0.4rem);
    background: none;
    color: var(--caelestis-muted-text);
    font: 600 0.8125rem/1.25 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: grab;
  }
  .tabs button[aria-selected='true'] {
    background: var(--caelestis-raised-surface, oklch(0.92 0.01 264));
    color: var(--caelestis-text);
  }
  .tabs button:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: -2px; }
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
