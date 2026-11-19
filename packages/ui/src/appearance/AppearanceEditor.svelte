<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { prefersReducedMotion } from '../foundations/motion.js'
  import SettingRow from '../foundations/SettingRow.svelte'
  import SectionHeader from '../foundations/SectionHeader.svelte'
  import SliderRow from '../foundations/SliderRow.svelte'
  import Toggle from '../foundations/Toggle.svelte'
  import Icon from '../foundations/Icon.svelte'
  import type { IconName } from '../foundations/icons.svelte.js'
  import type { Snippet } from 'svelte'
  import ColourInput from './ColourInput.svelte'
  import type {
    AppearanceEditorIntent,
    AppearanceEditorModel,
    AppearanceGroupKey,
    AppearanceNumberKey,
    AppearanceSliderModel,
  } from './model.js'

  let { model, onIntent }: { model: AppearanceEditorModel; onIntent?: (intent: AppearanceEditorIntent) => void } = $props()
  const emit = (intent: AppearanceEditorIntent): void => onIntent?.(intent)
  const format = (slider: AppearanceSliderModel): ((value: number) => string) => {
    switch (slider.format) {
      case 'percent': return (value) => `${Math.round(value * 100)}%`
      case 'degrees': return (value) => `${Math.round(value)}°`
      case 'pixels': return (value) => `${Math.round(value)}px`
      case 'decimal-pixels': return (value) => `${Number(value.toFixed(2))}px`
    }
  }
  const pickerChange = (open: boolean): void => emit({ type: 'picker', open })
  const sliderInput = (key: AppearanceNumberKey, value: number): void =>
    emit({ type: 'preview-number', key, value })
  const sliderCommit = (key: AppearanceNumberKey, value: number): void =>
    emit({ type: 'commit-number', key, value })
  const pixelSliders = $derived(model.sliders.filter((slider) => slider.group === 'pixels'))
  const markerSlider = (key: AppearanceNumberKey): AppearanceSliderModel | undefined =>
    model.sliders.find((slider) => slider.key === key)
  const group = (key: AppearanceGroupKey) => model.groups?.[key]
  const compact = $derived(model.variant === 'overlay')
  const groupDisabled = (key: AppearanceGroupKey): boolean =>
    model.disabled === true || group(key)?.owned === false
  // svelte-ignore state_referenced_locally -- group ownership chooses only the initial disclosure;
  // after that the user's expand/collapse action owns the local state.
  let expanded = $state<Record<AppearanceGroupKey, boolean>>({
    pixels: model.groups?.pixels.owned ?? true,
    markers: model.groups?.markers.owned ?? true,
    colours: model.groups?.colours.owned ?? true,
  })
  const toggleGroup = (key: AppearanceGroupKey): void => {
    expanded[key] = !expanded[key]
    // Without motion no transitionend follows, so the toggle itself is the settle.
    emit({ type: 'layout', settled: prefersReducedMotion() })
  }
  /** The accordion settled — the host re-measures the menu's final natural height. */
  const groupSettled = (event: TransitionEvent): void => {
    if (event.propertyName === 'grid-template-rows') emit({ type: 'layout', settled: true })
  }
</script>

<MenuStyles />

{#snippet section(key: AppearanceGroupKey, title: string, icon: IconName, body: Snippet)}
  <section>
    <SectionHeader {title} icon={compact ? undefined : icon} expanded={expanded[key]} onToggle={compact ? () => toggleGroup(key) : undefined}>
      {#snippet actions()}
        {#if group(key) !== undefined}
        <label class="defaults"><Toggle label={`Use default ${key}`} compact checked={!group(key)?.owned} disabled={model.disabled || group(key)?.locked === true} onChange={(checked) => emit({ type: 'set-group-owned', group: key, owned: !checked })} /> Use defaults</label>
        {/if}
      {/snippet}
    </SectionHeader>
    <div class="acc" data-open={String(expanded[key])}>
      <div class="acc-panel" inert={!expanded[key]} aria-hidden={!expanded[key]} ontransitionend={groupSettled}>
        <fieldset class="acc-inner" disabled={groupDisabled(key)}>{@render body()}</fieldset>
      </div>
    </div>
  </section>
{/snippet}

{#snippet nestedSlider(key: AppearanceNumberKey, depth: number)}
  {@const slider = markerSlider(key)}
  {#if slider !== undefined}
    <SliderRow {...slider} {compact} {depth} resettable={false} format={format(slider)} onInput={(value) => sliderInput(key, value)} onCommit={(value) => sliderCommit(key, value)} onReset={(value) => sliderCommit(key, value)} />
  {/if}
{/snippet}

{#snippet pixels()}
    <SettingRow label="Pixel style" {compact}>
      {#snippet children()}
        <div class="presets" role="group" aria-label="Pixel style">
          {#each model.pixelPresets as preset (preset.id)}
            <button class="pixel-preset caelestis-bevel" type="button" class:active={preset.active} disabled={preset.disabled} aria-pressed={preset.active} aria-label={preset.label} title={preset.label} onclick={() => emit({ type: 'pixel-preset', id: preset.id })}>
              <span class={`preset-icon ${preset.id}`} aria-hidden="true"></span>
            </button>
          {/each}
        </div>
      {/snippet}
    </SettingRow>
    <SettingRow label="Contrast outline" hint={compact ? undefined : 'Visible behind the overlay until Wplace art covers it'} {compact}>
      {#snippet children()}
        <Toggle label="Contrast outline" checked={model.values.contrastOutline} {compact} onChange={(value) => emit({ type: 'set-boolean', key: 'contrastOutline', value })} />
      {/snippet}
    </SettingRow>
    <div class="sliders">
      {#each pixelSliders as slider (slider.key)}
        <SliderRow {...slider} {compact} format={format(slider)} onInput={(value) => sliderInput(slider.key, value)} onCommit={(value) => sliderCommit(slider.key, value)} onReset={(value) => sliderCommit(slider.key, value)} />
      {/each}
    </div>
{/snippet}

{#snippet markers()}
    <div class="marker-settings">
    <SettingRow label="Mark mismatched pixels" {compact} depth={0}>
      {#snippet children()}
        <Toggle label="Mark mismatched pixels" checked={model.values.markMismatch} {compact} onChange={(value) => emit({ type: 'set-boolean', key: 'markMismatch', value })} />
      {/snippet}
    </SettingRow>
    <div class:disabled={!model.values.markMismatch} class="nested">
      {@render nestedSlider('markerSize', 1)}
      <SettingRow label="Colour" {compact} depth={1}>
        {#snippet children()}
          <ColourInput label="Marker colour" value={model.values.markerColour} disabled={!model.values.markMismatch} onPreview={(value) => emit({ type: 'preview-colour', key: 'markerColour', value })} onCommit={(value) => emit({ type: 'commit-colour', key: 'markerColour', value })} onOpenChange={pickerChange} />
        {/snippet}
      </SettingRow>
      <SettingRow label="Include unpainted pixels" {compact} depth={1}>
        {#snippet children()}
          <Toggle label="Include unpainted pixels" checked={model.values.markUnpainted} {compact} disabled={!model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'markUnpainted', value })} />
        {/snippet}
      </SettingRow>
      {@render nestedSlider('unpaintedLimit', 2)}
      <SettingRow label="Dim other colours" hint="While following the selected colour" {compact} depth={1}>
        {#snippet children()}
          <Toggle label="Dim other colours" checked={model.values.dimOthers} {compact} disabled={!model.values.markMismatch} onChange={(value) => emit({ type: 'set-boolean', key: 'dimOthers', value })} />
        {/snippet}
      </SettingRow>
      <div>
        {@render nestedSlider('otherOpacity', 2)}
        <SettingRow label="Marked in" {compact} depth={2}>
          {#snippet children()}
            <div class="same-colour">
              <ColourInput label="Colour for other colours" value={model.values.otherColour ?? model.values.markerColour} disabled={!model.values.markMismatch || !model.values.dimOthers} onPreview={(value) => emit({ type: 'preview-colour', key: 'otherColour', value })} onCommit={(value) => emit({ type: 'commit-colour', key: 'otherColour', value })} onOpenChange={pickerChange} />
              <button class="choice caelestis-bevel" type="button" class:active={model.values.otherColour === null} aria-pressed={model.values.otherColour === null} disabled={!model.values.markMismatch || !model.values.dimOthers} onclick={() => emit({ type: 'set-colour', key: 'otherColour', value: null })}>Same</button>
            </div>
          {/snippet}
        </SettingRow>
      </div>
    </div>

    <SettingRow label="Mark selected colour pixels" hint="Follows the colour selected in Wplace" {compact} depth={0}>
      {#snippet children()}
        <Toggle label="Mark selected colour pixels" checked={model.values.markSelectedColour} {compact} onChange={(value) => emit({ type: 'set-boolean', key: 'markSelectedColour', value })} />
      {/snippet}
    </SettingRow>
    <div class:disabled={!model.values.markSelectedColour} class="nested">
      {@render nestedSlider('selectedMarkerSize', 1)}
      <SettingRow label="Colour" {compact} depth={1}>
        {#snippet children()}
          <ColourInput label="Selected colour marker colour" value={model.values.selectedMarkerColour} disabled={!model.values.markSelectedColour} onPreview={(value) => emit({ type: 'preview-colour', key: 'selectedMarkerColour', value })} onCommit={(value) => emit({ type: 'commit-colour', key: 'selectedMarkerColour', value })} onOpenChange={pickerChange} />
        {/snippet}
      </SettingRow>
    </div>
    </div>

    {#if model.markerBudget !== undefined && model.markerBudgetOptions !== undefined}
      <SettingRow label="Visible marker limit" hint="Approximate GPU target per marker kind across the viewport" {compact}>
        {#snippet children()}
          <select class="caelestis-select" aria-label="Visible marker limit" value={model.markerBudget} onchange={(event) => emit({ type: 'marker-budget', value: Number(event.currentTarget.value) })}>
            {#each model.markerBudgetOptions as value}<option {value}>{value.toLocaleString()}</option>{/each}
          </select>
        {/snippet}
      </SettingRow>
    {/if}
{/snippet}

{#snippet colours()}
    <div class="colour-toolbar">
      <div class="presets" role="group" aria-label="Colour presets">
        {#each model.colourPresets as preset (preset.id)}
          <button class="choice caelestis-bevel" type="button" class:active={preset.active} disabled={preset.disabled} aria-pressed={preset.active} onclick={() => emit({ type: 'colour-preset', id: preset.id })}>{preset.label}</button>
        {/each}
      </div>
      {#if model.showOnlySelectedColour !== false}
        <button class="choice only-selected caelestis-bevel" type="button" class:active={model.onlySelectedColour} aria-label="Highlight the selected colour" aria-pressed={model.onlySelectedColour} title={model.paintOpen ? 'Highlight the selected colour' : 'Open Wplace’s paint drawer to pick a colour'} onclick={() => emit({ type: 'only-selected-colour', value: !model.onlySelectedColour })}>
          <Icon name="palette" size="1rem" />
        </button>
      {/if}
    </div>
    <div class="swatches">
      <div class="palette" role="group" aria-label="Visible colours">
        {#each model.palette as colour (colour.index)}
          <button type="button" class="palette-swatch" data-on={colour.visible} style:background={colour.hex} aria-label={`${colour.name}, ${colour.kind}`} aria-pressed={colour.visible} aria-disabled={model.disabled} title={`${colour.name} · ${colour.kind}`} onclick={() => { if (!model.disabled) emit({ type: 'toggle-colour', index: colour.index, visible: !colour.visible }) }}>
            <span class="swatch-badge" aria-hidden="true"><span><Icon name={colour.visible ? 'eye' : 'eyeOff'} size="78%" /></span></span>
          </button>
        {/each}
      </div>
    </div>
{/snippet}

<div class:compact class="editor">
  {@render section('pixels', compact ? 'Pixels' : 'Appearance', 'tune', pixels)}
  {#if model.showMarkers !== false}{@render section('markers', 'Markers', 'search', markers)}{/if}
  {@render section('colours', 'Colours', 'palette', colours)}
</div>

<style>
  .editor { flex: 1; min-block-size: 0; overflow-y: auto; padding-block-end: 0.75rem; color: var(--caelestis-text); font: 400 0.875rem/1.3 var(--caelestis-font); }
  .editor.compact { padding: 0; font-size: 0.75rem; }
  .editor:not(.compact) > section { max-inline-size: 48rem; margin-inline: auto; }
  .defaults { display: flex; align-items: center; gap: 0.5rem; color: var(--caelestis-muted-text); font-size: 0.75rem; font-weight: 400; white-space: nowrap; }
  fieldset { min-inline-size: 0; margin: 0; padding: 0; border: 0; }
  fieldset:disabled { opacity: 0.7; pointer-events: none; }
  /* Compact groups accord in and out of their header (transitions.dev 21): grid rows carry the
     height, the inner wrapper clips and fades. Non-compact never toggles, so this is scoped. */
  .compact .acc-panel { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out); }
  .compact .acc[data-open='true'] .acc-panel { grid-template-rows: 1fr; transition-duration: var(--caelestis-duration-fast); }
  .compact .acc-inner { overflow: hidden; min-block-size: 0; opacity: 0; filter: blur(var(--caelestis-blur-small)); transition: opacity var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out), filter var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out); }
  .compact .acc[data-open='true'] .acc-inner { opacity: 1; filter: none; transition-duration: var(--caelestis-duration-fast); }
  @media (prefers-reduced-motion: reduce) {
    .acc-panel, .acc-inner { transition: none !important; }
  }
  .sliders, .marker-settings { padding-inline: var(--caelestis-content-inset, 1rem); }
  .sliders { display: grid; grid-template-columns: minmax(0, max-content) minmax(0, 1fr); column-gap: 0.75rem; }
  .sliders :global(label) { grid-column: 1 / -1; grid-template-columns: subgrid; }
  .compact .sliders { column-gap: 0.5rem; }
  .compact .sliders, .compact .marker-settings { padding-inline: 0.25rem; }
  .disabled { opacity: 0.45; }
  .presets, .same-colour, .colour-toolbar { display: flex; align-items: center; gap: 0.25rem; }
  .pixel-preset, .choice { --button-colour: var(--caelestis-raised-surface); display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; border: var(--caelestis-border-width) solid color-mix(in oklab, var(--button-colour), #000 calc(var(--caelestis-depth) * 5%)); outline-color: var(--button-colour); background: var(--button-colour); color: var(--caelestis-text); box-shadow: 0 0.5px 0 0.5px oklch(100% 0 0 / calc(var(--caelestis-depth) * 6%)) inset, 0 3px 2px -2px color-mix(in oklab, var(--button-colour) calc(var(--caelestis-depth) * 30%), transparent); font: 600 0.75rem/1 var(--caelestis-font); cursor: pointer; }
  .pixel-preset { inline-size: 2rem; block-size: 2rem; padding: 0; border-radius: var(--caelestis-pill-radius); }
  .choice { block-size: 1.5rem; padding-inline: 0.5rem; border-radius: var(--caelestis-radius); font-size: 0.6875rem; }
  .only-selected { inline-size: 1.5rem; padding-inline: 0; }
  .pixel-preset.active { --button-colour: color-mix(in oklab, var(--caelestis-raised-surface) 95%, #000); box-shadow: none; }
  .choice.active { --button-colour: var(--caelestis-primary); color: var(--caelestis-primary-content); box-shadow: none; }
  @media (hover: hover) { .pixel-preset:hover, .choice:hover { --button-colour: color-mix(in oklab, var(--button-colour), #000 7%); } }
  .preset-icon { display: block; position: relative; inline-size: 1rem; block-size: 1rem; box-sizing: border-box; overflow: hidden; border: 1.5px solid currentColor; }
  .preset-icon.small::after { content: ''; position: absolute; display: block; inset: 0.21875rem; background: currentColor; }
  .preset-icon.full { background: currentColor; }
  .preset-icon.corner { background: currentColor; clip-path: polygon(0 0, 100% 0, 0 100%); }
  .colour-toolbar { flex-wrap: wrap; justify-content: space-between; padding: 0 var(--caelestis-content-inset, 1rem) 0.5rem; }
  .compact .colour-toolbar { padding-inline: 0; }
  .swatches { container-type: inline-size; padding: 0 var(--caelestis-content-inset, 1rem); }
  .compact .swatches { padding-inline: 0; }
  .palette { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
  @container (min-width: 17.5rem) { .palette { grid-template-columns: repeat(8, 1fr); } }
  @container (min-width: 35.5rem) { .palette { grid-template-columns: repeat(16, 1fr); } }
  @container (min-width: 71.5rem) { .palette { grid-template-columns: repeat(32, 1fr); } }
  .palette-swatch { position: relative; min-inline-size: 1.5rem; aspect-ratio: 1; padding: 0; border: 1px solid rgb(0 0 0 / 0.25); border-radius: var(--caelestis-pill-radius); outline: 2px solid transparent; outline-offset: 1px; opacity: 0.7; cursor: pointer; transition: opacity 100ms ease-out, outline-color 100ms ease-out; }
  .palette-swatch[data-on='true'] { outline-color: var(--caelestis-text); opacity: 1; }
  .palette-swatch[data-on='false']::after { content: ''; position: absolute; inset-inline-start: 15%; inset-block-start: calc(50% - 1px); inline-size: 70%; block-size: 2px; border-radius: var(--caelestis-pill-radius); background: currentColor; box-shadow: 0 0 0 1px var(--caelestis-surface); transform: rotate(-45deg); pointer-events: none; }
  .swatch-badge { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 80ms ease-out; pointer-events: none; }
  .palette-swatch:hover .swatch-badge, .palette-swatch:focus-visible .swatch-badge { opacity: 1; }
  .swatch-badge > span { display: flex; align-items: center; justify-content: center; inline-size: 72%; block-size: 72%; border-radius: var(--caelestis-pill-radius); box-sizing: border-box; }
  .palette-swatch[data-on='true'] .swatch-badge > span { background: var(--caelestis-text); color: var(--caelestis-surface); }
  .palette-swatch[data-on='false'] .swatch-badge > span { border: 1.5px solid var(--caelestis-text); background: var(--caelestis-surface); color: var(--caelestis-text); }

  button:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  button:disabled, button[aria-disabled='true'] { pointer-events: none; cursor: not-allowed; opacity: 0.3; }
  @media (forced-colors: active) { .palette-swatch[data-on='true'] { outline: 3px solid CanvasText; } }
</style>
