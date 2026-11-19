<script lang="ts" module>
  import { type AlarmKind, formatPixels } from '@caelestis/shared'

  export interface AlarmState {
    readonly griefed?: boolean
    /** The most severe active alarm among a container's descendants. */
    readonly descendantAlarmKind?: AlarmKind | undefined
    readonly alarmKind?: AlarmKind | undefined
    readonly pixelsLost?: number | undefined
  }

  /** What the alarm badge says, or null when there is no alarm to show. */
  export const alarmLabel = ({ griefed = false, descendantAlarmKind, alarmKind, pixelsLost }: AlarmState): string | null => {
    const title =
      alarmKind === 'sustained-griefing' ? 'Sustained griefing'
      : alarmKind === 'regression' ? 'Regression'
      : griefed ? 'Grief detected'
      : descendantAlarmKind === 'sustained-griefing' ? 'Contains griefed templates'
      : descendantAlarmKind === 'regression' ? 'Contains templates with regression'
      : null
    if (title === null) return null
    return alarmKind === undefined || pixelsLost === undefined ? title : `${title} · ${formatPixels(pixelsLost)} lost`
  }
</script>

<script lang="ts">
  let { compact = false, ...state }: AlarmState & { compact?: boolean } = $props()

  const label = $derived(alarmLabel(state))
</script>

{#if label !== null}
  <span class:compact class="alarm" role="status" title={label} aria-label={`Template alarm: ${label}`} aria-atomic="true">
    <span class="alarm-mark" aria-hidden="true">⚠️</span>
    <span class="alarm-description">{label}</span>
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
