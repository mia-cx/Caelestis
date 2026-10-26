<script lang="ts">
  import type { Effect } from 'ditherette'
  import CurvesEditor from './CurvesEditor.svelte'
  import { NUMBER_FIELDS } from './fields.js'
  import LevelsEditor from './LevelsEditor.svelte'
  import NumberFieldsEditor from './NumberFieldsEditor.svelte'
  import PaletteFitEditor from './PaletteFitEditor.svelte'
  import ToneGraph from './ToneGraph.svelte'
  import { brightnessContrastTone, exposureTone, hueSpectrum, levelsTone } from './tone.js'

  /** One effect step's own controls, as Ditherette web's effect editors. */
  let {
    id,
    step,
    analysing,
    onChange,
    onAnalyse,
  }: {
    id: string
    step: Effect
    /** A palette fit's analysis is running. */
    analysing: boolean
    onChange: (step: Effect) => void
    /** Resolve a palette fit's curves so they can be edited. */
    onAnalyse: () => void
  } = $props()

  const LEVELS_STROKE = {
    rgb: 'currentColor',
    red: 'oklch(0.63 0.22 27)',
    green: 'oklch(0.72 0.19 145)',
    blue: 'oklch(0.62 0.19 255)',
  } as const
</script>

{#if step.effect === 'levels'}
  <ToneGraph label="Levels response" curves={[{ map: levelsTone(step), colour: LEVELS_STROKE[step.channel] }]} />
  <LevelsEditor {step} {onChange} />
{:else if step.effect === 'curves'}
  <CurvesEditor {id} {step} {onChange} />
{:else if step.effect === 'palette-fit'}
  <PaletteFitEditor {id} {step} {analysing} {onChange} {onAnalyse} />
{:else if step.effect === 'brightness-contrast'}
  <ToneGraph label="Brightness and contrast response" curves={[{ map: brightnessContrastTone(step), colour: 'currentColor' }]} />
  <NumberFieldsEditor {step} fields={NUMBER_FIELDS[step.effect]} {onChange} />
{:else if step.effect === 'exposure'}
  <ToneGraph label="Exposure response" curves={[{ map: exposureTone(step), colour: 'currentColor' }]} />
  <NumberFieldsEditor {step} fields={NUMBER_FIELDS[step.effect]} {onChange} />
{:else if step.effect === 'white-balance'}
  <NumberFieldsEditor {step} fields={NUMBER_FIELDS[step.effect]} {onChange} />
{:else if step.effect === 'hue-saturation'}
  <!-- Input hues above, the same hues after this step below. -->
  <div class="spectrum" aria-hidden="true">
    <div style:background-image={hueSpectrum({})}></div>
    <div style:background-image={hueSpectrum({ step })}></div>
  </div>
  <NumberFieldsEditor {step} fields={NUMBER_FIELDS[step.effect]} {onChange} />
{:else if step.effect === 'recolour'}
  <NumberFieldsEditor {step} fields={NUMBER_FIELDS[step.effect]} {onChange} />
{/if}

<style>
  .spectrum { display: grid; gap: 0.25rem; }
  .spectrum div { block-size: 0.75rem; border: 1px solid var(--caelestis-border); }
</style>
