<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  import type { IconName } from './icons.svelte.js'

  let {
    title,
    icon,
    expanded,
    onToggle,
    actions,
  }: {
    title: string
    icon?: IconName | undefined
    expanded?: boolean | undefined
    onToggle?: (() => void) | undefined
    actions?: Snippet | undefined
  } = $props()
</script>

<div class:compact={onToggle !== undefined} class="section">
  {#if onToggle !== undefined}
    <button class="section-toggle" type="button" aria-expanded={expanded} onclick={onToggle}><span class:open={expanded} class="caret"><Icon name="caret" size="0.75rem" /></span><h2>{title}</h2></button>
  {:else}
    <span class="chip" aria-hidden="true">
      {#if icon !== undefined}<Icon name={icon} />{/if}
    </span>
    <h2>{title}</h2>
  {/if}
  {#if actions !== undefined}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .section { display: flex; align-items: center; gap: 0.5rem; padding: 1.25rem var(--caelestis-content-inset, 1rem) 0.5rem; color: var(--caelestis-text, inherit); }
  .chip { display: grid; flex: 0 0 auto; place-items: center; inline-size: 1.75rem; block-size: 1.75rem; border-radius: var(--caelestis-radius); background: var(--caelestis-raised-surface, oklch(0.92 0.01 264)); }
  h2 { margin: 0; color: inherit; font: 600 0.875rem/1.25 var(--caelestis-font); }
  .actions { display: flex; margin-inline-start: auto; align-items: center; }
  .compact { gap: 0.5rem; padding: 0.5rem 0 0.25rem; }
  .compact button { display: flex; flex: 1; align-items: center; gap: 0.25rem; min-inline-size: 0; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; text-align: start; }
  .compact h2 { color: color-mix(in srgb, currentColor 60%, transparent); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.025em; text-transform: uppercase; }
  .caret { display: grid; flex: 0 0 auto; place-items: center; opacity: 0.6; transition: transform var(--caelestis-duration-quick) var(--caelestis-ease-smooth-out); }
  .caret.open { transform: rotate(90deg); }
  .compact button:focus-visible { border-radius: var(--caelestis-radius); outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: 2px; }
</style>
