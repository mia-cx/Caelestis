<script lang="ts">
  import { onMount } from 'svelte'
  import AppearanceEditor from '../appearance/AppearanceEditor.svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import TemplateState from '../template-state/TemplateState.svelte'
  import type { AppearanceEditorIntent } from '../appearance/model.js'
  import type { OverlayControlsIntent, OverlayControlsModel } from './model.js'

  let { model, onIntent }: { model: OverlayControlsModel; onIntent?: (intent: OverlayControlsIntent) => void } = $props()
  const emit = (intent: OverlayControlsIntent): void => onIntent?.(intent)
  let root: HTMLElement
  let closeButton: HTMLButtonElement | undefined = $state()
  // A control's key is its position among the menu's focusables, so the host can hand it back to
  // a rebuilt menu without knowing what the controls are.
  const focusables = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
  const controlKey = (target: EventTarget | null): string | null => {
    const index = focusables().findIndex((control) => control === target)
    return index === -1 ? null : String(index)
  }

  onMount(() => {
    if (model.focus === undefined) return
    const control = model.focus === 'close' ? undefined : focusables()[Number(model.focus)]
    ;(control ?? closeButton)?.focus()
  })
  const onAppearance = (intent: AppearanceEditorIntent): void => emit({ type: 'appearance', intent })

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    emit({ type: 'close' })
  }
</script>

<div bind:this={root} class="dialog caelestis-panel-surface" role="dialog" aria-label={`${model.name} display options`} tabindex="-1" onkeydown={onKeydown} onfocusin={(event) => emit({ type: 'focus', control: controlKey(event.target) })}>
  <header>
    <div class="title">
      <strong title={model.name}>{model.name}</strong>
      <span class="lifecycle">
        {#if model.lifecycle !== undefined}<TemplateState compact {...model.lifecycle} />{/if}
      </span>
    </div>
    <Button label="Close" kind="ghost" size="compact" iconOnly bind:element={closeButton} onclick={() => emit({ type: 'close' })}><Icon name="close" /></Button>
  </header>

  {#each model.failures as failure (failure.id)}
    <div class="failure" role={failure.announce ? 'alert' : undefined}>{failure.message}</div>
  {/each}

  <AppearanceEditor model={model.appearance} onIntent={onAppearance} />
  {#if model.updateArtwork !== undefined}
    <div class="artwork-action">
      <Button label="Use canvas artwork" kind="ghost" size="small" disabled={model.updateArtwork.disabled || model.updateArtwork.pending} onclick={() => emit({ type: 'update-artwork' })}>
        {model.updateArtwork.pending ? 'Updating…' : 'Use canvas artwork'}
      </Button>
    </div>
  {/if}
</div>

<style>
  .dialog { --caelestis-content-inset: 1rem; display: flex; max-block-size: inherit; flex-direction: column; overflow-y: auto; padding: var(--caelestis-content-inset); border-radius: var(--caelestis-radius); background: var(--caelestis-surface); color: var(--caelestis-text); box-shadow: var(--caelestis-shadow); font: 400 0.875rem/1.35 var(--caelestis-font); }
  header { display: flex; flex: 0 0 auto; align-items: center; gap: 0.25rem; }
  .title { display: flex; flex: 1; min-inline-size: 0; align-items: center; gap: 0.25rem; }
  header strong { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .lifecycle { display: inline-flex; flex-shrink: 0; align-items: center; min-inline-size: 1rem; min-block-size: 1rem; }
  .failure { margin: 0.35rem 0 0; border-radius: var(--caelestis-radius); }
  .failure { padding: 0.45rem 0.55rem; background: color-mix(in oklch, var(--caelestis-danger) 14%, var(--caelestis-raised-surface)); color: var(--caelestis-danger); }
  .artwork-action { margin-block-start: 0.5rem; }
  .artwork-action :global(button) { inline-size: 100%; block-size: auto; min-block-size: 2rem; padding-block: 0.5rem; line-height: 1.35; }
</style>
