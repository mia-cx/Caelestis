import type { IconName } from '../foundations/icons.svelte.js'

/** A round rail button; hosts listen for its native `click`. */
export interface RailControlModel {
  readonly icon: IconName
  readonly label: string
  readonly title?: string
  readonly busy?: boolean
  readonly pressed?: boolean
  readonly expanded?: boolean
  readonly controls?: string
  readonly popup?: 'dialog' | 'menu'
  readonly badge?: number
  readonly disabled?: boolean
  readonly danger?: boolean
}
