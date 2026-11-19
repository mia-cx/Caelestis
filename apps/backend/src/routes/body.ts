/**
 * Read at most `limit` bytes of a request body, or null when it is longer. Bytes are counted as
 * they stream, so a body without `Content-Length`, or with a false one, is bounded all the same.
 */
export const readBoundedBody = async (
  request: Request,
  limit: number,
): Promise<Uint8Array | null> => {
  if (Number(request.headers.get('content-length')) > limit) return null
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/** `readBoundedBody` decoded as UTF-8 text. */
export const readBoundedText = async (request: Request, limit: number): Promise<string | null> => {
  const body = await readBoundedBody(request, limit)
  return body === null ? null : new TextDecoder().decode(body)
}
