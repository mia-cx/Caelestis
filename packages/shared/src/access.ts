/**
 * Access-token scopes, ordered: each one grants everything below it.
 *
 * `event_runner` is no longer minted and grants nothing beyond `report`: anyone who can write hosts
 * capture lobbies now. It stays so tokens and invites minted by backend 1.6.0 keep working, until a
 * later release drops it from storage (#984).
 */
export const SCOPES = ['read', 'report', 'event_runner', 'admin'] as const

export type Scope = (typeof SCOPES)[number]

/** The longest name a server, template, node or tag may carry. */
export const MAX_NAME_LENGTH = 256

/**
 * The longest a node's materialized path may be. The `nodes_path_check` CHECK, the node store and
 * the wire's `NodePath` all read this one bound.
 */
export const MAX_NODE_PATH_LENGTH = 256

/** The longest free-text description a server or work region may carry. */
export const MAX_DESCRIPTION_LENGTH = 4_096

/**
 * Whether `held` satisfies `required`.
 *
 * Scopes are a ladder, not a set: admin manages tokens and templates, so refusing it a read it could
 * grant itself in one request buys nothing. The ordering is the whole rule — a `read` holder must
 * never satisfy `report`, which is what stops someone who obtained read access from poisoning the
 * counters.
 */
export const satisfiesScope = (held: Scope, required: Scope): boolean =>
  SCOPES.indexOf(held) >= SCOPES.indexOf(required)
