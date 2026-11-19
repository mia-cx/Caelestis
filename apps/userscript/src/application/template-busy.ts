import { isDeletingLocal } from '../templates/local-store.js'
import { movingId } from '../templates/move.js'

/**
 * What a template is in the middle of, for workflows that must not start on it meanwhile.
 *
 * - `placing`: a placement owns its origin, so the stored one is the position being dragged away
 *   from. Copying, exporting or replacing from it would publish a position nobody chose.
 * - `deleting`: a delete has started from some surface. The record stays readable until storage
 *   catches up, so "is it still there" does not answer "may I start on it".
 */
export type TemplateHold = 'placing' | 'deleting'

/** Deletes the store does not track itself, such as a server delete from the overlay menu. */
const deleting = new Set<string>()

export const templateBusy = (id: string, hold: TemplateHold): boolean =>
  hold === 'placing' ? movingId() === id : deleting.has(id) || isDeletingLocal(id)

/** Hold `id` as deleting until the returned release runs. */
export const holdDeleting = (id: string): (() => void) => {
  deleting.add(id)
  return () => {
    deleting.delete(id)
  }
}

/**
 * The refusal for starting `action` (such as "copying it") on a template being placed, or null
 * when it is free to start.
 */
export const busyRefusal = (
  template: { readonly id: string; readonly name: string },
  action: string,
): string | null =>
  templateBusy(template.id, 'placing')
    ? `Finish placing “${template.name}” before ${action}.`
    : null
