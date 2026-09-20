<script lang="ts">
import { Icon } from '@caelestis/ui'
import { Select as SelectPrimitive } from 'bits-ui'
import { cn, type WithoutChild } from '$lib/utils.js'

let {
  ref = $bindable(null),
  class: className,
  value,
  label,
  children: childrenProp,
  ...restProps
}: WithoutChild<SelectPrimitive.ItemProps> = $props()
</script>

<SelectPrimitive.Item
	bind:ref
	{value}
	data-slot="select-item"
	class={cn(
		"caelestis-menu-item w-full pr-8 data-highlighted:bg-[var(--menu-hover)] data-[disabled]:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{#snippet children({ selected, highlighted })}
		<span class="absolute end-2 flex size-3 items-center justify-center">
			{#if selected}
				<Icon name="check" class="cn-select-item-indicator-icon" />
			{/if}
		</span>
		<span class="flex flex-1 gap-2 shrink-0 whitespace-nowrap">
			{#if childrenProp}
				{@render childrenProp({ selected, highlighted })}
			{:else}
				{label || value}
			{/if}
		</span>
	{/snippet}
</SelectPrimitive.Item>
