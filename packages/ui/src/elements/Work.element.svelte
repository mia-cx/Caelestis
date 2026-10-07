<svelte:options customElement={{ shadow: 'open', props: { model: { type: 'Object' } } }} />

<script lang="ts">
  import WorkBoard from '../work/WorkBoard.svelte'
  import PixelStyles from '../foundations/PixelStyles.svelte'
  import type { WorkModel } from '../work/model.js'
  let { model }: { model: WorkModel } = $props()
</script>

<WorkBoard {model} />

<PixelStyles />

<style>
  :host {
    display: block;
    min-width: 0;
  }
</style>
