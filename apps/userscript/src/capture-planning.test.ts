import { borderBoxPlanner, NO_TEAM, type TerritoryMap } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { proposalLabel } from './capture-planning.js'

const GREEN = 2
const SIZE = 200

it('names a wall through open ground for the ground, not for the team its anchors reach into', () => {
  // Green holds the bottom half; the rest is nobody's.
  const owner = new Uint8Array(SIZE * SIZE).fill(NO_TEAM)
  owner.fill(GREEN, (SIZE / 2) * SIZE)
  const map: TerritoryMap = { size: SIZE, owner }
  const [plan] = borderBoxPlanner({ map, team: GREEN, painters: 2, guards: 0, charges: 60 })
  if (plan === undefined) throw new Error('Expected a plan')
  expect(proposalLabel(map, GREEN, plan.wall)).toMatch(/^Into open ground/)
})
