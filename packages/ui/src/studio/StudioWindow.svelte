<script lang="ts">
  import type { Snippet } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'

  /**
   * One studio tool window: a title bar that drags it, collapse and close buttons, and its
   * controls. The studio owns where it sits; this only draws the frame.
   */
  interface Props {
    title: string
    collapsed: boolean
    dragging?: boolean
    onDragStart: (event: PointerEvent) => void
    onCollapse: (collapsed: boolean) => void
    onClose: () => void
    children: Snippet
  }
  let { title, collapsed, dragging = false, onDragStart, onCollapse, onClose, children }: Props = $props()

  const id = $props.id()
</script>

<section class="window caelestis-panel-surface" class:dragging aria-labelledby="{id}-title">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header onpointerdown={(event) => { if ((event.target as Element).closest('button') === null) onDragStart(event) }}>
    <h3 id="{id}-title">{title}</h3>
    <Button label={collapsed ? `Expand ${title}` : `Collapse ${title}`} title={collapsed ? 'Expand' : 'Collapse'} kind="ghost" size="compact" iconOnly onclick={() => onCollapse(!collapsed)}>
      <Icon name={collapsed ? 'expandMore' : 'expandLess'} />
    </Button>
    <Button label="Close {title}" title="Close" kind="ghost" size="compact" iconOnly onclick={onClose}>
      <Icon name="close" />
    </Button>
  </header>
  {#if !collapsed}
    <div class="body">{@render children()}</div>
  {/if}
</section>

<style>
  .window {
    --caelestis-content-inset: 0.75rem;
    display: flex;
    flex-direction: column;
    inline-size: var(--studio-window-width, 18rem);
    max-block-size: 100%;
    min-block-size: 0;
    overflow: hidden;
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius, calc(0.7rem + 1px));
    background: var(--caelestis-surface, oklch(0.97 0.01 264));
    color: var(--caelestis-text, oklch(0.26 0.025 264));
    box-shadow: var(--caelestis-popover-shadow, 0 10px 24px -6px rgb(0 0 0 / 0.28));
    pointer-events: auto;
  }
  .window.dragging { box-shadow: var(--caelestis-shadow, 0 24px 80px rgb(0 0 0 / 0.35)); }
  header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.125rem;
    padding: 0.25rem 0.25rem 0.25rem 0.75rem;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .window.dragging header { cursor: grabbing; }
  h3 { flex: 1; margin: 0; font: 600 0.8125rem/1.25 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif); }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-block-size: 0;
    overflow: auto;
    padding: 0.25rem var(--caelestis-content-inset) var(--caelestis-content-inset);
    border-block-start: 1px solid var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
    padding-block-start: 0.75rem;
  }
</style>
