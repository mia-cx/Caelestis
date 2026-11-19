<script lang="ts">
  import Icon from '../foundations/Icon.svelte'
  import FilterMenu from './FilterMenu.svelte'
  import SortMenu from './SortMenu.svelte'
  import type { TemplateTreeIntent, TemplateTreeModel } from './model.js'

  /** Search, filters, sort, and the tree/grid switch above the template list. */
  let { model, emit }: { model: TemplateTreeModel; emit: (intent: TemplateTreeIntent) => void } = $props()

  const SEARCH_DEBOUNCE_MS = 100
  let query = $state('')
  let admittedQuery = ''
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  const grid = $derived(model.displayMode === 'grid')

  // The field keeps what was typed until the host reports a different query.
  $effect(() => {
    if (model.query === admittedQuery) return
    admittedQuery = model.query
    query = model.query
  })
  $effect(() => () => clearTimeout(searchTimer))

  const search = (event: Event & { currentTarget: HTMLInputElement }): void => {
    query = event.currentTarget.value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => emit({ type: 'search', query }), SEARCH_DEBOUNCE_MS)
  }
</script>

<div class="toolbar">
  <label class="search caelestis-field caelestis-field-look">
    <Icon name="search" />
    <input type="search" placeholder="Search templates" aria-label="Search templates" value={query} oninput={search} />
  </label>
  {#if model.filters !== undefined}
    <FilterMenu filters={model.filters} serverFiltersAvailable={model.serverFiltersAvailable ?? false} tagOptions={model.tagOptions} onFilter={(filters) => emit({ type: 'filter', filters })} />
  {/if}
  <SortMenu sort={model.sort} onSort={(sort) => emit({ type: 'sort', sort })} />
  {#if model.displayMode !== undefined}
    <div class="view-switcher" role="group" aria-label="Template display">
      <button type="button" aria-label="Tree view" title="Tree view" aria-pressed={!grid} onclick={() => emit({ type: 'display-mode', mode: 'tree' })}>
        <Icon name="treeView" />
      </button>
      <button type="button" aria-label="Preview grid view" title="Preview grid view" aria-pressed={grid} onclick={() => emit({ type: 'display-mode', mode: 'grid' })}>
        <Icon name="gridView" />
      </button>
    </div>
  {/if}
</div>

<style>
  .toolbar { position: relative; z-index: 2; display: flex; flex: 0 0 auto; align-items: center; gap: 0.25rem; margin: 0.75rem var(--caelestis-content-inset, 1rem); }
  .view-switcher { display: flex; flex: 0 0 auto; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius); overflow: hidden; }
  .view-switcher button { display: grid; place-items: center; inline-size: 2rem; block-size: 2rem; border: 0; background: var(--caelestis-surface); color: var(--caelestis-muted-text); cursor: pointer; }
  .view-switcher button[aria-pressed='true'] { background: var(--caelestis-raised-surface); color: var(--caelestis-primary); box-shadow: inset 0 -2px var(--caelestis-primary); }
  .view-switcher button:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .search { display: flex; flex: 1; align-items: center; gap: 0.5rem; min-inline-size: 0; block-size: 2rem; padding-inline: 0.75rem; }
  .search :global(svg) { opacity: 0.55; }
  .search input { flex: 1; min-inline-size: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
</style>
