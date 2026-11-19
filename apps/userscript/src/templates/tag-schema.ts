import type { TemplateTag } from '@caelestis/shared'
import { LOCAL_TAGS_STORE } from './caelestis-db.js'

/** A tag as this browser stores it: the tag and what it is assigned to. */
export interface LocalTag extends TemplateTag {
  readonly templateIds: readonly string[]
  readonly folderIds?: readonly string[]
}

/** Unassign a deleted template from every local tag, inside the transaction that deletes it. */
export const forgetTemplateTags = (transaction: IDBTransaction, templateId: string): void => {
  const cursorRequest = transaction.objectStore(LOCAL_TAGS_STORE).openCursor()
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (cursor === null) return
    const tag = cursor.value as { templateIds: string[] }
    if (tag.templateIds.includes(templateId))
      cursor.update({ ...tag, templateIds: tag.templateIds.filter((id) => id !== templateId) })
    cursor.continue()
  }
}
