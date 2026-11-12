<script lang="ts">
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import { selectFace } from '../../foundations/select-face.js'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'
  import { ALPHA_MODES, type AlphaMode, COLOR_SPACES, type ColorSpaceId } from '../options.js'
  import RangeField from '../RangeField.svelte'

  /** How each pixel picks its palette colour, and how source transparency becomes pixels. */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const id = $props.id()

  const selected = $derived(model.palette.colours.filter((colour) => colour.selected))
  const space = $derived(COLOR_SPACES.find((option) => option.id === model.colorSpace) ?? COLOR_SPACES[0])
</script>

<MenuStyles />

<fieldset disabled={model.pending}>
  <div class="field-row">
    <label class="field-label" for="{id}-space">Matching</label>
    <select
      id="{id}-space"
      class="caelestis-select"
      {@attach selectFace}
      value={model.colorSpace}
      onchange={(event) => onIntent({ type: 'color-space', colorSpace: event.currentTarget.value as ColorSpaceId })}
    >
      {#each COLOR_SPACES as space (space.id)}
        <option value={space.id}>{space.label}</option>
      {/each}
    </select>
  </div>
  <p class="hint">{space.description}</p>

  <p class="section">Transparency</p>
  <div class="field-row">
    <label class="field-label" for="{id}-alpha">Alpha</label>
    <select
      id="{id}-alpha"
      class="caelestis-select"
      {@attach selectFace}
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
        {@attach selectFace}
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
</style>
