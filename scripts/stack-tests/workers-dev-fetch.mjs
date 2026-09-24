import { setTimeout as delay } from 'node:timers/promises'

/** Replay buffered test requests only when Cloudflare's router has not invoked the Worker. */
export async function workersDevFetch(url, init) {
  const attempts = 30
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init)
    if (
      response.status !== 404 ||
      !response.headers.get('content-type')?.includes('text/html') ||
      attempt === attempts - 1
    ) {
      return response
    }
    // A route can disappear at another edge after readiness succeeds. This exact edge page
    // means the request never reached the application, so even a buffered POST is safe to replay.
    const body = await response.clone().text()
    if (
      !body.includes('<title>Page not found</title>') ||
      !body.includes('https://workers.cloudflare.com/favicon.ico')
    ) {
      return response
    }
    await response.body?.cancel()
    if (attempt === 0) console.info('Waiting for workers.dev route propagation')
    await delay(1000, undefined, { signal: init?.signal })
  }
}
