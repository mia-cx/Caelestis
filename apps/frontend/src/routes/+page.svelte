<script lang="ts">
import { Icon } from '@caelestis/ui'
import FolderSection from '$lib/components/FolderSection.svelte'
import HomeCopy from '$lib/components/HomeCopy.svelte'
import TemplateCard from '$lib/components/TemplateCard.svelte'
import { Skeleton } from '$lib/components/ui/skeleton'
import { useApp } from '$lib/state/app.svelte'

const app = useApp()
const tree = $derived(app.tree)
const homeCopy = $derived(app.server?.homeCopy)
const discordInviteUrl = $derived(app.server?.discordInviteUrl)
const serverName = $derived(app.server?.name ?? 'Caelestis')
const activeAlarms = $derived([...app.alarms.values()])
const sustainedAlarms = $derived(
  activeAlarms.filter((alarm) => alarm.kind === 'sustained-griefing').length,
)
</script>

{#if app.error !== null}
  <div class="alert alert-error">
    <span>Could not reach the template server. {app.error}</span>
    <button class="btn btn-sm" onclick={() => app.load()}>Retry</button>
  </div>
{:else if tree === null}
  <!-- The real layout minus the data: folder sections. -->
  <div class="flex flex-col gap-4">
    <Skeleton class="h-40 w-full rounded-2xl" />
    <Skeleton class="h-40 w-full rounded-2xl" />
  </div>
{:else}
  <div class="flex flex-col gap-4">
    {#if homeCopy !== undefined || discordInviteUrl !== undefined}
      <section
        class="flex flex-col gap-3 rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-4 sm:flex-row sm:items-start sm:justify-between"
        aria-label={`About ${serverName}`}
      >
        <div class="min-w-0 flex-1">
          {#if homeCopy !== undefined}
            <HomeCopy copy={homeCopy} />
          {:else}
            <p class="text-sm text-base-content/70">Paint with {serverName} on Wplace.</p>
          {/if}
        </div>
        {#if discordInviteUrl !== undefined}
          <a
            href={discordInviteUrl}
            target="_blank"
            rel="noreferrer"
            class="btn btn-primary btn-sm shrink-0 gap-1.5 rounded-lg"
          >
            <Icon name="discord" class="size-4" />
            Join {serverName} on Discord
          </a>
        {/if}
      </section>
    {/if}
    {#if activeAlarms.length > 0}
      <div class="alert alert-error" role="status">
        <span>
          {activeAlarms.length} active {activeAlarms.length === 1 ? 'template warning' : 'template warnings'}{#if sustainedAlarms > 0}
            · {sustainedAlarms} sustained {sustainedAlarms === 1 ? 'griefing alarm' : 'griefing alarms'}{/if}
        </span>
      </div>
    {/if}
    {#each tree.folders as folder (folder.node.id)}
      <FolderSection {folder} canvas={app.canvas} />
    {/each}

    {#if tree.templates.length > 0}
      <section class="rounded-2xl border-[1.5px] border-base-300 bg-base-100 p-3">
        <h2 class="px-1 pb-3 font-semibold">Ungrouped templates</h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each tree.templates as entry (entry.template.id)}
            <TemplateCard {entry} canvas={app.canvas} />
          {/each}
        </div>
      </section>
    {/if}

    {#if tree.templateCount === 0}
      <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
        <p class="font-semibold">No templates yet</p>
        <p class="mt-1 text-sm">
          Upload templates in the userscript. Their canvas progress will appear here.
        </p>
      </div>
    {/if}
  </div>
{/if}
