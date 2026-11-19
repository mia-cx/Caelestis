<script lang="ts">
  import { selectFace } from '../../foundations/select-face.js'
  import { type ColourChannel, type Curve, type CurvesEffect, MAX_CURVES } from '../ditherette.js'
  import { CURVE_CHANNELS, channelFor, channelInfo, channelKey, channelLabel, FLAT, neutralCurve, STRAIGHT, sameChannel } from './catalog.js'
  import CurveGraph from './CurveGraph.svelte'
  import CurveListEditor from './CurveListEditor.svelte'
  import { neutralGrid } from './grid.js'
  import Segmented from '../Segmented.svelte'
  import { hueAxis } from './tone.js'

  /** Ditherette web's Curves editor: several curves, each reading one or two channels. */
  let { id, step, onChange }: { id: string; step: CurvesEffect; onChange: (step: CurvesEffect) => void } = $props()

  /** Each curve's colour, by position: its line and its chip swatch. */
  const TONES = [
    'var(--caelestis-primary)',
    'oklch(0.69 0.15 237)',
    'oklch(0.67 0.26 322)',
    'oklch(0.7 0.15 163)',
    'oklch(0.7 0.19 47)',
    'oklch(0.61 0.22 293)',
  ] as const
  const tone = (index: number): string => TONES[index % TONES.length] ?? TONES[0]

  /** A new curve targets one hue range's saturation, the classic selective adjustment. */
  const NEW_CURVE = neutralCurve({ model: 'oklch', channel: 'hue' }, { model: 'oklch', channel: 'chroma' })

  /**
   * "Lightness (OKLCH)" for a remap, "Hue vs Chroma (OKLCH)" for an adjustment, and
   * "Hue × Lightness vs Chroma (OKLCH)" for a two-input curve.
   */
  const curveName = (c: Curve): string => {
    const [x, x2, y] = [channelInfo(c.x), c.x2 && channelInfo(c.x2), channelInfo(c.y)]
    if (c.kind === 'remap') return `${x.name} (${x.model})`
    const oneModel = x.model === y.model && (!x2 || x2.model === x.model)
    const name = (part: typeof x): string => (oneModel ? part.name : `${part.name} (${part.model})`)
    const inputs = x2 ? `${name(x)} × ${name(x2)}` : name(x)
    return `${inputs} vs ${name(y)}${oneModel ? ` (${x.model})` : ''}`
  }

  const reading = (curve: Curve, x: ColourChannel, x2?: ColourChannel): Curve =>
    x2 ? { kind: 'adjust', x, x2, y: curve.y, grid: neutralGrid(x, x2) } : neutralCurve(x, curve.y)

  /** A hue input wraps for adjustments; hue remaps read their input straight across. */
  const periodic = (c: Curve): boolean => c.kind === 'adjust' && c.x.channel === 'hue'

  /** A new output keeps an adjustment's shape; a remap onto another channel becomes a flat adjustment. */
  const setOutput = (curve: Curve, key: string, replace: (next: Curve) => void): void => {
    const y = channelFor(key)
    if (!y || sameChannel(y, curve.y)) return
    if (curve.x2) replace({ ...curve, y })
    else if (curve.kind === 'remap') replace({ kind: 'adjust', x: curve.x, y, points: FLAT })
    else if (sameChannel(curve.x, y)) replace(neutralCurve(curve.x, y))
    else replace({ ...curve, y })
  }

  const setKind = (curve: Curve, kind: 'remap' | 'adjust', replace: (next: Curve) => void): void => {
    if (curve.x2 || kind === curve.kind) return
    if (kind === 'remap' && sameChannel(curve.x, curve.y)) replace({ ...curve, kind, points: STRAIGHT })
    if (kind === 'adjust') replace({ ...curve, kind, points: FLAT })
  }
</script>

<CurveListEditor
  {id}
  label="Curves"
  addLabel="Add curve"
  curves={step.curves}
  max={MAX_CURVES}
  valueLabel="Adjustment"
  neutral={0.5}
  onChange={(curves) => onChange({ ...step, curves })}
  added={() => NEW_CURVE}
  {reading}
  name={curveName}
  {tone}
  ordered
>
  {#snippet graph(one, active, replace)}
    <CurveGraph
      {id}
      points={one.points}
      colour={tone(active)}
      neutral={one.kind === 'remap' ? 'diagonal' : 'flat'}
      periodic={periodic(one)}
      spectrum={one.x.channel === 'hue' ? hueAxis(one.x.model) : undefined}
      behind={step.curves.flatMap((other, index) =>
        index !== active && !other.x2 && other.kind === one.kind && sameChannel(other.x, one.x)
          ? [{ points: other.points, colour: tone(index) }]
          : [],
      )}
      axes={{ x: channelLabel(one.x), y: one.kind === 'remap' ? channelLabel(one.y) : 'Adjustment' }}
      onChange={(points) => replace({ ...one, points })}
    />
  {/snippet}
  {#snippet rows(curve, replace)}
    <div class="field-row">
      <label class="field-label" for="{id}-y">Changes</label>
      <select id="{id}-y" class="caelestis-select" {@attach selectFace} value={channelKey(curve.y)} onchange={(event) => setOutput(curve, event.currentTarget.value, replace)}>
        {#each CURVE_CHANNELS as option (channelKey(option.channel))}
          <option value={channelKey(option.channel)}>{option.label}</option>
        {/each}
      </select>
    </div>
    {#if !curve.x2}
      <div class="field-row">
        <span class="field-label">Kind</span>
        <Segmented
          label="Kind"
          value={curve.kind}
          options={sameChannel(curve.x, curve.y)
            ? [{ id: 'remap', label: 'Remap' }, { id: 'adjust', label: 'Adjust' }]
            : [{ id: 'adjust', label: 'Adjust' }]}
          onChange={(kind) => setKind(curve, kind, replace)}
        />
      </div>
    {/if}
  {/snippet}
</CurveListEditor>
