<script lang="ts">
  import MenuStyles from '../foundations/MenuStyles.svelte'
  import { isWorkIdentity, type PainterIdentity } from '@caelestis/shared'
  import type { Snippet } from 'svelte'
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import { anchorPopover } from '../foundations/popover.js'
  import type { FavouritesModel } from './model.js'

  let {
    model,
    name,
    children,
    onChange,
  }: {
    model: FavouritesModel
    name: string
    children: Snippet
    onChange: (release: boolean, person?: PainterIdentity) => void
  } = $props()
  let assigning = $state(false)
  let username = $state('')
  let userId = $state('')
  let trigger: HTMLButtonElement
  let popup: HTMLDivElement
  let open = $state(false)
  const popupId = $props.id()
  const close = (restoreFocus = false): void => {
    popup.hidePopover()
    if (restoreFocus) trigger.focus()
  }
  const assignee = $derived.by(() => {
    const person = { displayName: username.trim(), wplaceUserId: /^\d+$/.test(userId) ? Number(userId) : Number.NaN }
    return isWorkIdentity(person) ? person : undefined
  })
  const assign = (): void => {
    if (assignee === undefined) return
    onChange(false, assignee)
    assigning = false
    username = ''
    userId = ''
  }
</script>

<MenuStyles />

<button bind:this={trigger} class="marker" type="button" popovertarget={popupId}
  aria-label={`Claims for ${name}`} aria-haspopup="dialog" aria-expanded={open}
  title={model.people.length > 0 ? model.people.map((person) => `${person.displayName} #${person.wplaceUserId}`).join(', ') : 'Assign someone'}
  onclick={(event) => {
    event.preventDefault()
    event.stopPropagation()
    if (open) { close(true); return }
    popup.showPopover()
    anchorPopover(popup, { anchor: () => trigger.getBoundingClientRect(), gap: 8 })
    ;(popup.querySelector<HTMLElement>('.action') ?? popup.querySelector<HTMLElement>('button') ?? popup).focus()
  }}>
  {@render children()}
  {#if model.people.length > 0}<span class="count caelestis-badge" class:mine={model.mine} aria-hidden="true">{model.people.length > 99 ? '99+' : model.people.length}</span>{/if}
</button>
<div bind:this={popup} id={popupId} class="favourites caelestis-menu caelestis-dropdown" popover="auto" role="dialog" tabindex="-1" aria-label={`Claims for ${name}`}
  onbeforetoggle={(event) => { open = event.newState === 'open'; if (!open) assigning = false }}
  onclick={(event) => event.stopPropagation()}
  onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close(true) } }}>
  <div class="head">
    <span class="title">{name}</span>
    <span class="meta">{model.people.length === 0 ? 'No claims' : `${model.people.length} ${model.people.length === 1 ? 'claim' : 'claims'}`}</span>
  </div>
  <ul class="people">
    {#each model.people as person (person.wplaceUserId)}
      <li class="person">
        <span class="who"><span class="name">{person.displayName}</span> <small>#{person.wplaceUserId}</small></span>
        {#if model.canAssign}
          <Button
            label={`Remove ${person.displayName}'s claim`}
            title={`Remove ${person.displayName}'s claim`}
            kind="ghost"
            size="compact"
            iconOnly
            onclick={() => onChange(true, person)}><Icon name="close" size="0.875rem" /></Button
          >
        {/if}
      </li>
    {:else}
      <li class="person empty"><span class="who">Nobody has claimed this yet.</span></li>
    {/each}
  </ul>
  {#if model.canClaim || model.canAssign}
    <div class="actions">
      {#if model.canClaim}
        <button type="button" class="action caelestis-menu-item" onclick={() => onChange(model.mine)}>
          <Icon name={model.mine ? 'close' : 'check'} />
          <span>{model.mine ? 'Unfavourite' : 'Favourite'}</span>
        </button>
      {/if}
      {#if model.canAssign}
        <button type="button" class="action caelestis-menu-item" aria-expanded={assigning} onclick={() => (assigning = !assigning)}>
          <Icon name="rename" />
          <span>Assign someone…</span>
        </button>
      {/if}
    </div>
  {/if}
  {#if assigning && model.canAssign}
    <form
      onsubmit={(event) => {
        event.preventDefault()
        assign()
      }}
    >
      <label
        ><span>Wplace username</span><input
          required
          maxlength="128"
          autocomplete="off"
          bind:value={username}
        /></label
      >
      <label
        ><span>Wplace #ID</span><input
          required
          inputmode="numeric"
          pattern="[0-9]+"
          autocomplete="off"
          bind:value={userId}
        /></label
      >
      <div class="form-actions">
        <Button label="Cancel" kind="ghost" size="compact" onclick={() => (assigning = false)} />
        <Button
          label="Assign"
          type="submit"
          kind="primary"
          size="compact"
          disabled={assignee === undefined}
        />
      </div>
    </form>
  {/if}
</div>

<style>
  .favourites { inline-size: 15rem; }
  .favourites:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: -2px; }
  .marker { position: relative; display: inline-flex; align-items: center; justify-content: center; inline-size: 1rem; block-size: 1rem; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .marker::before { content: ''; position: absolute; inset: -0.375rem -0.25rem; border-radius: var(--caelestis-radius); }
  .marker:hover::before, .marker[aria-expanded='true']::before { background: color-mix(in oklab, currentColor 10%, transparent); }
  .marker:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 3px; }
  .count { position: absolute; inset-inline-end: -0.25rem; inset-block-start: -0.375rem; display: grid; place-items: center; inline-size: 1.125rem; block-size: 0.75rem; border-radius: var(--caelestis-radius); background: var(--caelestis-raised-surface); color: var(--caelestis-text); outline: 1px solid var(--caelestis-surface); font: 600 0.5rem/1 var(--caelestis-font); font-variant-numeric: tabular-nums; }
  .count.mine { color: var(--caelestis-primary); }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 1.75rem;
    padding: 0.375rem 0.5rem 0.125rem;
  }
  .title {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: 0.8125rem;
  }
  .meta {
    flex: 0 0 auto;
    color: var(--caelestis-muted-text);
    font-variant-numeric: tabular-nums;
  }
  .people {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .person {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-block-size: 1.75rem;
    padding-inline: 0.5rem 0.125rem;
  }
  .who {
    display: flex;
    min-inline-size: 0;
    align-items: baseline;
    gap: 0.25rem;
    overflow-wrap: anywhere;
  }
  .name {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small,
  .empty {
    color: var(--caelestis-muted-text);
  }
  small {
    flex: 0 0 auto;
    font-size: 0.6875rem;
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    flex-direction: column;
    margin-block-start: 0.25rem;
    padding-block-start: 0.25rem;
    border-block-start: 1px solid var(--caelestis-border);
  }
  .action { inline-size: 100%; }
  .action :global(svg) { flex: 0 0 auto; color: var(--caelestis-muted-text); }
  .action[aria-expanded='true'] { background: var(--menu-hover); }
  form {
    display: grid;
    gap: 0.5rem;
    margin-block-start: 0.25rem;
    padding: 0.5rem 0.5rem 0.25rem;
    border-block-start: 1px solid var(--caelestis-border);
  }
  label {
    display: grid;
    gap: 0.25rem;
    color: var(--caelestis-muted-text);
    font-size: 0.6875rem;
    font-weight: 600;
  }
  input {
    box-sizing: border-box;
    inline-size: 100%;
    min-inline-size: 0;
    block-size: 1.75rem;
    padding: 0 0.5rem;
    font: 400 0.75rem/1 var(--caelestis-font);
    color: var(--caelestis-text);
    background: var(--caelestis-surface);
    border: 1px solid var(--caelestis-border);
    border-radius: var(--caelestis-radius);
  }
  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.25rem;
  }
  input:focus-visible {
    outline: 2px solid var(--caelestis-focus);
    outline-offset: 2px;
  }
</style>
