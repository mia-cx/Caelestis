<script lang="ts">
  import Button from '../foundations/Button.svelte'
  import Icon from '../foundations/Icon.svelte'
  import Modal from '../foundations/Modal.svelte'
  import type { BackfillIntent, BackfillModel } from './model.js'

  let { model, onIntent }: { model: BackfillModel; onIntent?: (intent: BackfillIntent) => void } = $props()
  /** A wait between archive snapshots long enough to tell the admin about. */
  const ARCHIVE_GAP_SECONDS = 36 * 3_600
  const emit = (intent: BackfillIntent): void => onIntent?.(intent)
  const running = $derived(model.job?.status === 'running')
  const selected = $derived(model.preview?.snapshots.filter((snapshot) => model.selectedSnapshot !== null && snapshot.id >= model.selectedSnapshot) ?? [])
  const gaps = $derived(selected.filter((snapshot, index) => index > 0 && snapshot.at - (selected[index - 1]?.at ?? snapshot.at) > ARCHIVE_GAP_SECONDS).length)
  const date = (at: number): string => new Date(at * 1_000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const cancel = (): void => emit({ type: running ? 'cancel' : 'close' })
</script>

<Modal labelledby="backfill-title" width="32rem" lightDismiss={false} onClose={() => emit({ type: 'close' })}>
  <header>
    <h2 id="backfill-title">{model.templates === null ? 'Backfill template tiles and progress data' : 'Backfill folder tiles and progress data'}</h2>
    <Button label="Close backfill" kind="ghost" size="small" iconOnly onclick={() => emit({ type: 'close' })}><Icon name="close" /></Button>
  </header>
  <div class="body">
    <div class="template">
      {#if model.previewUrl}<img src={model.previewUrl} alt="Selected template artwork" />{/if}
      <strong>{model.name}</strong>
    </div>
    {#if model.loading}<p role="status">Loading available snapshots…</p>{/if}
    {#if model.preview}
      <label for="backfill-from">Backfill from</label>
      <select id="backfill-from" class="caelestis-field" value={model.selectedSnapshot ?? ''} disabled={model.busy || running || model.loading}
        onchange={(event) => emit({ type: 'select', snapshotId: Number(event.currentTarget.value) })}>
        {#each model.preview.snapshots as snapshot (snapshot.id)}<option value={snapshot.id}>{date(snapshot.at)}</option>{/each}
      </select>
      <div class="coverage">
        {#if selected.length > 0}
          <p>{#if model.templates !== null}{model.templates.toLocaleString()} {model.templates === 1 ? 'template' : 'templates'} · {/if}{selected.length.toLocaleString()} available {selected.length === 1 ? 'snapshot' : 'snapshots'} · {model.preview.tileCount} {model.preview.tileCount === 1 ? 'tile' : 'tiles'} per snapshot</p>
          <p>Through {date(selected.at(-1)?.at ?? model.preview.end)}</p>
          {#if gaps > 0}<p>{gaps} {gaps === 1 ? 'gap longer' : 'gaps longer'} than 36 hours in the archive.</p>{/if}
          <p>Tile coverage is checked during import. Existing observations are preserved.</p>
        {:else}<p>No snapshots are available before {model.templates === null ? "this template's" : "these templates'"} history cutoff.</p>{/if}
      </div>
      <p class="note">Compares Eralyon snapshots with the current artwork and position. Pace shows net progress between snapshots, without painter data.</p>
    {/if}
    {#if model.job}
      <div class="job" role="status" aria-live="polite" aria-atomic="true">
        <p>{running ? 'Backfilling…' : model.job.status === 'cancelled' ? 'Backfill cancelled' : model.job.status === 'failed' ? 'Backfill finished with errors' : 'Backfill complete'}</p>
        <progress aria-label="Tiles processed" max={model.job.total} value={model.job.completed}></progress>
        <p>{model.job.completed.toLocaleString()} / {model.job.total.toLocaleString()} tile observations processed</p>
        <p>{model.job.imported.toLocaleString()} imported · {model.job.skipped.toLocaleString()} skipped · {model.job.failed.toLocaleString()} failed</p>
        {#if running}<p>Continues if you close this form. Cancel stops remaining work.</p>{:else if model.job.status === 'cancelled'}<p>Already imported observations are kept.</p>{/if}
        {#if model.job.error}<p class="error">{model.job.error}</p>{/if}
      </div>
    {/if}
    {#if model.error}<p class="error" role="alert">{model.error}</p>{/if}
  </div>
  <footer>
    {#if model.error}<Button label="Reload" kind="ghost" disabled={model.loading || model.busy} onclick={() => emit({ type: 'reload' })} />{/if}
    <Button label={model.job && !running ? 'Close' : 'Cancel'} disabled={model.busy} onclick={cancel} />
    {#if !running}<Button label={model.job?.status === 'failed' || model.job?.status === 'cancelled' ? 'Retry backfill' : 'Backfill'} kind="primary"
      disabled={model.busy || model.loading || selected.length === 0} onclick={() => emit({ type: 'start' })} />{/if}
  </footer>
</Modal>

<style>
  header, footer { display: flex; align-items: center; gap: 0.75rem; padding: 1rem; }
  header { align-items: start; border-block-end: 1px solid var(--caelestis-border); }
  h2 { margin: 0; flex: 1; font-size: 1.15rem; line-height: 1.3; }
  footer { flex-wrap: wrap; justify-content: end; border-block-start: 1px solid var(--caelestis-border); }
  .body { padding: 1rem; }
  .template { display: flex; align-items: center; gap: 1rem; margin-block-end: 1rem; }
  .template strong { overflow-wrap: anywhere; }
  img { inline-size: 4rem; block-size: 4rem; object-fit: contain; image-rendering: pixelated; background: var(--caelestis-raised-surface); border-radius: var(--caelestis-radius); }
  label { display: block; font-weight: 600; margin-block-end: 0.375rem; }
  select { box-sizing: border-box; inline-size: 100%; min-block-size: 2.5rem; padding: 0.5rem; border: 1px solid var(--caelestis-border); border-radius: var(--caelestis-radius); background: var(--caelestis-raised-surface, #eee); color: inherit; font: inherit; }
  select:focus-visible { outline: 2px solid var(--caelestis-focus); outline-offset: 2px; }
  p { margin: 0.5rem 0; }
  .coverage, .note { color: var(--caelestis-muted-text, #666); }
  .note { margin-block-start: 1rem; }
  .job { margin-block-start: 1rem; padding-block-start: 0.5rem; border-block-start: 1px solid var(--caelestis-border); font-variant-numeric: tabular-nums; }
  progress { inline-size: 100%; accent-color: var(--caelestis-primary); }
  .error { color: var(--caelestis-danger, #b22); overflow-wrap: anywhere; }
</style>
