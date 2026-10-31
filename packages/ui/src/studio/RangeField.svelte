<script lang="ts">
  /**
   * A labelled slider with a number field beside it, as Ditherette web pairs them. The slider
   * covers `min` to `max`; the field accepts `fieldMin` to `fieldMax`, which may reach further.
   */
  interface Props {
    label: string
    value: number
    min: number
    max: number
    step: number
    unit?: string
    fieldMin?: number
    fieldMax?: number
    disabled?: boolean
    onChange: (value: number) => void
  }
  let { label, value, min, max, step, unit, fieldMin = min, fieldMax = max, disabled = false, onChange }: Props = $props()

  const id = $props.id()
  const commit = (raw: number): void => {
    if (Number.isFinite(raw)) onChange(Math.min(fieldMax, Math.max(fieldMin, raw)))
  }
</script>

<div class="field-row">
  <label class="field-label" for="{id}-field">{label}</label>
  <div class="range">
    <input
      type="range"
      aria-label={label}
      {min}
      {max}
      {step}
      value={Math.min(max, Math.max(min, value))}
      {disabled}
      oninput={(event) => commit(event.currentTarget.valueAsNumber)}
    />
    <span class="number">
      <input
        id="{id}-field"
        class="caelestis-field"
        type="number"
        inputmode="decimal"
        min={fieldMin}
        max={fieldMax}
        step="any"
        value={Number(value.toFixed(4))}
        {disabled}
        onkeydown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        onchange={(event) => commit(event.currentTarget.valueAsNumber)}
      />
      {#if unit !== undefined}<span class="unit">{unit}</span>{/if}
    </span>
  </div>
</div>

<style>
  .range { display: grid; grid-template-columns: minmax(0, 1fr) 5rem; align-items: center; gap: 0.5rem; }
</style>
