<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import { selectFace } from '../../foundations/select-face.js'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import {
    DITHER_ALGORITHMS,
    type DitherFamily,
    type DitherId,
    type DitherPlacement,
    PLACEMENT_MODES,
  } from '../options.js'
  import MoreOptions from '../MoreOptions.svelte'
  import RangeField from '../RangeField.svelte'
  import SwitchRow from '../SwitchRow.svelte'

  /**
   * Ditherette web's Dither panel, with a plain algorithm menu and its strength up front; where
   * it dithers and how fall under More options.
   */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const GROUPS: readonly { family: Exclude<DitherFamily, 'none'>; label: string }[] = [
    { family: 'ordered', label: 'Ordered' },
    { family: 'error-diffusion', label: 'Error diffusion' },
    { family: 'noise', label: 'Noise' },
    { family: 'mixing', label: 'Two-colour mixing' },
  ]
  const SAMPLE_SIZE_MIN = 4
  const SAMPLE_SIZE_MAX = 100
  const id = $props.id()

  const dither = $derived(model.dither)
  const current = $derived(DITHER_ALGORITHMS.find((option) => option.id === dither.algorithm) ?? DITHER_ALGORITHMS[0])
  const none = $derived(current.family === 'none')
  const mixing = $derived(current.family === 'mixing')
  const adaptive = $derived(!none && dither.placement === 'adaptive')
  const set = (patch: Partial<TemplateStudioModel['dither']>): void => onIntent({ type: 'dither', dither: patch })
  const seedLabel = $derived(`0x${dither.seed.toString(16).padStart(8, '0').toUpperCase()}`)
</script>

<MenuStyles />

<fieldset disabled={model.pending}>
  <div class="field-row">
    <label class="field-label" for="{id}-algorithm">Algorithm</label>
    <select
      id="{id}-algorithm"
      class="caelestis-select"
      {@attach selectFace}
      value={dither.algorithm}
      onchange={(event) => set({ algorithm: event.currentTarget.value as DitherId })}
    >
      <option value="none">None</option>
      {#each GROUPS as group (group.family)}
        <optgroup label={group.label}>
          {#each DITHER_ALGORITHMS.filter((option) => option.family === group.family) as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </optgroup>
      {/each}
    </select>
  </div>
  <p class="hint">{current.description}</p>

  <!-- Each control shows only for the algorithms it changes. -->
  {#if !none && !mixing}
    <RangeField
      label="Strength"
      value={dither.strength}
      min={0}
      max={100}
      step={1}
      unit="%"
      onChange={(strength) => set({ strength: Math.round(strength) })}
    />
  {/if}

  {#if !none}
    <MoreOptions name="dither">
    <div class="field-row">
      <label class="field-label" for="{id}-placement">Placement</label>
      <select
        id="{id}-placement"
        class="caelestis-select"
        {@attach selectFace}
        value={dither.placement}
        onchange={(event) => set({ placement: event.currentTarget.value as DitherPlacement })}
      >
        {#each PLACEMENT_MODES as mode (mode.id)}
          <option value={mode.id}>{mode.label}</option>
        {/each}
      </select>
    </div>
  {#if adaptive}
    <RangeField
      label="Sample size"
      value={dither.placementSampleSize}
      min={SAMPLE_SIZE_MIN}
      max={SAMPLE_SIZE_MAX}
      step={1}
      unit="px"
      onChange={(size) => set({ placementSampleSize: Math.round(size) })}
    />
    <RangeField
      label="Tolerance"
      value={dither.placementContrastThreshold}
      min={0}
      max={100}
      step={1}
      unit="%"
      onChange={(threshold) => set({ placementContrastThreshold: Math.round(threshold) })}
    />
  {/if}

  {#if !mixing}
    <SwitchRow
      label="Dither in matching space"
      hint="Spread error in the colour space Colours matches in, rather than in plain RGB."
      checked={dither.useColorSpace}
      onChange={(useColorSpace) => set({ useColorSpace })}
    />
    {#if current.family === 'error-diffusion'}
      <SwitchRow label="Serpentine scan" hint="Reduces directional bias." checked={dither.serpentine} onChange={(serpentine) => set({ serpentine })} />
    {/if}
  {/if}

  {#if dither.algorithm === 'random'}
    <div class="field-row">
      <span class="field-label">Seed</span>
      <span class="seed">{seedLabel}</span>
    </div>
    <div class="row-actions">
      <Button label="Randomise" size="small" onclick={() => set({ seed: crypto.getRandomValues(new Uint32Array(1))[0] ?? 0 })} />
    </div>
  {/if}
    </MoreOptions>
  {/if}
</fieldset>

<style>
  fieldset { display: contents; }
  .seed { font: 0.75rem/1.4 var(--caelestis-mono-font, ui-monospace, monospace); }
</style>
