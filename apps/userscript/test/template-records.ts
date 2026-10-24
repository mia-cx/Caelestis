import { openTemplateDatabase } from '../src/templates/persist.js'

const STORE = 'local-templates'

/** A local template record exactly as IndexedDB holds it. */
export const rawRecord = async (id: string): Promise<Record<string, unknown> | undefined> => {
  const db = await openTemplateDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(id)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

/** Write a local template record as is, as an older build or damage would have left it. */
export const putRaw = async (record: Record<string, unknown>): Promise<void> => {
  const db = await openTemplateDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}
