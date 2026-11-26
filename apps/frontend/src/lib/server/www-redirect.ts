import { DASHBOARD_ORIGIN } from '../deployment.js'

export function redirectWww(url: URL): Response | undefined {
  if (url.hostname === 'www.caelest.is') {
    return Response.redirect(`${DASHBOARD_ORIGIN}${url.pathname}${url.search}`, 301)
  }
}
