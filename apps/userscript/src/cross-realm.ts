/** Cross-realm Uint8Array check for values returned by page-owned browser APIs such as IndexedDB. */
export const isUint8Array = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'

export interface StoredBlob {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Structural Blob check for values returned through a different browser/userscript realm. */
export const isStoredBlob = (value: unknown): value is StoredBlob =>
  typeof value === 'object' &&
  value !== null &&
  Number.isSafeInteger((value as StoredBlob).size) &&
  (value as StoredBlob).size >= 0 &&
  typeof (value as StoredBlob).arrayBuffer === 'function'
