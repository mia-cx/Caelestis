<script lang="ts" generics="S extends Effect">
  import type { Effect } from 'ditherette'
  import RangeField from '../RangeField.svelte'
  import type { NumberField } from './fields.js'

  /** An effect whose editor is a list of sliders, in display units. */
  let {
    step,
    fields,
    onChange,
  }: { step: S; fields: readonly NumberField<S>[]; onChange: (step: S) => void } = $props()
</script>

{#each fields as field (field.key)}
  {@const scale = field.scale ?? 1}
  <RangeField
    label={field.label}
    value={(step[field.key] as number) * scale}
    min={field.min}
    max={field.max}
    step={field.step}
    unit={field.unit}
    track={field.track}
    onChange={(value) => onChange({ ...step, [field.key]: value / scale })}
  />
{/each}
