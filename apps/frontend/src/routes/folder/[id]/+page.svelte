<script lang="ts">
import { page } from '$app/state'
import { MenuStyles, ProgressMeter } from '@caelestis/ui'
import ColourProgress from '#lib/components/ColourProgress.svelte'
import FolderSection from '#lib/components/FolderSection.svelte'
import StatsPanel from '#lib/components/StatsPanel.svelte'
import TemplateCard from '#lib/components/TemplateCard.svelte'
import TimelapsePanel from '#lib/components/TimelapsePanel.svelte'
import { useApp } from '#lib/state/app.svelte.js'
import { TimelapsePlayer } from '#lib/timelapse-player.svelte.js'
import { type ColourProgress as Colours, folderPath, folderTemplates } from '@caelestis/shared'

const app = useApp()

const statusColours = (colours: readonly Colours[]) =>
  colours.map(({ index, completed, mismatched, unpainted, total }) => ({
    index,
    correct: completed,
    wrong: mismatched,
    blank: unpainted,
    total,
  }))

const folder = $derived(app.tree?.folderById.get(page.params.id ?? '') ?? null)
const templates = $derived(folder === null ? [] : folderTemplates(folder))
const player = new TimelapsePlayer(() => templates)
const ancestors = $derived(
  app.tree === null || folder === null
    ? []
    : folderPath(app.tree, folder.node.id)
        .slice(0, -1)
        .map((entry) => entry.node),
)
</script>

<MenuStyles />

<svelte:head>
  <title>{folder === null ? 'Folder' : folder.node.name} · Caelestis</title>
</svelte:head>

{#if app.tree === null}
  <div class="flex flex-col gap-4">
    <div class="skeleton h-8 w-64"></div>
    <div class="skeleton h-60 w-full rounded-2xl"></div>
  </div>
{:else if folder === null}
  <div class="rounded-2xl border-[1.5px] border-dashed border-base-300 p-10 text-center text-base-content/60">
    <p class="font-semibold">Folder not found</p>
    <a href="/" class="btn btn-sm mt-4">Back to all templates</a>
  </div>
{:else}
  <div class="flex flex-col gap-4">
    <nav class="text-sm text-base-content/60" aria-label="breadcrumb">
      <a href="/" class="link link-hover">All templates</a>
      {#each ancestors as ancestor (ancestor.id)}
        <span aria-hidden="true"> / </span>
        <a href="/folder/{ancestor.id}" class="link link-hover">{ancestor.name}</a>
      {/each}
      <span aria-hidden="true"> / </span>
      <span>{folder.node.name}</span>
    </nav>

    <header class="flex flex-wrap items-baseline justify-between gap-2">
      <h1 class="text-2xl font-bold">{folder.node.name}</h1>
      <span class="text-sm tabular-nums text-base-content/50">
        {folder.templateCount}
        {folder.templateCount === 1 ? 'template' : 'templates'}{#if folder.progress.total > 0}
          · {folder.progress.completed.toLocaleString()} of {folder.progress.total.toLocaleString()} px{/if}
      </span>
    </header>
    {#if folder.node.description}
      <p class="-mt-2 text-sm text-base-content/70">{folder.node.description}</p>
    {/if}

    {#if folder.progress.total > 0}
      <ProgressMeter progress={folder.progress} />
    {:else}
      <p class="text-sm text-base-content/50">No published templates yet.</p>
    {/if}

    {#if templates.length > 0 && app.manifest !== null}
      <TimelapsePanel {player} label={folder.node.name} />

      <StatsPanel
        {templates}
        season={app.manifest.season}
        liveDashboard={app.live}
        progress={folder.progress}
        subscribeDashboard={app.subscribeDashboard}
        playhead={player.live ? null : player.playhead}
        onSeek={player.timeline.length > 0 ? player.seekTo : undefined}
        onScrubStart={player.beginScrub}
      />
    {/if}

    {#if folder.colours !== undefined}
      <section class="pixel-card bg-base-100 p-4">
        <h2 class="mb-3 font-semibold">Progress by colour</h2>
        <ColourProgress colours={statusColours(folder.colours)} />
      </section>
    {/if}

    {#if folder.templates.length > 0}
      <section class="pixel-card bg-base-100 p-3">
        <h2 class="px-1 pb-3 font-semibold">Templates</h2>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each folder.templates as entry (entry.template.id)}
            <TemplateCard {entry} />
          {/each}
        </div>
      </section>
    {/if}

    {#each folder.folders as child (child.node.id)}
      <FolderSection folder={child} depth={1} />
    {/each}
  </div>
{/if}
