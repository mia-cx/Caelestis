<script lang="ts" generics="T extends string">
  /**
   * A row of mutually exclusive choices, such as an effect's channel. `value` is the chosen one,
   * or null when none fits, as Colours' presets once colours are picked by hand. An option can be
   * unavailable, with `title` saying why. Styled by the studio's `.choices`.
   */
  let {
    label,
    value,
    options,
    onChange,
  }: {
    label: string
    value: T | null
    options: readonly {
      readonly id: T
      readonly label: string
      readonly disabled?: boolean
      readonly title?: string | undefined
    }[]
    onChange: (value: T) => void
  } = $props()
</script>

<div class="choices" role="radiogroup" aria-label={label}>
  {#each options as option (option.id)}
    <button
      type="button"
      class="choice caelestis-bevel"
      role="radio"
      aria-checked={option.id === value}
      disabled={option.disabled}
      title={option.title}
      onclick={() => onChange(option.id)}
    >{option.label}</button>
  {/each}
</div>
