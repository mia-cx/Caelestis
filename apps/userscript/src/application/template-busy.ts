import { isDeletingLocal } from '../templates/catalog.js'
import { movingId } from '../templates/move.js'
import { isLeasedLocal } from '../templates/template-edits.js'

/**
 * What a template is in the middle of, for workflows that must not start on it meanwhile.
 *
 * - `placing`: a placement owns its origin, so the stored one is the position being dragged away
 *   from. Copying, exporting or replacing from it would publish a position nobody chose.
 * - `deleting`: a delete has started from some surface. The record stays readable until storage
 *   catches up, so "is it still there" does not answer "may I start on it".
 * - `updating`: its artwork is being captured or saved as a new version.
 * - `leased`: a transfer keeps a Local copy it is still committing, so it cannot be deleted yet.
 */
type TemplateHold = 'placing' | 'deleting' | 'updating' | 'leased'

/** Deletes the store does not track itself, such as a server delete from the overlay menu. */
const deleting = new Set<string>()
const updating = new Set<string>()

export const templateBusy = (id: string, hold: TemplateHold): boolean => {
  switch (hold) {
    case 'placing':
      return movingId() === id
    case 'deleting':
      return deleting.has(id) || isDeletingLocal(id)
    case 'updating':
      return updating.has(id)
    case 'leased':
      return isLeasedLocal(id)
  }
}

const holdIn =
  (held: Set<string>) =>
  (id: string): (() => void) => {
    held.add(id)
    return () => {
      held.delete(id)
    }
  }

/** Hold `id` as deleting until the returned release runs. */
export const holdDeleting = holdIn(deleting)

/** Hold `id` as updating until the returned release runs. */
export const holdUpdating = holdIn(updating)

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
