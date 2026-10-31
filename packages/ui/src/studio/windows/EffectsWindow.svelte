<script lang="ts">
  import Button from '../../foundations/Button.svelte'
  import Icon from '../../foundations/Icon.svelte'
  import MenuStyles from '../../foundations/MenuStyles.svelte'
  import { ADDABLE_KINDS, EFFECTS, type EffectKind } from '../effects/catalog.js'
  import EffectEditor from '../effects/EffectEditor.svelte'
  import MaskEditor from '../effects/MaskEditor.svelte'
  import {
    addLayer,
    type EffectLayer,
    MAX_EFFECT_NAME_LENGTH,
    moveLayer,
    removeLayer,
    renameLayer,
    resetLayer,
    updateLayer,
  } from '../effects/layers.js'
  import type { TemplateStudioIntent, TemplateStudioModel } from '../model.js'

  /**
   * The effect pipeline, as Ditherette web's Effects panel: layers run top to bottom on the
   * source before it is resized. The selected layer's controls sit below the list.
   */
  let { model, onIntent }: { model: TemplateStudioModel; onIntent: (intent: TemplateStudioIntent) => void } = $props()

  const id = $props.id()
  let selectedId = $state<string | null>(null)
  const layers = $derived(model.effects)
  const selected = $derived(layers.find((layer) => layer.id === selectedId) ?? null)
  const set = (effects: readonly EffectLayer[]): void => onIntent({ type: 'effects', effects })

  const add = (event: Event & { currentTarget: HTMLSelectElement }): void => {
    const kind = event.currentTarget.value as EffectKind
    event.currentTarget.value = ''
    const added = addLayer(layers, kind)
    if (added === null) return
    selectedId = added.layer.id
    set(added.layers)
  }
</script>

<MenuStyles />

<fieldset disabled={model.pending}>
  <select class="caelestis-select" aria-label="Add effect" value="" onchange={add}>
    <option value="" disabled>Add effect…</option>
    {#each ADDABLE_KINDS as kind (kind)}
      <option value={kind}>{EFFECTS[kind].label}</option>
    {/each}
  </select>

  {#if layers.length === 0}
    <p class="hint">No effects yet.</p>
  {:else}
    <ol class="layers" aria-label="Effect layers">
      {#each layers as layer, index (layer.id)}
        <li class:selected={layer.id === selectedId} class:off={!layer.step.enabled}>
          <Button
            label={layer.step.enabled ? `Turn off ${layer.name}` : `Turn on ${layer.name}`}
            title={layer.step.enabled ? 'Turn off' : 'Turn on'}
            kind="ghost"
            size="compact"
            iconOnly
            pressed={layer.step.enabled}
            onclick={() => set(updateLayer(layers, layer.id, { ...layer.step, enabled: !layer.step.enabled }))}
          >
            <Icon name={layer.step.enabled ? 'eye' : 'eyeOff'} />
          </Button>
          <button
            type="button"
            class="name"
            aria-pressed={layer.id === selectedId}
            onclick={() => (selectedId = selectedId === layer.id ? null : layer.id)}
          >{layer.name}</button>
          <Button label="Move {layer.name} up" title="Move up" kind="ghost" size="compact" iconOnly disabled={index === 0} onclick={() => set(moveLayer(layers, layer.id, index - 1))}>
            <Icon name="expandLess" />
          </Button>
          <Button label="Move {layer.name} down" title="Move down" kind="ghost" size="compact" iconOnly disabled={index === layers.length - 1} onclick={() => set(moveLayer(layers, layer.id, index + 1))}>
            <Icon name="expandMore" />
          </Button>
          <Button label="Remove {layer.name}" title="Remove" kind="ghost" size="compact" iconOnly onclick={() => set(removeLayer(layers, layer.id))}>
            <Icon name="trash" />
          </Button>
        </li>
      {/each}
    </ol>
  {/if}

  {#if selected !== null}
    {@const layer = selected}
    <section class="editor" aria-label="{layer.name} controls">
      <div class="editor-head">
        <input
          id="{id}-name"
          class="caelestis-field"
          aria-label="Effect name"
          maxlength={MAX_EFFECT_NAME_LENGTH}
          value={layer.name}
          onkeydown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          onchange={(event) => set(renameLayer(layers, layer.id, event.currentTarget.value))}
        />
        <Button label="Reset {layer.name}" title="Reset" kind="ghost" size="compact" iconOnly onclick={() => set(resetLayer(layers, layer.id))}>
          <Icon name="reset" />
        </Button>
      </div>
      <EffectEditor
        id="{id}-{layer.id}"
        step={layer.step}
        analysing={model.analysingFit === layer.id}
        onChange={(step) => set(updateLayer(layers, layer.id, step))}
        onAnalyse={() => onIntent({ type: 'analyse-fit', layer: layer.id })}
      />
      <MaskEditor
        id="{id}-{layer.id}"
        mask={layer.step.mask ?? []}
        onChange={(mask) => {
          // An empty mask is full strength, so the step leaves it out.
          const { mask: _, ...rest } = layer.step
          set(updateLayer(layers, layer.id, mask.length > 0 ? { ...rest, mask } : rest))
        }}
      />
    </section>
  {/if}
</fieldset>

<style>
  fieldset { display: contents; }
  .layers { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
  .layers li { display: flex; align-items: center; gap: 0.125rem; border-radius: calc(var(--caelestis-radius, 0.5rem) / 2); }
  .layers li.selected { background: color-mix(in oklab, var(--caelestis-primary, oklch(0.68 0.15 244)) 16%, transparent); }
  .layers li.off .name { color: var(--caelestis-muted-text); }
  .name {
    flex: 1;
    min-inline-size: 0;
    padding: 0.35rem 0.25rem;
    overflow: hidden;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .name:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: -2px; }
  .editor { display: flex; flex-direction: column; gap: 0.5rem; padding-block-start: 0.5rem; border-block-start: 1px solid var(--caelestis-border); }
  .editor-head { display: flex; align-items: center; gap: 0.25rem; }
  .editor-head input { flex: 1; min-inline-size: 0; }
</style>
