<script lang="ts">
import { type HomeCopyInline, parseHomeCopy } from '@caelestis/shared'

let { copy }: { copy: string } = $props()

// Rendered from parsed blocks, never as HTML: an operator's text can only ever become text nodes,
// the marks below, and http links.
const blocks = $derived.by(() => {
  const result = parseHomeCopy(copy)
  return result.ok ? result.blocks : []
})
</script>

{#snippet inlines(items: readonly HomeCopyInline[])}
  {#each items as inline, index (index)}
    {#if inline.type === 'strong'}
      <strong>{inline.text}</strong>
    {:else if inline.type === 'em'}
      <em>{inline.text}</em>
    {:else if inline.type === 'link'}
      <a href={inline.href} target="_blank" rel="noreferrer nofollow" class="link link-primary">{inline.text}</a>
    {:else}
      {inline.text}
    {/if}
  {/each}
{/snippet}

{#if blocks.length > 0}
  <div class="flex flex-col gap-2 text-sm leading-relaxed">
    {#each blocks as block, index (index)}
      {#if block.type === 'heading'}
        <h3 class="pt-1 font-semibold text-base">{@render inlines(block.inlines)}</h3>
      {:else if block.type === 'list'}
        <ul class="list-disc space-y-1 pl-5">
          {#each block.items as item, itemIndex (itemIndex)}
            <li>{@render inlines(item)}</li>
          {/each}
        </ul>
      {:else}
        <p>{@render inlines(block.inlines)}</p>
      {/if}
    {/each}
  </div>
{/if}
