<script lang="ts">
  import type { EffectChannel, LevelsEffect } from 'ditherette'
  import RangeField from '../RangeField.svelte'
  import Segmented from './Segmented.svelte'

  let { step, onChange }: { step: LevelsEffect; onChange: (step: LevelsEffect) => void } = $props()

  /** Short enough for the controls' column; the full name shows on hover. */
  const CHANNELS: readonly { id: EffectChannel; label: string; title: string }[] = [
    { id: 'rgb', label: 'RGB', title: 'All channels' },
    { id: 'red', label: 'R', title: 'Red' },
    { id: 'green', label: 'G', title: 'Green' },
    { id: 'blue', label: 'B', title: 'Blue' },
  ]
  /** Levels reads in byte units, like every editor's Levels panel. */
  const BYTE = 255
  const toByte = (value: number): number => value * BYTE
  const fromByte = (value: number): number => value / BYTE

  // Input black must stay below input white; output black above white inverts, so it may cross.
  // A saved pair can sit less than a byte apart, so the gap never pushes past 0..255.
  const setInput = (edge: 'black' | 'white', byte: number): void => {
    const other = toByte(edge === 'black' ? step.input.white : step.input.black)
    const gapped = edge === 'black' ? Math.min(byte, other - 1) : Math.max(byte, other + 1)
    const clamped = Math.min(BYTE, Math.max(0, gapped))
    onChange({ ...step, input: { ...step.input, [edge]: fromByte(clamped) } })
  }
</script>

<div class="field-row">
  <span class="field-label">Channel</span>
  <Segmented label="Channel" value={step.channel} options={CHANNELS} onChange={(channel) => onChange({ ...step, channel })} />
</div>
<RangeField label="Input black" value={toByte(step.input.black)} min={0} max={BYTE - 1} step={1} onChange={(value) => setInput('black', value)} />
<RangeField label="Input white" value={toByte(step.input.white)} min={1} max={BYTE} step={1} onChange={(value) => setInput('white', value)} />
<RangeField label="Midtones" value={step.gamma} min={0.1} max={10} step={0.01} log onChange={(gamma) => onChange({ ...step, gamma })} />
<RangeField
  label="Output black"
  value={toByte(step.output.black)}
  min={0}
  max={BYTE}
  step={1}
  onChange={(value) => onChange({ ...step, output: { ...step.output, black: fromByte(value) } })}
/>
<RangeField
  label="Output white"
  value={toByte(step.output.white)}
  min={0}
  max={BYTE}
  step={1}
  onChange={(value) => onChange({ ...step, output: { ...step.output, white: fromByte(value) } })}
/>
