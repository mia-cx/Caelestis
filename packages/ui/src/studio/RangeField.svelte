<script lang="ts">
  /**
   * A labelled slider with a number field beside it, as Ditherette web pairs them. The slider
   * covers `min` to `max`; the field accepts `fieldMin` to `fieldMax`, which may reach further.
   * `log` places the slider on a log scale, for ratios like gamma; `track` draws a CSS gradient
   * as the track to show what the value does.
   */
  interface Props {
    label: string
    value: number
    min: number
    max: number
    step: number
    unit?: string | undefined
    fieldMin?: number
    fieldMax?: number
    log?: boolean
    track?: string | undefined
    disabled?: boolean
    onChange: (value: number) => void
  }
  let {
    label,
    value,
    min,
    max,
    step,
    unit,
    fieldMin = min,
    fieldMax = max,
    log = false,
    track,
    disabled = false,
    onChange,
  }: Props = $props()

  const LOG_STEP = 0.005
  const id = $props.id()
  const decimals = $derived(Math.max(0, -Math.floor(Math.log10(step))))
  const round = (next: number): number => Number(next.toFixed(decimals))
  const commit = (raw: number): void => {
    if (Number.isFinite(raw)) onChange(round(Math.min(fieldMax, Math.max(fieldMin, raw))))
  }
  const position = $derived(log ? Math.log10(value) : Math.min(max, Math.max(min, value)))
</script>

<div class="field-row">
  <label class="field-label" for="{id}-field">{label}</label>
  <div class="range">
    <input
      type="range"
      class:track={track !== undefined}
      style:--track={track}
      aria-label={label}
      min={log ? Math.log10(min) : min}
      max={log ? Math.log10(max) : max}
      step={log ? LOG_STEP : step}
      value={position}
      {disabled}
      oninput={(event) => commit(log ? 10 ** event.currentTarget.valueAsNumber : event.currentTarget.valueAsNumber)}
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
        value={round(value)}
        {disabled}
        onkeydown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        onchange={(event) => {
          commit(event.currentTarget.valueAsNumber)
          event.currentTarget.value = String(round(value))
        }}
      />
      {#if unit !== undefined}<span class="unit">{unit}</span>{/if}
    </span>
  </div>
</div>

<style>
  .range { display: grid; grid-template-columns: minmax(0, 1fr) 5rem; align-items: center; gap: 0.5rem; }
  /* A gradient track shows the value's effect; the native fill would hide it. */
  .track { appearance: none; block-size: 0.5rem; border-radius: var(--caelestis-pill-radius, 999px); background: var(--track); }
  .track::-webkit-slider-thumb {
    appearance: none;
    inline-size: 0.9rem;
    block-size: 0.9rem;
    border: 2px solid var(--caelestis-surface, white);
    border-radius: 50%;
    background: var(--caelestis-text, #222);
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.3);
  }
  .track::-moz-range-thumb {
    inline-size: 0.9rem;
    block-size: 0.9rem;
    border: 2px solid var(--caelestis-surface, white);
    border-radius: 50%;
    background: var(--caelestis-text, #222);
  }
</style>
