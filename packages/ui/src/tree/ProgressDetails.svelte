<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { type ColourProgress as Colour, formatCount, formatPixels, type Progress } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import ColourProgress from '../progress/ColourProgress.svelte'
  import { COLOUR_PROGRESS_SORTS, type ColourProgressSort } from '../progress/colour-sorts.js'
  import ProgressMeter from '../progress/ProgressMeter.svelte'

  let { name, progress, colours = [], onClose }: {
    name: string
    progress: Progress
    colours?: readonly Colour[] | undefined
    onClose: () => void
  } = $props()

  let sort = $state<ColourProgressSort>('index')
</script>

<MenuStyles />

<aside aria-label={`Progress for ${name}`}>
  <header>
    <div><h3>{name}</h3><p>{formatPixels(progress.total)} total</p></div>
    <Button label="Close progress" title="Close progress" kind="ghost" size="compact" iconOnly onclick={onClose}><Icon name="close" /></Button>
  </header>
  <div class="summary">
    <ProgressMeter {progress} />
    <dl>
      <dt class="completed">Complete</dt><dd title={formatPixels(progress.completed)}>{formatCount(progress.completed)}</dd>
      <dt class="mismatched">Mismatched</dt><dd title={formatPixels(progress.mismatched)}>{formatCount(progress.mismatched)}</dd>
      <dt class="unpainted">Unpainted</dt><dd title={formatPixels(progress.unpainted)}>{formatCount(progress.unpainted)}</dd>
      {#if progress.known < progress.total}
        <dt class="unscanned">Not scanned</dt><dd title={formatPixels(progress.total - progress.known)}>{formatCount(progress.total - progress.known)}</dd>
      {/if}
    </dl>
  </div>
  {#if colours.length > 0}
    <div class="colour-toolbar">
      <h4>Colours <span>{colours.length}</span></h4>
      <select class="caelestis-select" aria-label="Sort colours" bind:value={sort}>
        {#each COLOUR_PROGRESS_SORTS as option (option.key)}<option value={option.key}>{option.label}</option>{/each}
      </select>
    </div>
    <div class="colours"><ColourProgress {colours} {sort} /></div>
  {/if}
</aside>

<style>
  aside { display: flex; flex-direction: column; block-size: 100%; min-block-size: 0; overflow-y: auto; overscroll-behavior: contain; color: var(--caelestis-text); font: 400 0.75rem/1.4 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif); }
  header { display: flex; flex: 0 0 auto; align-items: flex-start; gap: 0.75rem; padding: 1rem; }
  header > div { flex: 1; min-inline-size: 0; }
  h3 { margin: 0; overflow-wrap: anywhere; font-size: 0.875rem; font-weight: 600; }
  p { margin: 0.25rem 0 0; color: var(--caelestis-muted-text); }
  .summary { flex: 0 0 auto; padding: 0 1rem 1rem; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem 1rem; margin: 1rem 0 0; }
  dt { display: flex; align-items: center; gap: 0.5rem; }
  dt::before { content: ''; inline-size: 0.5rem; block-size: 0.5rem; border-radius: 50%; background: var(--caelestis-muted-text); }
  .completed::before { background: var(--caelestis-success); }
  .mismatched::before { background: var(--caelestis-danger); }
  .unpainted::before { opacity: 0.4; }
  .unscanned::before { background: transparent; border: 1px dashed var(--caelestis-muted-text); }
  dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
  .colour-toolbar { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.5rem 1rem; border-block: 1px solid var(--caelestis-border); }
  h4 { display: flex; gap: 0.375rem; margin: 0; font-size: inherit; font-weight: 600; }
  h4 span { color: var(--caelestis-muted-text); font-weight: 400; }
  select { max-inline-size: 11rem; }
  .colours { flex: 1; min-block-size: 6rem; padding: 0.625rem 1rem; overflow-y: auto; overscroll-behavior: contain; }
</style>
