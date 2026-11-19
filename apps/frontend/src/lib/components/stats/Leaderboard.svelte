<script lang="ts">
import { DAY_SECONDS, type LeaderboardEntry } from '@caelestis/shared'

let { entries }: { entries: readonly LeaderboardEntry[] } = $props()

const medal = (rank: number): string | null =>
  rank === 1
    ? 'text-accent'
    : rank === 2
      ? 'text-base-content/60'
      : rank === 3
        ? 'text-warning/80'
        : null

const relativeDay = (day: number): string => {
  const days = Math.floor(Date.now() / 1000 / DAY_SECONDS) - Math.floor(day / DAY_SECONDS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}
</script>

{#if entries.length === 0}
  <div class="flex h-32 items-center justify-center rounded-lg border border-dashed border-base-300 text-sm text-base-content/50">
    No contributions yet. Paint activity appears here when userscript reporting is on.
  </div>
{:else}
  <div class="overflow-x-auto">
  <table class="w-full text-sm whitespace-nowrap [&_td]:p-2 [&_td]:align-middle [&_th]:h-10 [&_th]:px-2 [&_th]:align-middle [&_th]:font-medium [&_tr]:border-b [&_tr]:transition-colors">
    <thead>
      <tr>
        <th class="w-10 text-left">#</th>
        <th class="text-left">Painter</th>
        <th class="text-right">Correct</th>
        <th class="text-right">Placed</th>
        <th class="text-right">Repairs</th>
        <th class="text-right max-sm:hidden">Active days</th>
        <th class="text-right max-sm:hidden">Last seen</th>
      </tr>
    </thead>
    <tbody class="[&_tr:last-child]:border-0 [&_tr]:hover:bg-base-200/50">
      {#each entries as entry, index (entry.wplaceUserId)}
        {@const rank = index + 1}
        <tr>
          <td class="text-xs {medal(rank) ?? 'text-base-content/50'}">{rank}</td>
          <td>
            <span class="font-medium">{entry.displayName || `user ${entry.wplaceUserId}`}</span>
            <span class="ml-1.5 text-xs text-base-content/40 tabular-nums">#{entry.wplaceUserId}</span>
          </td>
          <td class="text-right font-semibold tabular-nums">{entry.correct.toLocaleString()}</td>
          <td class="text-right tabular-nums text-base-content/70">{entry.placed.toLocaleString()}</td>
          <td class="text-right tabular-nums text-base-content/70">{entry.repairs.toLocaleString()}</td>
          <td class="text-right tabular-nums text-base-content/70 max-sm:hidden">{entry.activeDays}</td>
          <td class="text-right text-base-content/70 max-sm:hidden">{relativeDay(entry.lastDay)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  </div>
{/if}
