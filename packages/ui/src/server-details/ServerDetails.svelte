<script lang="ts">
  import {
    logoText as validLogoText,
    MAX_HOME_COPY_LENGTH,
    MAX_LOGO_TEXT_LENGTH,
    parseDiscordInviteUrl,
    parseHomeCopy,
    SERVER_ASSET_CONTENT_TYPES,
    SERVER_ASSET_MAX_BYTES,
    type ServerAssetKind,
    sniffServerAssetContentType,
  } from '@caelestis/shared'
  import { onMount } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import type { ServerDetailsFields, ServerDetailsIntent, ServerDetailsModel } from '../types.js'

  let {
    model,
    onIntent,
  }: { model: ServerDetailsModel; onIntent?: (intent: ServerDetailsIntent) => void } = $props()

  let dialog: HTMLDialogElement
  let name = $state('')
  let description = $state('')
  let discordInviteUrl = $state('')
  let homeCopy = $state('')
  let logoText = $state('')
  let validation = $state('')
  // A drag that starts on an input and ends outside the panel fires `click` on the dialog itself.
  // Only a press that began on the backdrop counts as a backdrop click.
  let backdropPress = false
  const savedRevision = $derived(model.revision)
  const emit = (intent: ServerDetailsIntent): void => onIntent?.(intent)

  onMount(() => {
    dialog.showModal()
    return () => dialog.close()
  })

  // Re-seed the form from the model after every committed write, and never while typing.
  $effect(() => {
    savedRevision
    name = model.name
    description = model.description
    discordInviteUrl = model.discordInviteUrl
    homeCopy = model.homeCopy
    logoText = model.logoText
    validation = ''
  })

  const dirty = $derived(
    name !== model.name ||
      description !== model.description ||
      discordInviteUrl !== model.discordInviteUrl ||
      homeCopy !== model.homeCopy ||
      logoText !== model.logoText,
  )

  const save = (): void => {
    const fields: ServerDetailsFields = {
      name: name.trim(),
      description: description.trim(),
      discordInviteUrl: discordInviteUrl.trim(),
      homeCopy: homeCopy.trim(),
      logoText: logoText.trim(),
    }
    if (fields.name.length === 0) {
      validation = 'A server needs a name.'
      return
    }
    if (fields.discordInviteUrl !== '' && parseDiscordInviteUrl(fields.discordInviteUrl) === null) {
      validation = 'Use a Discord invite link such as https://discord.gg/yourcode.'
      return
    }
    if (fields.logoText !== '' && validLogoText(fields.logoText) === null) {
      validation = `Logo text must be 1 to ${MAX_LOGO_TEXT_LENGTH} characters.`
      return
    }
    const copy = parseHomeCopy(fields.homeCopy)
    if (!copy.ok) {
      validation = copy.message
      return
    }
    validation = ''
    emit({ type: 'save', fields })
  }

  const limitLabel = (kind: ServerAssetKind): string =>
    `${Math.round(SERVER_ASSET_MAX_BYTES[kind] / 1024)} KiB`

  const upload = async (kind: ServerAssetKind, input: HTMLInputElement): Promise<void> => {
    const file = input.files?.[0]
    input.value = ''
    if (file === undefined) return
    if (file.size > SERVER_ASSET_MAX_BYTES[kind]) {
      validation = `The ${kind} image must be at most ${limitLabel(kind)}.`
      return
    }
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
    if (sniffServerAssetContentType(head) === null) {
      validation = 'Upload a PNG, JPEG, WebP or GIF image.'
      return
    }
    validation = ''
    emit({ type: 'upload', kind, file })
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="server-details-title"
  aria-describedby="server-details-owner"
  oncancel={(event) => { event.preventDefault(); emit({ type: 'close' }) }}
  onpointerdown={(event) => { backdropPress = event.target === dialog }}
  onclick={(event) => { if (backdropPress && event.target === dialog) emit({ type: 'close' }); backdropPress = false }}
>
  <form class="content" onsubmit={(event) => { event.preventDefault(); save() }}>
    <header>
      <div>
        <h2 id="server-details-title">Edit server details</h2>
        <p id="server-details-owner">{model.owner}</p>
      </div>
      <Button label="Close server details" size="small" kind="ghost" iconOnly onclick={() => emit({ type: 'close' })}>×</Button>
    </header>
    <div class="body" aria-busy={model.busy}>
      {#if model.error}<p class="error" role="alert">{model.error}</p>{/if}
      {#if validation}<p class="error" role="alert">{validation}</p>{/if}
      {#if model.notice}<p class="notice" role="status">{model.notice}</p>{/if}

      <label>
        <span>Name</span>
        <input bind:value={name} maxlength="256" required disabled={model.busy} autocomplete="off" />
      </label>
      <label>
        <span>Description</span>
        <textarea bind:value={description} rows="2" maxlength="4096" disabled={model.busy}></textarea>
        <small>Shown in link previews. Leave empty for the Caelestis default.</small>
      </label>
      <label>
        <span>Discord invite</span>
        <input bind:value={discordInviteUrl} type="url" inputmode="url" placeholder="https://discord.gg/yourcode" disabled={model.busy} autocomplete="off" />
        <small>Adds a join button to the site header.</small>
      </label>
      <label>
        <span>Home page copy</span>
        <textarea bind:value={homeCopy} rows="5" maxlength={MAX_HOME_COPY_LENGTH} disabled={model.busy}></textarea>
        <small>Shown above the template list. Blank lines start paragraphs; ## headings, - bullets, **bold**, *italic* and [links](https://…) work.</small>
      </label>
      <label>
        <span>Logo text</span>
        <input bind:value={logoText} maxlength={MAX_LOGO_TEXT_LENGTH} placeholder={name || 'Server name'} disabled={model.busy} autocomplete="off" />
        <small>Header text when no logo image is set. Leave empty to use the name.</small>
      </label>

      <fieldset>
        <legend>Logo image</legend>
        <div class="asset">
          {#if model.logoImageUrl !== null}
            <img src={model.logoImageUrl} alt="Current logo" class="logo" />
          {:else}
            <span class="empty">No logo image. The header shows the logo text.</span>
          {/if}
          <div class="row">
            <label class="file">
              <input type="file" accept={SERVER_ASSET_CONTENT_TYPES.join(',')} disabled={model.busy} onchange={(event) => void upload('logo', event.currentTarget)} />
              <span>{model.logoImageUrl === null ? 'Upload logo' : 'Replace logo'}</span>
            </label>
            {#if model.logoImageUrl !== null}
              <Button label="Remove logo" size="small" kind="danger-ghost" disabled={model.busy} onclick={() => emit({ type: 'clear-asset', kind: 'logo' })} />
            {/if}
          </div>
          <small>PNG, JPEG, WebP or GIF, at most {limitLabel('logo')}.</small>
        </div>
      </fieldset>

      <fieldset>
        <legend>Link preview image</legend>
        <div class="asset">
          {#if model.previewImageUrl !== null}
            <img src={model.previewImageUrl} alt="Current link preview" class="preview" />
          {:else}
            <span class="empty">No preview image. Links use the Caelestis artwork.</span>
          {/if}
          <div class="row">
            <label class="file">
              <input type="file" accept={SERVER_ASSET_CONTENT_TYPES.join(',')} disabled={model.busy} onchange={(event) => void upload('preview', event.currentTarget)} />
              <span>{model.previewImageUrl === null ? 'Upload preview' : 'Replace preview'}</span>
            </label>
            {#if model.previewImageUrl !== null}
              <Button label="Remove preview" size="small" kind="danger-ghost" disabled={model.busy} onclick={() => emit({ type: 'clear-asset', kind: 'preview' })} />
            {/if}
          </div>
          <small>Used by Discord and other link previews for the home page. 1200 × 630 works best. At most {limitLabel('preview')}.</small>
        </div>
      </fieldset>
    </div>
    <footer>
      {#if model.busy}<p class="saving" role="status">Saving…</p>{/if}
      <Button label="Cancel" size="small" kind="ghost" disabled={model.busy} onclick={() => emit({ type: 'close' })} />
      <Button type="submit" label="Save details" size="small" kind="primary" disabled={model.busy || !dirty} />
    </footer>
  </form>
</dialog>

<style>
  dialog { box-sizing: border-box; inline-size: min(32rem, calc(100vw - 2rem)); max-block-size: calc(100dvh - 2rem); padding: 0; border: 1px solid color-mix(in oklab, var(--caelestis-text) 20%, transparent); border-radius: var(--caelestis-box-radius, 1rem); background: var(--caelestis-surface, white); color: var(--caelestis-text, #222); box-shadow: 0 1rem 3rem #0004; font: 0.875rem/1.4 ui-sans-serif, system-ui, sans-serif; }
  dialog::backdrop { background: #0006; }
  .content { display: flex; flex-direction: column; max-block-size: calc(100dvh - 2rem); margin: 0; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 0.75rem; padding: 1rem; border-block-end: 1px solid color-mix(in oklab, currentColor 12%, transparent); }
  header > div { min-inline-size: 0; }
  h2 { margin: 0; font-size: 1rem; font-weight: 600; }
  header p { margin: 0.25rem 0 0; opacity: 0.7; overflow-wrap: anywhere; }
  .body { display: flex; flex-direction: column; gap: 0.75rem; padding: 0.75rem 1rem; overflow-y: auto; }
  label:not(.file) { display: flex; flex-direction: column; gap: 0.25rem; }
  label > span:first-child, legend { font-weight: 600; }
  small { opacity: 0.7; }
  input:not([type='file']), textarea { box-sizing: border-box; inline-size: 100%; font: inherit; color: inherit; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); padding: 0.375rem 0.625rem; background: var(--caelestis-raised-surface, #f4f4f4); }
  textarea { resize: vertical; min-block-size: 3rem; }
  input:focus-visible, textarea:focus-visible, .file:has(input:focus-visible) { outline: 2px solid var(--caelestis-primary, #467ee5); outline-offset: 2px; }
  input:disabled, textarea:disabled { opacity: 0.5; }
  fieldset { margin: 0; padding: 0.625rem 0.75rem 0.75rem; border: 1px solid color-mix(in oklab, currentColor 15%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); }
  .asset { display: flex; flex-direction: column; gap: 0.5rem; }
  .row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .file { position: relative; display: inline-flex; align-items: center; block-size: 2rem; padding-inline: 0.75rem; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); border-radius: var(--caelestis-field-radius, 0.5rem); cursor: pointer; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; inline-size: 100%; }
  .file:has(input:disabled) { opacity: 0.5; cursor: default; }
  img { display: block; background: repeating-conic-gradient(#8884 0 25%, transparent 0 50%) 0 0 / 1rem 1rem; border-radius: 0.375rem; }
  .logo { block-size: 2.5rem; max-inline-size: 100%; object-fit: contain; object-position: left; }
  .preview { inline-size: 100%; max-block-size: 10rem; object-fit: contain; }
  .empty { opacity: 0.7; }
  .error { margin: 0; color: var(--caelestis-danger, #bc3434); overflow-wrap: anywhere; }
  .notice { margin: 0; opacity: 0.8; }
  footer { display: flex; align-items: center; justify-content: end; gap: 0.5rem; padding: 0.75rem 1rem; border-block-start: 1px solid color-mix(in oklab, currentColor 12%, transparent); }
  .saving { margin: 0 auto 0 0; opacity: 0.7; }
</style>
