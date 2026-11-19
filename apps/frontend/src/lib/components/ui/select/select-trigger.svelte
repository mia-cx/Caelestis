<script lang="ts">
import { Icon } from '@caelestis/ui'
import { Select } from 'bits-ui'

let { children, size: _size, ...restProps }: Select.TriggerProps & { size?: 'sm' } = $props()
</script>

<Select.Trigger class="btn btn-xs btn-soft w-fit gap-1.5 whitespace-nowrap" {...restProps}>
	{@render children?.()}
	<Icon name="unfoldMore" class="pointer-events-none size-4.5 text-base-content/60" />
</Select.Trigger>
