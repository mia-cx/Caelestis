import type { Effect } from 'ditherette'
import { EFFECTS, type EffectKind, MAX_EFFECT_LAYERS } from './catalog.js'

/** One named instance in the effect pipeline. The name only labels it; `step` is what runs. */
export interface EffectLayer {
  readonly id: string
  readonly name: string
  readonly step: Effect
}

export const MAX_EFFECT_NAME_LENGTH = 64

const uniqueName = (base: string, layers: readonly EffectLayer[], except?: string): string => {
  const taken = new Set(layers.filter((layer) => layer.id !== except).map((layer) => layer.name))
  if (!taken.has(base)) return base
  let suffix = 2
  while (taken.has(`${base} ${suffix}`)) suffix++
  return `${base} ${suffix}`
}

const replace = (
  layers: readonly EffectLayer[],
  id: string,
  change: (layer: EffectLayer) => EffectLayer,
): EffectLayer[] => layers.map((layer) => (layer.id === id ? change(layer) : layer))

/** A random 128-bit layer id. */
const newLayerId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

/** Append a neutral instance of `kind`, named after the effect. Null when the pipeline is full. */
export const addLayer = (
  layers: readonly EffectLayer[],
  kind: EffectKind,
): { layers: EffectLayer[]; layer: EffectLayer } | null => {
  if (layers.length >= MAX_EFFECT_LAYERS) return null
  const layer = {
    id: newLayerId(),
    name: uniqueName(EFFECTS[kind].label, layers),
    step: EFFECTS[kind].create(),
  }
  return { layers: [...layers, layer], layer }
}

/** Move a layer to `index` in the pipeline, clamped to its ends. */
export const moveLayer = (
  layers: readonly EffectLayer[],
  id: string,
  index: number,
): EffectLayer[] => {
  const from = layers.findIndex((layer) => layer.id === id)
  const to = Math.max(0, Math.min(layers.length - 1, index))
  if (from < 0 || from === to) return [...layers]
  const next = layers.slice()
  const [layer] = next.splice(from, 1)
  if (layer !== undefined) next.splice(to, 0, layer)
  return next
}

/** Rename a layer. Blank names fall back to the effect's label; duplicates get a number. */
export const renameLayer = (
  layers: readonly EffectLayer[],
  id: string,
  name: string,
): EffectLayer[] => {
  const layer = layers.find((candidate) => candidate.id === id)
  if (layer === undefined) return [...layers]
  const base = name.trim().slice(0, MAX_EFFECT_NAME_LENGTH) || EFFECTS[layer.step.effect].label
  return replace(layers, id, (current) => ({ ...current, name: uniqueName(base, layers, id) }))
}

/** Replace a layer's step. The effect kind never changes. */
export const updateLayer = (
  layers: readonly EffectLayer[],
  id: string,
  step: Effect,
): EffectLayer[] =>
  replace(layers, id, (layer) => (layer.step.effect === step.effect ? { ...layer, step } : layer))

/** Back to the effect's neutral settings, keeping whether it runs. */
export const resetLayer = (layers: readonly EffectLayer[], id: string): EffectLayer[] =>
  replace(layers, id, (layer) => ({
    ...layer,
    step: { ...EFFECTS[layer.step.effect].create(), enabled: layer.step.enabled },
  }))

export const removeLayer = (layers: readonly EffectLayer[], id: string): EffectLayer[] =>
  layers.filter((layer) => layer.id !== id)
