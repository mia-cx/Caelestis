<script lang="ts" generics="Key extends string">
  import { Icon } from '@caelestis/ui'
  import { Select } from 'bits-ui'

  /**
   * The dashboard's one dropdown. The open list is page content, so it takes the page font in
   * every browser, which a native `<select>` list does not.
   */
  let {
    value,
    options,
    onValueChange,
    labelledby,
  }: {
    value: Key
    options: readonly { readonly key: Key; readonly label: string }[]
    onValueChange: (key: Key) => void
    /** Id of the visible text that names the control. */
    labelledby: string
  } = $props()

  const current = $derived(options.find((option) => option.key === value))
</script>

<Select.Root
  type="single"
  {value}
  onValueChange={(next) => {
    const option = options.find((candidate) => candidate.key === next)
    if (option !== undefined) onValueChange(option.key)
  }}
>
  <Select.Trigger
    class="btn btn-xs btn-soft w-fit gap-1.5 whitespace-nowrap"
    aria-labelledby={labelledby}
  >
    {current?.label}
    <Icon name="unfoldMore" class="pointer-events-none size-4.5 text-base-content/60" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      sideOffset={4}
      class="caelestis-menu select-content relative isolate z-50 min-w-36 overflow-x-hidden overflow-y-auto"
    >
      <Select.ScrollUpButton class="flex w-full cursor-default items-center justify-center bg-base-100 py-1">
        <Icon name="expandLess" class="size-4.5" />
      </Select.ScrollUpButton>
      <Select.Viewport class="h-(--bits-select-anchor-height) w-full min-w-(--bits-select-anchor-width) scroll-my-1">
        {#each options as option (option.key)}
          <Select.Item
            value={option.key}
            label={option.label}
            class="caelestis-menu-item w-full pr-8 data-highlighted:bg-[var(--menu-hover)]"
          >
            {#snippet children({ selected })}
              <span class="absolute end-2 flex size-3 items-center justify-center">
                {#if selected}<Icon name="check" />{/if}
              </span>
              <span class="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{option.label}</span>
            {/snippet}
          </Select.Item>
        {/each}
      </Select.Viewport>
      <Select.ScrollDownButton class="flex w-full cursor-default items-center justify-center bg-base-100 py-1">
        <Icon name="expandMore" class="size-4.5" />
      </Select.ScrollDownButton>
    </Select.Content>
  </Select.Portal>
</Select.Root>

<style>
  :global(.select-content[data-state='open']) {
    animation: select-fade 100ms ease-out;
  }
  @keyframes select-fade {
    from {
      opacity: 0;
    }
  }
</style>
