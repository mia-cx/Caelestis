// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { findWplaceRail, findWplaceRightControls, wplaceButtonBelow } from './wplace-rail.js'

const nativeButton = (title: string): HTMLButtonElement => {
  const button = document.createElement('button')
  button.title = title
  return button
}

beforeEach(() => document.body.replaceChildren())

describe('Wplace rail discovery', () => {
  it('finds the logged-out Leaderboard and Search rail', () => {
    const accountControls = document.createElement('div')
    const login = nativeButton('')
    login.textContent = 'Log in'
    const nativeRail = document.createElement('div')
    const leaderboard = nativeButton('Leaderboard')
    const search = nativeButton('Search')
    nativeRail.append(leaderboard, search)
    accountControls.append(login, nativeRail)
    document.body.append(accountControls)

    expect(findWplaceRail()).toBe(nativeRail)
    expect(findWplaceRightControls()).toBe(accountControls)
  })

  it('prefers the Overlays rail when logged in', () => {
    const loggedOutRail = document.createElement('div')
    loggedOutRail.append(nativeButton('Search'))
    const loggedInRail = document.createElement('div')
    const overlays = nativeButton('Overlays')
    loggedInRail.append(overlays)
    document.body.append(loggedOutRail, loggedInRail)

    expect(findWplaceRail()).toBe(loggedInRail)
  })
})

const placedButton = (title: string, box: { left: number; top: number }): HTMLButtonElement => {
  const button = nativeButton(title)
  button.getBoundingClientRect = () =>
    ({ ...box, width: 40, height: 40, right: box.left + 40, bottom: box.top + 40 }) as DOMRect
  return button
}

describe('Wplace buttons under the rail column', () => {
  const column = { left: 342, right: 382, top: 200 }

  it('reports the highest native button that shares the column', () => {
    const profile = placedButton('Profile', { left: 340, top: 400 })
    const location = placedButton('My location', { left: 342, top: 440 })
    const paint = placedButton('Paint', { left: 100, top: 440 })
    const above = placedButton('Overlays', { left: 342, top: 60 })
    document.body.append(paint, location, profile, above)

    expect(wplaceButtonBelow(column)).toBe(400)
  })

  it('ignores our own rail and hidden buttons', () => {
    const rail = document.createElement('div')
    rail.id = 'caelestis-rail'
    rail.append(placedButton('Caelestis', { left: 342, top: 260 }))
    const panel = document.createElement('caelestis-panel')
    panel.append(placedButton('Close', { left: 342, top: 300 }))
    const hidden = placedButton('Menu', { left: 342, top: 320 })
    hidden.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
    document.body.append(rail, panel, hidden)

    expect(wplaceButtonBelow(column)).toBeNull()
  })
})
