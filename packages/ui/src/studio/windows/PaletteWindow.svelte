<script lang="ts">
  import Icon from '../../foundations/Icon.svelte'
  import type { StudioPaletteScope, TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import Segmented from '../effects/Segmented.svelte'

  /** The Wplace colours the template may use, as Ditherette web's palette without custom palettes. */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const SCOPES: readonly { id: StudioPaletteScope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'free', label: 'Free' },
    { id: 'premium', label: 'Premium' },
    { id: 'owned', label: 'Owned' },
  ]
  const selected = $derived(model.palette.colours.filter((colour) => colour.selected))
  const used = $derived(model.palette.colours.filter((colour) => colour.pixels > 0).length)
</script>

<fieldset disabled={model.pending}>
  <Segmented
    label="Colour presets"
    value={model.palette.scope}
    options={SCOPES.map((scope) =>
      scope.id === 'owned' && !model.palette.ownedKnown
        ? { ...scope, disabled: true, title: 'Log in to Wplace to use your colours' }
        : scope,
    )}
    onChange={(scope) => onIntent({ type: 'scope', scope })}
  />
  <div class="swatches" role="group" aria-label="Colours the template uses">
    {#each model.palette.colours as colour (colour.index)}
      {@const detail = colour.pixels > 0 ? `${colour.pixels.toLocaleString()} px` : colour.selected ? 'unused' : 'off'}
      <button
        type="button"
        class="swatch"
        data-on={colour.selected}
        style:background={colour.hex}
        aria-label="{colour.name}, {colour.kind}, {detail}"
        aria-pressed={colour.selected}
        title="{colour.name} · {colour.kind} · {detail}"
        disabled={colour.selected && selected.length === 1}
        onclick={() => onIntent({ type: 'colour', index: colour.index, selected: !colour.selected })}
      >
        <span class="badge" aria-hidden="true"><span><Icon name={colour.selected ? 'eye' : 'eyeOff'} size="78%" /></span></span>
      </button>
    {/each}
  </div>
  <p class="hint summary">{selected.length} of {model.palette.colours.length} colours{#if model.source !== null}, {used} in use{/if}</p>

</fieldset>

<style>
  fieldset { display: contents; }
  .swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: 0.4rem; }
  .swatch {
    position: relative;
    min-inline-size: 1.25rem;
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid rgb(0 0 0 / 0.25);
    border-radius: var(--caelestis-pill-radius, var(--caelestis-radius, calc(0.7rem + 1px)));
    outline: 2px solid transparent;
    outline-offset: 1px;
    opacity: 0.55;
    cursor: pointer;
    transition: opacity 100ms ease-out, outline-color 100ms ease-out;
  }
  .swatch[data-on='true'] { outline-color: var(--caelestis-text); opacity: 1; }
  .swatch[data-on='false']::after {
    content: '';
    position: absolute;
    inset-inline-start: 15%;
    inset-block-start: calc(50% - 1px);
    inline-size: 70%;
    block-size: 2px;
    border-radius: var(--caelestis-pill-radius, 999px);
    background: currentColor;
    box-shadow: 0 0 0 1px var(--caelestis-surface, white);
    transform: rotate(-45deg);
    pointer-events: none;
  }
  .swatch:focus-visible { outline-color: var(--caelestis-focus, currentColor); }
  .badge { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 80ms ease-out; pointer-events: none; }
  .swatch:hover .badge, .swatch:focus-visible .badge { opacity: 1; }
  .badge > span { display: flex; align-items: center; justify-content: center; inline-size: 72%; block-size: 72%; border-radius: var(--caelestis-pill-radius, 999px); box-sizing: border-box; }
  .swatch[data-on='true'] .badge > span { background: var(--caelestis-text); color: var(--caelestis-surface); }
  .swatch[data-on='false'] .badge > span { border: 1.5px solid var(--caelestis-text); background: var(--caelestis-surface); color: var(--caelestis-text); }
  .summary { font-variant-numeric: tabular-nums; }
  @media (forced-colors: active) { .swatch[data-on='true'] { outline: 3px solid CanvasText; } }
</style>
