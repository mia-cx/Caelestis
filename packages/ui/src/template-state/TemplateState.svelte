<script lang="ts">
  import type { AlarmKind } from '@caelestis/shared'
  import TemplateAlarm, { alarmLabel } from './TemplateAlarm.svelte'
  import TemplateLifecycle from './TemplateLifecycle.svelte'

  let {
    finished = false,
    frozen = false,
    griefed = false,
    descendantAlarmKind,
    alarmKind,
    pixelsLost,
    compact = false,
  }: {
    finished?: boolean
    frozen?: boolean
    griefed?: boolean
    /** The most severe active alarm among a container's descendants. */
    descendantAlarmKind?: AlarmKind | undefined
    alarmKind?: AlarmKind | undefined
    pixelsLost?: number | undefined
    compact?: boolean
  } = $props()

  const alarmed = $derived(alarmLabel({ griefed, descendantAlarmKind, alarmKind, pixelsLost }) !== null)
</script>

{#if finished || frozen || alarmed}
  <span class:compact class="states" aria-label="Template state">
    {#if finished || frozen}
      <TemplateLifecycle {finished} {frozen} />
    {/if}
    <TemplateAlarm {griefed} {descendantAlarmKind} {alarmKind} {pixelsLost} {compact} />
  </span>
{/if}

<style>
  .states {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.25rem;
    white-space: nowrap;
  }
</style>
