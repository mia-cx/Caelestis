/** The focused element, looking through open shadow roots to the innermost one. */
export const deepActiveElement = (): HTMLElement | null => {
  let active = document.activeElement
  while (active instanceof HTMLElement) {
    const nested = active.shadowRoot?.activeElement
    if (!(nested instanceof HTMLElement)) break
    active = nested
  }
  return active instanceof HTMLElement ? active : null
}
