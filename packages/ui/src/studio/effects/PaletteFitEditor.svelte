<script lang="ts">
  import type { CurvesEffect, FitLook, PaletteFitEffect, PaletteFitSpace } from 'ditherette'
  import Button from '../../foundations/Button.svelte'
  import { selectFace } from '../../foundations/select-face.js'
  import { FIT_SPACES } from './catalog.js'
  import CurvesEditor from './CurvesEditor.svelte'
  import { NUMBER_FIELDS } from './fields.js'
  import NumberFieldsEditor from './NumberFieldsEditor.svelte'
  import Segmented from './Segmented.svelte'

  /**
   * Ditherette web's Palette fit: a look, a strength, and the space it analyses in. Its curves
   * follow the image until edited; editing locks them, and Reset hands them back to analysis.
   */
  let {
    id,
    step,
    analysing,
    onChange,
    onAnalyse,
  }: {
    id: string
    step: PaletteFitEffect
    /** The analysis behind Edit curves is running. */
    analysing: boolean
    onChange: (step: PaletteFitEffect) => void
    /** Analyse the fit now and keep its curves on the step, ready to edit. */
    onAnalyse: () => void
  } = $props()

  const LOOKS: readonly { id: FitLook; label: string }[] = [
    { id: 'natural', label: 'Natural' },
    { id: 'fitted', label: 'Fitted' },
    { id: 'vivid', label: 'Vivid' },
  ]

  const edited = $derived(step.curves !== null)
  const curvesStep = $derived<CurvesEffect>({ effect: 'curves', enabled: true, curves: step.curves ?? [] })
</script>

<div class="field-row">
  <span class="field-label">Look</span>
  {#if edited}
    <p class="hint">{LOOKS.find((look) => look.id === step.look)?.label}</p>
  {:else}
    <Segmented label="Palette fit look" value={step.look} options={LOOKS} onChange={(look) => onChange({ ...step, look })} />
  {/if}
</div>
<NumberFieldsEditor {step} fields={NUMBER_FIELDS['palette-fit']} {onChange} />
<div class="field-row">
  <label class="field-label" for="{id}-space">Space</label>
  <select
    id="{id}-space"
    class="caelestis-select"
    {@attach selectFace}
    value={step.space}
    disabled={edited}
    onchange={(event) => onChange({ ...step, space: event.currentTarget.value as PaletteFitSpace })}
  >
    {#each FIT_SPACES as space (space.id)}
      <option value={space.id}>{space.label}</option>
    {/each}
  </select>
</div>

<div class="field-row">
  <span class="field-label">Curves</span>
  {#if edited}
    <Button label="Reset curves" size="small" onclick={() => onChange({ ...step, curves: null })} />
  {:else}
    <Button label={analysing ? 'Analysing…' : 'Edit curves'} size="small" disabled={analysing} onclick={onAnalyse} />
  {/if}
</div>
{#if edited}
  <p class="hint">Edited. Reset to change the look or space; the fit then follows the image again.</p>
  <CurvesEditor {id} step={curvesStep} onChange={(next) => onChange({ ...step, curves: [...next.curves] })} />
{/if}
