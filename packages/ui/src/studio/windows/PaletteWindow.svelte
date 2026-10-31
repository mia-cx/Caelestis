<script lang="ts">
  import Icon from '../../foundations/Icon.svelte'
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import type { StudioPaletteScope, TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import { ALPHA_MODES, type AlphaMode } from '../options.js'
  import RangeField from '../RangeField.svelte'

  /**
   * The Wplace colours the template may use, as Ditherette web's palette without custom palettes,
   * and how source transparency becomes palette pixels.
   */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const SCOPES: readonly { id: StudioPaletteScope; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'free', label: 'Free' },
    { id: 'premium', label: 'Premium' },
    { id: 'owned', label: 'Owned' },
  ]
  const id = $props.id()

  const selected = $derived(model.palette.colours.filter((colour) => colour.selected))
  const used = $derived(model.palette.colours.filter((colour) => colour.pixels > 0).length)
</script>

<MenuStyles />

<fieldset disabled={model.pending}>
  <div class="scopes" role="group" aria-label="Colour presets">
    {#each SCOPES as scope (scope.id)}
      <button
        type="button"
        class="choice caelestis-bevel"
        class:active={model.palette.scope === scope.id}
        aria-pressed={model.palette.scope === scope.id}
        disabled={scope.id === 'owned' && !model.palette.ownedKnown}
        title={scope.id === 'owned' && !model.palette.ownedKnown ? 'Log in to Wplace to use your colours' : undefined}
        onclick={() => onIntent({ type: 'scope', scope: scope.id })}
      >{scope.label}</button>
    {/each}
  </div>
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
  <p class="hint summary">{selected.length} of {model.palette.colours.length} colours on{#if model.source !== null} · {used} used{/if}</p>

  <p class="field-label section">Transparency</p>
  <div class="field-row">
    <label class="field-label" for="{id}-alpha">Alpha</label>
    <select
      id="{id}-alpha"
      class="caelestis-select"
      value={model.alpha.mode}
      onchange={(event) => onIntent({ type: 'alpha', alpha: { mode: event.currentTarget.value as AlphaMode } })}
    >
      {#each ALPHA_MODES as mode (mode.id)}
        <option value={mode.id}>{mode.label}</option>
      {/each}
    </select>
  </div>
  {#if model.alpha.mode === 'preserve'}
    <RangeField
      label="Threshold"
      value={model.alpha.threshold}
      min={0}
      max={255}
      step={1}
      onChange={(threshold) => onIntent({ type: 'alpha', alpha: { threshold } })}
    />
  {:else if model.alpha.mode === 'matte'}
    <div class="field-row">
      <label class="field-label" for="{id}-matte">Matte</label>
      <select
        id="{id}-matte"
        class="caelestis-select"
        value={model.alpha.matte}
        onchange={(event) => onIntent({ type: 'alpha', alpha: { matte: Number(event.currentTarget.value) } })}
      >
        {#each selected as colour (colour.index)}
          <option value={colour.index}>{colour.name}</option>
        {/each}
      </select>
    </div>
  {/if}
</fieldset>

<style>
  fieldset { display: contents; }
  .scopes { display: flex; flex-wrap: wrap; gap: 0.25rem; }
  .choice {
    --button-colour: var(--caelestis-raised-surface, var(--color-base-200));
    display: inline-flex;
    align-items: center;
    padding: 0.4rem 0.6rem;
    border: var(--border, 1px) solid color-mix(in oklab, var(--button-colour), #000 calc(var(--depth, 1) * 5%));
    border-radius: var(--caelestis-pill-radius, 999px);
    background: var(--button-colour);
    color: var(--caelestis-text);
    font: 600 0.75rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  .choice.active { --button-colour: var(--caelestis-primary, oklch(0.68 0.15 244)); color: white; }
  .choice:disabled { opacity: 0.5; cursor: not-allowed; }
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
  .section { margin-block-start: 0.5rem; }
  @media (forced-colors: active) { .swatch[data-on='true'] { outline: 3px solid CanvasText; } }
</style>
