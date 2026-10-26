<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import SettingRow from '../../foundations/SettingRow.svelte'
  import Toggle from '../../foundations/Toggle.svelte'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import {
    DITHER_ALGORITHMS,
    type DitherFamily,
    type DitherId,
    type DitherPlacement,
    PLACEMENT_MODES,
  } from '../options.js'
  import RangeField from '../RangeField.svelte'

  /** Ditherette web's Dither panel, with a plain algorithm menu. */
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
  <label class="field-label" for="{id}-algorithm">Algorithm</label>
  <select
    id="{id}-algorithm"
    class="caelestis-select"
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
  <p class="hint">{current.description}</p>

  <RangeField
    label="Strength"
    value={dither.strength}
    min={0}
    max={100}
    step={1}
    unit="%"
    disabled={none || mixing}
    onChange={(strength) => set({ strength: Math.round(strength) })}
  />

  <div class="field-row">
    <label class="field-label" for="{id}-placement">Placement</label>
    <select
      id="{id}-placement"
      class="caelestis-select"
      value={dither.placement}
      disabled={none}
      onchange={(event) => set({ placement: event.currentTarget.value as DitherPlacement })}
    >
      {#each PLACEMENT_MODES as mode (mode.id)}
        <option value={mode.id}>{mode.label}</option>
      {/each}
    </select>
  </div>
  <RangeField
    label="Sample size"
    value={dither.placementSampleSize}
    min={SAMPLE_SIZE_MIN}
    max={SAMPLE_SIZE_MAX}
    step={1}
    unit="px"
    disabled={!adaptive}
    onChange={(size) => set({ placementSampleSize: Math.round(size) })}
  />
  <RangeField
    label="Contrast tolerance"
    value={dither.placementContrastThreshold}
    min={0}
    max={100}
    step={1}
    unit="%"
    disabled={!adaptive}
    onChange={(threshold) => set({ placementContrastThreshold: Math.round(threshold) })}
  />

  <div class="toggles">
    <SettingRow label="Dither in selected space" hint="Perturb and diffuse error in the selected colour space. Colour matching always uses it." compact>
      <Toggle label="Dither in selected space" checked={dither.useColorSpace} disabled={none || mixing} onChange={(useColorSpace) => set({ useColorSpace })} />
    </SettingRow>
    <SettingRow label="Serpentine scan" hint="Reduces directional bias for error diffusion." compact>
      <Toggle label="Serpentine scan" checked={dither.serpentine} disabled={current.family !== 'error-diffusion'} onChange={(serpentine) => set({ serpentine })} />
    </SettingRow>
  </div>

  {#if dither.algorithm === 'random'}
    <div class="seed">
      <div>
        <p class="field-label">Random seed</p>
        <p class="value">{seedLabel}</p>
      </div>
      <Button label="Randomise" size="small" onclick={() => set({ seed: crypto.getRandomValues(new Uint32Array(1))[0] ?? 0 })} />
    </div>
  {/if}
</fieldset>

<style>
  fieldset { display: contents; }
  .toggles { --caelestis-content-inset: 0; display: grid; }
  .seed { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .seed p { margin: 0; }
  .value { font: 0.75rem/1.4 var(--caelestis-mono-font, ui-monospace, monospace); }
</style>
