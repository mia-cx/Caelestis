<script lang="ts" module>
  /** Which windows show their options, for this page's life, so a window moved or re-tabbed keeps its own. */
  const shown = $state<Record<string, boolean>>({})
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from '../foundations/Icon.svelte'

  /** A window's less common settings, folded away under one button until asked for. */
  let { name, children }: { name: string; children: Snippet } = $props()

  const id = $props.id()
  const open = $derived(shown[name] === true)
</script>

<button type="button" class="more" aria-expanded={open} aria-controls="{id}-more" onclick={() => (shown[name] = !open)}>
  <Icon name={open ? 'expandLess' : 'expandMore'} size="1rem" />
  {open ? 'Fewer options' : 'More options'}
</button>
{#if open}
  <div class="options" id="{id}-more">{@render children()}</div>
{/if}

<style>
  .more {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    align-self: flex-start;
    min-block-size: 2rem;
    margin-inline-start: -0.25rem;
    padding: 0 0.375rem;
    border: 0;
    border-radius: var(--caelestis-radius, 0.4rem);
    background: none;
    color: var(--caelestis-muted-text);
    font: inherit;
    cursor: pointer;
  }
  .more:hover { color: var(--caelestis-text); }
  .more:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 0; }
  .options { display: flex; flex-direction: column; gap: 0.5rem; }
</style>
