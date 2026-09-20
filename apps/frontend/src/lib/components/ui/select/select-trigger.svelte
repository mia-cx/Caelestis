<script lang="ts">
import { Icon } from '@caelestis/ui'
import { Select as SelectPrimitive } from 'bits-ui'
import { cn, type WithoutChild } from '$lib/utils.js'

let {
  ref = $bindable(null),
  class: className,
  children,
  size = 'default',
  ...restProps
}: WithoutChild<SelectPrimitive.TriggerProps> & {
  size?: 'sm' | 'default'
} = $props()
</script>

<SelectPrimitive.Trigger
	bind:ref
	data-slot="select-trigger"
	data-size={size}
	class={cn(
		"btn btn-xs btn-soft w-fit gap-1.5 whitespace-nowrap data-placeholder:text-base-content/60 *:data-[slot=select-value]:line-clamp-1",
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<Icon name="unfoldMore" class="size-4.5 text-base-content/60 pointer-events-none" />
</SelectPrimitive.Trigger>
