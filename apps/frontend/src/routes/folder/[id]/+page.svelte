<script lang="ts">
import { folderPath, folderTemplates } from '@caelestis/shared'
import { page } from '$app/state'
import FolderSection from '#lib/components/FolderSection.svelte'
import ScopePage from '#lib/components/ScopePage.svelte'
import TemplateCard from '#lib/components/TemplateCard.svelte'
import { useApp } from '#lib/state/app.svelte.js'

const app = useApp()

const folder = $derived(app.tree?.folderById.get(page.params.id ?? '') ?? null)
const scope = $derived.by(() => {
  if (folder === null || app.tree === null) return null
  return {
    title: folder.node.name,
    ancestors: folderPath(app.tree, folder.node.id)
      .slice(0, -1)
      .map((entry) => entry.node),
    templates: folderTemplates(folder),
    progress: folder.progress,
    colours: folder.colours,
  }
})
</script>

<ScopePage {scope}>
  {#snippet notFound()}
    <p class="font-semibold">Folder not found</p>
  {/snippet}
  {#snippet header()}
    {#if folder !== null}
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
    {/if}
  {/snippet}

  {#if folder !== null}
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
  {/if}
</ScopePage>
