/**
 * Serves the static docs build. A page request that asks for Markdown, or comes from a known AI
 * agent, gets the page's Markdown copy instead: Svartz writes `/guide/` as `/guide.md` and the
 * home page as `/index.md`. A page without a copy falls back to its HTML.
 */

interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> }
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

/** Both negotiation signals pick the response, so caches must key on them. */
function varied(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.append('vary', 'Accept, User-Agent')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
  },
}
