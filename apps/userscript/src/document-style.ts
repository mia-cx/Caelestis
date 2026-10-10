/**
 * Add a `<style>` to the document as soon as `<html>` exists. Safe at `document-start`.
 *
 * A plain element, not `document.adoptedStyleSheets`: a constructed sheet belongs to the realm
 * that built it, and a userscript manager's sandbox is not the page's realm, so adopting one from
 * there can fail outright. An element works from any world.
 */
export const addDocumentStyle = (css: string): void => {
  const style = document.createElement('style')
  style.textContent = css
  const attach = (): boolean => {
    if (document.documentElement === null) return false
    document.documentElement.append(style)
    return true
  }
  if (attach()) return
  const observer = new MutationObserver(() => {
    if (attach()) observer.disconnect()
  })
  observer.observe(document, { childList: true })
}
