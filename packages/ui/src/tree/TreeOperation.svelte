<script lang="ts">
  import type { TemplateTreeIntent, TreeOperationModel } from './model.js'

  /** The banner for a host operation waiting on the user, such as choosing where a move goes. */
  let { operation, emit }: { operation: TreeOperationModel; emit: (intent: TemplateTreeIntent) => void } = $props()

  let selection = $state('')
  let admittedId: string | undefined
  // A new operation starts on its first option; refreshes of the same one keep the choice.
  $effect(() => {
    if (operation.id === admittedId) return
    admittedId = operation.id
    selection = operation.options?.[0]?.value ?? ''
  })
</script>

<section class="operation" aria-live="polite" aria-busy={operation.pending === true}>
  <span>{operation.label}</span>
  {#if operation.options !== undefined}
    <select class="caelestis-select" aria-label={operation.label} bind:value={selection} disabled={operation.pending === true}>
      {#each operation.options as option}<option value={option.value}>{option.label}</option>{/each}
    </select>
  {/if}
  {#if operation.note !== undefined}<small>{operation.note}</small>{/if}
  <div class="actions">
    {#if operation.cancellable !== false}
      <button type="button" onclick={() => emit({ type: 'tree-operation-cancel', operationId: operation.id })}>Cancel</button>
    {/if}
    {#if operation.confirmLabel !== undefined}
      <button class="primary" type="button" disabled={operation.pending === true || operation.options?.length === 0} onclick={() => emit({ type: 'tree-operation-confirm', operationId: operation.id, value: selection })}>{operation.confirmLabel}</button>
    {/if}
  </div>
</section>

<style>
  .operation { display: flex; flex: 0 0 auto; flex-direction: column; gap: 0.5rem; margin: 0 0.5rem 0.5rem; padding: 0.625rem 0.75rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius); background: var(--caelestis-raised-surface); font: 500 0.75rem/1.35 var(--caelestis-font); }
  select { inline-size: 100%; }
  small { color: var(--caelestis-muted-text); }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  button { min-block-size: 2rem; border: 0; border-radius: var(--caelestis-radius); background: transparent; color: inherit; cursor: pointer; }
  button.primary { padding-inline: 0.75rem; background: var(--caelestis-primary); color: var(--caelestis-primary-text, white); }
  button:disabled { cursor: wait; opacity: 0.55; }
</style>
