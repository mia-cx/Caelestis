<script lang="ts">
import { Icon } from '@caelestis/ui'
import { Select } from 'bits-ui'

let { value, label }: { value: string; label: string } = $props()
</script>

<Select.Item {value} {label} class="caelestis-menu-item w-full pr-8 data-highlighted:bg-[var(--menu-hover)]">
	{#snippet children({ selected })}
		<span class="absolute end-2 flex size-3 items-center justify-center">
			{#if selected}<Icon name="check" />{/if}
		</span>
		<span class="flex flex-1 shrink-0 gap-2 whitespace-nowrap">{label}</span>
	{/snippet}
</Select.Item>
