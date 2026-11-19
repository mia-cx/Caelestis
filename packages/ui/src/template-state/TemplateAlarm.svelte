<script lang="ts">
  import { type AlarmKind, formatPixels } from '@caelestis/shared'

  let {
    griefed = false,
    descendantAlarmKind,
    alarmKind,
    pixelsLost,
    compact = false,
  }: {
    griefed?: boolean
    /** The most severe active alarm among a container's descendants. */
    descendantAlarmKind?: AlarmKind | undefined
    alarmKind?: AlarmKind | undefined
    pixelsLost?: number | undefined
    compact?: boolean
  } = $props()

  const alarmTitle = $derived(
    alarmKind === 'sustained-griefing'
      ? 'Sustained griefing'
      : alarmKind === 'regression'
        ? 'Regression'
        : griefed ? 'Grief detected'
        : descendantAlarmKind === 'sustained-griefing' ? 'Contains griefed templates'
        : descendantAlarmKind === 'regression' ? 'Contains templates with regression' : null,
  )
  const alarmLabel = $derived(
    alarmTitle === null
      ? null
      : `${alarmTitle}${alarmKind === undefined || pixelsLost === undefined ? '' : ` · ${formatPixels(pixelsLost)} lost`}`,
  )
</script>

{#if alarmLabel !== null}
  <span class:compact class="alarm" role="status" title={alarmLabel} aria-label={`Template alarm: ${alarmLabel}`} aria-atomic="true">
    <span class="alarm-mark" aria-hidden="true">⚠️</span>
    <span class="alarm-description">{alarmLabel}</span>
  </span>
{/if}

<style>
  .alarm {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    inline-size: 1rem;
    block-size: 1rem;
    font: 1rem/1 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
  }

  .alarm.compact { font-size: 0.875rem; }
  .alarm-description { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
