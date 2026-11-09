<script lang="ts">
  import Toggle from '../foundations/Toggle.svelte'

  /** A yes/no setting: its label, the switch at the row's end, and an optional hint below. */
  let {
    label,
    hint,
    checked,
    disabled = false,
    onChange,
  }: {
    label: string
    hint?: string | undefined
    checked: boolean
    disabled?: boolean
    onChange: (checked: boolean) => void
  } = $props()
</script>

<!-- The whole row is the switch's label, so its text flips it too. -->
<label class="switch-row">
  <span class="field-label">{label}</span>
  <Toggle {label} {checked} {disabled} {onChange} />
  {#if hint !== undefined}<span class="hint">{hint}</span>{/if}
</label>
