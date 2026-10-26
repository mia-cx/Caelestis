<script lang="ts" generics="T extends string">
  /** A row of mutually exclusive choices, such as an effect's channel. One is always chosen. */
  let {
    label,
    value,
    options,
    onChange,
  }: {
    label: string
    value: T
    options: readonly { readonly id: T; readonly label: string }[]
    onChange: (value: T) => void
  } = $props()
</script>

<div class="segmented" role="radiogroup" aria-label={label}>
  {#each options as option (option.id)}
    <button
      type="button"
      role="radio"
      aria-checked={option.id === value}
      class:active={option.id === value}
      onclick={() => onChange(option.id)}
    >{option.label}</button>
  {/each}
</div>

<style>
  .segmented { display: flex; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius, 0.5rem); overflow: hidden; }
  button {
    flex: 1;
    padding: 0.35rem 0.25rem;
    border: 0;
    background: var(--caelestis-raised-surface, #eee);
    color: var(--caelestis-text);
    font: 600 0.75rem/1 var(--caelestis-font, ui-sans-serif, system-ui, sans-serif);
    cursor: pointer;
  }
  button + button { border-inline-start: 1px solid var(--caelestis-border); }
  button.active { background: var(--caelestis-primary, oklch(0.68 0.15 244)); color: white; }
  button:focus-visible { outline: 2px solid var(--caelestis-focus, currentColor); outline-offset: -2px; }
</style>
