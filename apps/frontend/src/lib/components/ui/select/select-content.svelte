<script lang="ts">
import { Select } from 'bits-ui'

let { children }: { children?: import('svelte').Snippet } = $props()
</script>

<Select.Portal>
	<Select.Content
		sideOffset={4}
		class="caelestis-menu select-content relative isolate z-50 min-w-36 overflow-x-hidden overflow-y-auto"
	>
		<Select.Viewport class="h-(--bits-select-anchor-height) w-full min-w-(--bits-select-anchor-width) scroll-my-1">
			{@render children?.()}
		</Select.Viewport>
	</Select.Content>
</Select.Portal>
