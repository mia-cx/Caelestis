import {
  createTestBackend as createBackend,
  type TestBackendOptions,
} from '@caelestis/backend/testing'

export const adminToken = 'FRONTEND-CONTRACT-ADMIN'

export const createTestBackend = (options: TestBackendOptions = {}) =>
  createBackend({ tokens: { [adminToken]: 'admin' }, ...options })

export const authorized = (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${adminToken}`)
  return new Request(`https://backend.test${path}`, { ...init, headers })
}

/** Route browser-relative frontend reads into the real built backend app. */
export const frontendFetch =
  (
    app: { readonly fetch: (request: Request) => Response | Promise<Response> },
    requests: Request[] = [],
  ): typeof fetch =>
  async (input, init) => {
    const source =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), 'https://frontend.test'), init)
    const url = new URL(source.url)
    if (url.origin !== 'https://frontend.test' && url.origin !== 'https://backend.test') {
      throw new Error(`Unsupported frontend test origin: ${url.origin}`)
    }
    const path =
      url.origin === 'https://frontend.test'
        ? url.pathname.replace(/^\/(?:api|backend)(?=\/)/, '')
        : url.pathname.replace(/^\/backend(?=\/)/, '')
    const request = new Request(`https://backend.test${path}${url.search}`, source)
    requests.push(request.clone())
    return app.fetch(request)
  }
