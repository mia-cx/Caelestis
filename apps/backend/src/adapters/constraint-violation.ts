import { causes } from '../runtime/errors.js'

export type ConstraintKind = 'unique' | 'foreign-key' | 'check'

/**
 * A write the database refused for breaking an integrity constraint. Each connection throws this
 * in place of its driver's error, so stores match on kind and name rather than message text.
 *
 * `constraint` is the name the database reports, which differs per schema: SQLite names an
 * expression index (`nodes_world_path_idx`) but reports a plain unique index by its columns
 * (`tags.name_key`), and names no foreign key at all (null).
 */
export class ConstraintViolation extends Error {
  override readonly name = 'ConstraintViolation'

  constructor(
    readonly kind: ConstraintKind,
    readonly constraint: string | null,
    options?: ErrorOptions,
  ) {
    super(`${kind} constraint ${constraint ?? '(unnamed)'} failed`, options)
  }
}

const SQLITE_CONSTRAINT =
  /\b(UNIQUE|FOREIGN KEY|CHECK) constraint failed(?:: (?:index '([^']+)'|([\w.]+(?:, [\w.]+)*)))?/

/** SQLite's constraint message, which D1 also raises, as a typed violation; null for any other. */
export const sqliteConstraintViolation = (error: unknown): ConstraintViolation | null => {
  if (!(error instanceof Error)) return null
  const match = SQLITE_CONSTRAINT.exec(error.message)
  if (match === null) return null
  const kind = match[1] === 'UNIQUE' ? 'unique' : match[1] === 'CHECK' ? 'check' : 'foreign-key'
  return new ConstraintViolation(kind, match[2] ?? match[3] ?? null, { cause: error })
}

/**
 * The violation anywhere in `error`'s cause chain. Drizzle wraps every driver error, and D1 adds
 * its own wrapper on top; D1 is a platform binding rather than one of our connections, so its
 * SQLite text is translated here.
 */
const constraintViolation = (error: unknown): ConstraintViolation | null => {
  for (const cause of causes(error)) {
    if (cause instanceof ConstraintViolation) return cause
    const fromSqlite = sqliteConstraintViolation(cause)
    if (fromSqlite !== null) return fromSqlite
  }
  return null
}

/** Whether `error` broke a `kind` constraint, and when `names` is given, one of those. */
export const violates = (
  error: unknown,
  kind: ConstraintKind,
  names?: readonly string[],
): boolean => {
  const violation = constraintViolation(error)
  if (violation?.kind !== kind) return false
  return (
    names === undefined || (violation.constraint !== null && names.includes(violation.constraint))
  )
}
