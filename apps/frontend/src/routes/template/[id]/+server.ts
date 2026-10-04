import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

// Discord never fetches a bare /template/<id> URL, so pages moved to /artwork/.
// Keep old links working with a permanent redirect that preserves the query string.
const forward: RequestHandler = async ({ params, url }) => {
  redirect(308, `/artwork/${encodeURIComponent(params.id)}${url.search}`)
}

export const GET = forward
export const HEAD = forward
