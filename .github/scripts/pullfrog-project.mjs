// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This script runs directly in GitHub Actions, outside Turborepo.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['track', 'status', 'priority', 'effort', 'blockers'],
  properties: {
    track: { type: 'boolean', description: 'Whether this issue is valid work to track.' },
    status: { type: ['string', 'null'], description: 'Exact existing option name, or null.' },
    priority: { type: ['string', 'null'], description: 'Exact existing option name, or null.' },
    effort: { type: ['number', 'null'], minimum: 0 },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

export function labelIssue(event) {
  let payload
  try {
    payload = JSON.parse(event.inputs?.prompt ?? '')
  } catch {
    return null
  }
  if (payload?.['~pullfrog'] !== true || payload.type !== 'auto-label') return null
  const number = payload.event?.issue_number
  if (!Number.isSafeInteger(number) || number < 1 || payload.event.is_pr) {
    throw new Error('Auto-label payload must identify an issue.')
  }
  return number
}

async function graphql(query, variables) {
  const token = process.env.GH_TOKEN
  if (!token) throw new Error('PULLFROG_PROJECTS_TOKEN is missing from this workflow step.')
  const response = await fetch('https://api.github.com/graphql', {
    signal: AbortSignal.timeout(30_000),
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const result = await response.json()
  if (!response.ok || result.errors) {
    // Only report GitHub's messages, never request headers or environment values.
    throw new Error(
      `Projects API (${response.status}): ${JSON.stringify(result.errors ?? result.message)}`,
    )
  }
  return result.data
}

const itemFields = `id project { id } fieldValues(first: 100) {
  pageInfo { hasNextPage }
  nodes {
    ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { id } } }
    ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id } } }
  }
}`

export async function readContext(repository, number, projectUrl, api = graphql) {
  const match = /^https:\/\/github\.com\/(users|orgs)\/([^/]+)\/projects\/([1-9]\d*)\/?$/.exec(
    projectUrl ?? '',
  )
  if (!match)
    throw new Error('Set PULLFROG_PRIMARY_PROJECT_URL to this repository’s primary project URL.')
  const [owner, name] = repository.split('/')
  const projectOwnerType = match[1] === 'users' ? 'user' : 'organization'
  const data = await api(
    `query($owner:String!,$name:String!,$issue:Int!,$login:String!,$project:Int!) {
    repository(owner:$owner,name:$name) { id issue(number:$issue) { id url } }
    ${projectOwnerType}(login:$login) { projectV2(number:$project) {
      id title url
      fields(first:100) { pageInfo { hasNextPage } nodes {
        ... on ProjectV2Field { id name dataType }
        ... on ProjectV2SingleSelectField { id name dataType options { id name } }
      } }
    } }
  }`,
    { owner, name, issue: number, login: match[2], project: Number(match[3]) },
  )
  const issue = data.repository?.issue
  const project = data[projectOwnerType]?.projectV2
  if (!issue || !project)
    throw new Error('Issue or primary project is inaccessible with the Projects PAT.')
  if (project.fields.pageInfo.hasNextPage)
    throw new Error('Project has more than 100 fields; refusing an incomplete schema.')
  let cursor = null
  let item = null
  do {
    const result = await api(
      `query($id:ID!,$cursor:String) {
      node(id:$id) { ... on Issue { projectItems(first:100,after:$cursor) {
        pageInfo { hasNextPage endCursor } nodes { ${itemFields} }
      } } }
    }`,
      { id: issue.id, cursor },
    )
    const items = result.node.projectItems
    item = items.nodes.find((entry) => entry.project.id === project.id) ?? item
    cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null
  } while (cursor)
  if (item?.fieldValues.pageInfo.hasNextPage)
    throw new Error('Project item has too many fields to inspect safely.')
  return { repository, issue, project: { ...project, fields: project.fields.nodes }, item }
}

/** Resolve proposed triage values while preserving populated project fields. */
export function fieldUpdates(context, decision) {
  if (typeof decision.track !== 'boolean' || !Array.isArray(decision.blockers)) {
    throw new Error('Missing structured project triage output.')
  }
  const updates = []
  for (const [key, fieldName] of [
    ['status', 'Status'],
    ['priority', 'Priority'],
    ['effort', 'Effort'],
  ]) {
    const proposed = decision[key]
    if (proposed === null) continue
    const field = context.project.fields.find((entry) => entry.name === fieldName)
    if (!field) continue
    const current = context.item?.fieldValues.nodes.find((entry) => entry.field?.id === field.id)
    // Existing values belong to maintainers. Automation fills empty fields only.
    if (current && (current.name != null || current.number != null)) continue
    if (key === 'effort') {
      if (field.dataType !== 'NUMBER' || !Number.isFinite(proposed) || proposed < 0) {
        throw new Error('Effort must be a nonnegative number in an existing numeric field.')
      }
      updates.push({ fieldId: field.id, value: { number: proposed }, expected: proposed })
    } else {
      const option = field.options?.find((entry) => entry.name === proposed)
      if (!option) throw new Error(`Unknown ${fieldName} option: ${proposed}`)
      updates.push({
        fieldId: field.id,
        value: { singleSelectOptionId: option.id },
        expected: proposed,
      })
    }
  }
  return updates
}

/** Add the issue idempotently, apply empty-field decisions, and read every write back. */
export async function applyTriage(context, decision, api = graphql) {
  const updates = fieldUpdates(context, decision)
  if (!decision.track) return 'No project changes requested.'
  let itemId = context.item?.id
  if (!itemId) {
    const data = await api(
      `mutation($project:ID!,$issue:ID!) {
      addProjectV2ItemById(input:{projectId:$project,contentId:$issue}) { item { id } }
    }`,
      { project: context.project.id, issue: context.issue.id },
    )
    itemId = data.addProjectV2ItemById.item.id
  }
  for (const update of updates) {
    await api(
      `mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}) { projectV2Item { id } }
    }`,
      { project: context.project.id, item: itemId, field: update.fieldId, value: update.value },
    )
  }
  const verified = await api(
    `query($id:ID!) { node(id:$id) { ... on ProjectV2Item { ${itemFields} content { ... on Issue { id } } } } }`,
    { id: itemId },
  )
  if (
    verified.node?.project.id !== context.project.id ||
    verified.node?.content?.id !== context.issue.id
  ) {
    throw new Error('Project membership verification failed.')
  }
  for (const update of updates) {
    const actual = verified.node.fieldValues.nodes.find(
      (entry) => entry.field?.id === update.fieldId,
    )
    if ((actual?.name ?? actual?.number) !== update.expected)
      throw new Error('Project field verification failed.')
  }
  return `Verified ${context.issue.url} in ${context.project.url}; updated ${updates.length} empty fields.`
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const number = labelIssue(event)
  const mode = process.argv[2]
  if (mode === 'route') {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `triage=${number !== null}\nschema=${number === null ? '' : JSON.stringify(outputSchema)}\n`,
    )
    return
  }
  if (number === null) throw new Error('Projects step may only run for an auto-label issue event.')
  const context = await readContext(
    process.env.GITHUB_REPOSITORY,
    number,
    process.env.PULLFROG_PRIMARY_PROJECT_URL,
  )
  if (mode === 'prepare') {
    writeFileSync(
      `${process.env.RUNNER_TEMP}/pullfrog-project.json`,
      JSON.stringify(context, null, 2),
    )
    return
  }
  if (mode !== 'apply') throw new Error(`Unknown command: ${mode}`)
  const decision = JSON.parse(process.env.TRIAGE_RESULT || 'null')
  if (!decision) throw new Error('Pullfrog did not return required project triage output.')
  const summary = await applyTriage(context, decision)
  console.log(summary)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  if (decision.blockers.length) {
    throw new Error(`Unresolved project triage: ${decision.blockers.join('; ')}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
