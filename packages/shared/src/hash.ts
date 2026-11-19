/** Lowercase hexadecimal SHA-256, suitable for content-addressed blob keys. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Copying narrows ArrayBufferLike to ArrayBuffer for the DOM BufferSource type while preserving
  // support for callers whose view originated from a SharedArrayBuffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A lowercase SHA-256 hex digest, the form `sha256Hex` produces. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export const isSha256Hex = (value: unknown): value is string =>
  typeof value === 'string' && SHA256_HEX_PATTERN.test(value)
