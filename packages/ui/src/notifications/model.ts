export type ToastKind = 'info' | 'warning' | 'error'

export interface ToastActionModel {
  readonly label: string
  readonly href: string
}

export interface ToastModel {
  readonly id: string
  readonly kind: ToastKind
  readonly message: string
  readonly action?: ToastActionModel
}

export interface ConfirmDialogModel {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly note: string
  readonly confirmLabel: string
}

export interface OneTimeSecretDialogModel {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly copyStatus?: 'copied' | 'unavailable'
  readonly inviteUrl?: string
  readonly inviteCopyStatus?: 'copied' | 'unavailable'
  /** The secret is a one-use invite: its first holder trades it for a token of their own. */
  readonly oneUse?: true
}

export interface NotificationsModel {
  readonly toasts: readonly ToastModel[]
  readonly confirm: ConfirmDialogModel | null
  readonly oneTimeSecret?: OneTimeSecretDialogModel | null
}

export type NotificationsIntent =
  | { readonly type: 'dismiss-toast'; readonly id: string }
  | {
      readonly type: 'resolve-confirm'
      readonly id: string
      readonly value: boolean
    }
  | { readonly type: 'copy-one-time-secret'; readonly id: string }
  | { readonly type: 'copy-one-time-invite'; readonly id: string }
  | { readonly type: 'resolve-one-time-secret'; readonly id: string }
