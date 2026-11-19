/**
 * Serves the static docs build. A page request that asks for Markdown, or comes from a known AI
 * agent, gets the page's Markdown copy instead: Svartz writes `/guide/` as `/guide.md` and the
 * home page as `/index.md`. A page without a copy falls back to its HTML.
 */

interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
  /** Set on staging, so search engines leave its copy of the production docs out. */
  readonly NOINDEX?: string
}

/** Crawlers and fetchers of AI assistants that read pages for a model, by user-agent token. */
const AGENT =
  /\b(?:ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|GPTBot|ChatGPT-User|OAI-SearchBot|PerplexityBot|Perplexity-User|Google-Extended|Gemini-Deep-Research|meta-externalagent|MistralAI-User|DuckAssistBot|cohere-ai|Amazonbot|Applebot-Extended|CCBot|Bytespider)\b/i

const wantsMarkdown = (request: Request): boolean =>
  /\btext\/markdown\b/i.test(request.headers.get('accept') ?? '') ||
  AGENT.test(request.headers.get('user-agent') ?? '')

/** The Markdown copy of a page path, or undefined for a file such as `/llms.txt`. */
function markdownPath(pathname: string): string | undefined {
  if (pathname === '/') return '/index.md'
  if (/\.[^/]+$/.test(pathname)) return undefined
  return `${pathname.replace(/\/$/, '')}.md`
}

/** A copy of the response with edited headers; asset responses have immutable ones. */
function withHeaders(response: Response, edit: (headers: Headers) => void): Response {
  const headers = new Headers(response.headers)
  edit(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Both negotiation signals pick the response, so caches must key on them. */
const varied = (response: Response): Response =>
  withHeaders(response, (headers) => headers.append('vary', 'Accept, User-Agent'))

async function serve(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const markdown = markdownPath(url.pathname)
  if (markdown === undefined || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return env.ASSETS.fetch(request)
  }
  if (wantsMarkdown(request)) {
    const copy = await env.ASSETS.fetch(new Request(new URL(markdown, url), request))
    if (copy.ok) {
      const response = varied(copy)
      response.headers.set('content-type', 'text/markdown; charset=utf-8')
      return response
    }
  }
  return varied(await env.ASSETS.fetch(request))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await serve(request, env)
    if (!env.NOINDEX) return response
    return withHeaders(response, (headers) => headers.set('x-robots-tag', 'noindex'))
  },
}
