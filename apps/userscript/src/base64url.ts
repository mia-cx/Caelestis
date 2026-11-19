/** Unpadded base64url (RFC 4648 §5) of a string's UTF-8 bytes. */
export const encodeBase64Url = (text: string): string => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The UTF-8 text in unpadded base64url, or null when it is not valid base64url of valid UTF-8. */
export const decodeBase64Url = (encoded: string): string | null => {
  // A length of 1 mod 4 can never decode.
  if (encoded.length % 4 === 1) return null
  let binary: string
  try {
    binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
  } catch {
    return null
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
