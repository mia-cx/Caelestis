<script lang="ts">
  import { tagName, tagNameKey } from '@caelestis/shared'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import Checkbox from '../foundations/Checkbox.svelte'
  import Modal from '../foundations/Modal.svelte'
  import type { TagManagerIntent, TagManagerModel } from './model.js'

  let { model, onIntent }: { model: TagManagerModel; onIntent?: (intent: TagManagerIntent) => void } = $props()
  let draft = $state('')
  let editing = $state<string | null>(null)
  let rename = $state('')
  let deleting = $state<string | null>(null)
  let validation = $state('')
  const disabled = $derived(model.busy || model.loading || !model.ready)
  const savedRevision = $derived(model.revision)
  const sorted = $derived([...model.tags].sort((a, b) => a.name.localeCompare(b.name)))
  const emit = (intent: TagManagerIntent): void => onIntent?.(intent)
  $effect(() => { savedRevision; draft = ''; editing = null; deleting = null; validation = '' })
  const save = (value: string, id?: string): void => {
    const name = tagName(value)
    if (name === null) { validation = 'Use 1–64 characters without control characters.'; return }
    if (model.tags.some((tag) => tag.id !== id && tagNameKey(tag.name) === tagNameKey(name))) {
      validation = 'A tag with that name already exists.'; return
    }
    validation = ''
    emit(id === undefined ? { type: 'create', name } : { type: 'rename', id, name })
  }
  const focusInput = (input: HTMLInputElement): void => { input.focus(); input.select() }
</script>

<Modal open={model.open} labelledby="tag-title" describedby="tag-owner" onClose={() => emit({ type: 'close' })} onClosed={() => emit({ type: 'closed' })}>
  <div class="content">
    <header>
      <div><h2 id="tag-title">{model.targetName === undefined ? 'Manage tags' : `Tags for ${model.targetName}`}</h2><p id="tag-owner">{model.owner}</p></div>
      <Button label="Close tags" size="small" kind="ghost" iconOnly onclick={() => emit({ type: 'close' })}><Icon name="close" /></Button>
    </header>
    <div class="body" aria-busy={disabled}>
      {#if model.loading}<p role="status">Loading tags…</p>{/if}
      {#if model.error}<div class="error" role="alert"><span>{model.error}</span><Button label="Reload tags" size="small" disabled={model.busy || model.loading} onclick={() => emit({ type: 'retry' })} /></div>{/if}
      {#if validation}<p class="error" role="alert">{validation}</p>{/if}
      {#if !model.loading && model.tags.length === 0 && !model.error}<p class="empty">No tags yet.</p>{/if}
      <ul aria-label="Tags">
        {#each sorted as tag (tag.id)}
          <li>
            {#if editing === tag.id}
              <form class="row" onsubmit={(event) => { event.preventDefault(); save(rename, tag.id) }}>
                <input class="caelestis-field" use:focusInput aria-label={`Rename ${tag.name}`} bind:value={rename} maxlength="64" disabled={disabled} onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editing = null; validation = '' } }} />
                <Button label="Save" size="small" disabled={disabled} onclick={() => save(rename, tag.id)} />
                <Button label="Cancel rename" size="small" kind="ghost" disabled={disabled} onclick={() => { editing = null; validation = '' }} />
              </form>
            {:else if deleting === tag.id}
              <div class="delete"><p>Remove “{tag.name}” from every template and folder?</p><div class="row"><Button label="Delete tag" size="small" kind="danger" disabled={disabled} onclick={() => emit({ type: 'delete', id: tag.id })} /><Button label="Cancel" size="small" kind="ghost" disabled={disabled} onclick={() => deleting = null} /></div></div>
            {:else}
              <div class="row">
                {#if model.targetName !== undefined}<label><Checkbox checked={model.selected.includes(tag.id)} {disabled} onChange={(attached) => emit({ type: 'assign', id: tag.id, attached })} /><span>{tag.name}</span></label>{:else}<span class="name">{tag.name}</span>{/if}
                <Button label={`Rename ${tag.name}`} title="Rename tag" size="small" kind="ghost" iconOnly disabled={disabled} onclick={() => { editing = tag.id; rename = tag.name; validation = '' }}><Icon name="rename" /></Button>
                <Button label={`Delete ${tag.name}`} title="Delete tag" size="small" kind="danger-ghost" iconOnly disabled={disabled} onclick={() => { deleting = tag.id; validation = '' }}><Icon name="trash" /></Button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      <form class="create" onsubmit={(event) => { event.preventDefault(); save(draft) }}>
        <input class="caelestis-field" aria-label="New tag name" placeholder="New tag" bind:value={draft} maxlength="64" disabled={disabled} />
        <Button label="Create tag" size="small" kind="primary" disabled={disabled || draft.trim() === ''} onclick={() => save(draft)} />
      </form>
      {#if model.busy}<p class="saving" role="status">Saving…</p>{/if}
    </div>
  </div>
</Modal>

<style>
  .content { overflow: hidden; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; padding: 1rem; border-block-end: 1px solid color-mix(in oklab, currentColor 12%, transparent); }
  header > div { min-inline-size: 0; }
  h2 { margin: 0; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
  header p { margin: 0.25rem 0 0; opacity: 0.7; overflow-wrap: anywhere; }
  .body { padding: 0.75rem 1rem 1rem; }
  ul { list-style: none; padding: 0; margin: 0; max-block-size: 45dvh; overflow-y: auto; }
  li + li { border-block-start: 1px solid color-mix(in oklab, currentColor 10%, transparent); }
  .row, .create { display: flex; align-items: center; gap: 0.375rem; min-inline-size: 0; }
  .row { min-block-size: 2.75rem; padding-block: 0.125rem; }
  label { display: flex; align-items: center; gap: 0.625rem; cursor: pointer; }
  label, .name { flex: 1; min-inline-size: 0; overflow-wrap: anywhere; }
  input { box-sizing: border-box; font: inherit; color: inherit; }
  input:not([type='checkbox']) { flex: 1; min-inline-size: 0; inline-size: 100%; block-size: 2rem; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); border-radius: 0.5rem; padding-inline: 0.625rem; background: var(--caelestis-raised-surface); }
  input:focus-visible { outline: 2px solid var(--caelestis-primary); outline-offset: 2px; }
  input:disabled { opacity: 0.5; }
  .create { margin-block-start: 0.75rem; }
  .empty { opacity: 0.7; margin: 0.5rem 0 1rem; }
  .error { color: var(--caelestis-danger); display: flex; align-items: start; gap: 0.5rem; overflow-wrap: anywhere; }
  .error span { flex: 1; }
  .delete p { margin: 0.5rem 0 0; overflow-wrap: anywhere; }
  .saving { margin: 0.5rem 0 0; opacity: 0.7; }
</style>
