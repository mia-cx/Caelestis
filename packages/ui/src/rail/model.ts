export type RailControlId =
  | 'panel'
  | 'more'
  | 'alliance-panel'
  | 'colour'
  | 'mismatch'
  | 'claim'
  | 'presence'
  | 'overlay-menu'
  | 'overlay-finished'
  | 'overlay-frozen'
  | 'overlay-visible'
  | 'overlay-move'
  | 'overlay-delete'
  | 'placement-apply'
  | 'placement-cancel'

export interface RailControlModel {
  readonly id: RailControlId
  readonly control?: string
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

export type RailControlIntent = { readonly type: 'activate'; readonly id: RailControlId }
