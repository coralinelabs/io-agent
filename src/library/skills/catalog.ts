/** One metadata model for startup previews and searchable progressive disclosure.
 * Bodies never participate in discovery. Paging identity covers exactly the visible
 * metadata/query, so a changed catalog cannot silently splice two different pages.
 */
import { createHash } from 'node:crypto'
import type { SkillSummary } from './skill/index.ts'
import { escapeText, isModelInvocable } from './skill/index.ts'
export interface CatalogEntry { name: string; description: string; category?: string }

/** Longest normalized category label a catalog renders. */
const CATEGORY_MAX_LENGTH = 64

/**
 * Identity of one published preview. Uncategorized, complete catalogs hash exactly as
 * before categories existed, so a resumed session does not republish an unchanged list.
 */
export function catalogDigest(entries: readonly CatalogEntry[], partial = false): string {
  const lines = entries.map(e => JSON.stringify(e.category === undefined ? [e.name, e.description] : [e.name, e.description, e.category]))
  // A JSON string can never equal an entry's JSON array line.
  if (partial) lines.push('"partial"')
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}
export function descriptionOf(value: string, maxLength: number): string {
  const characters = Array.from(value.replaceAll(/\s+/g, ' ').trim())
  return characters.length <= maxLength ? characters.join('') : characters.slice(0, Math.max(0, maxLength - 3)).join('') + '...'
}
/** Display label for a provider category: whitespace (including newlines) collapsed, bounded. */
export function categoryLabel(category: string | undefined): string | undefined {
  if (category === undefined) return undefined
  const label = descriptionOf(category, CATEGORY_MAX_LENGTH)
  return label === '' ? undefined : label
}
/** Workspace skills form the tier a bounded preview selects first. */
export function isProjectSkill(skill: Pick<SkillSummary, 'source'>): boolean {
  return skill.source === 'project' || skill.source.startsWith('project-')
}
/**
 * Offer-time tool conditions: every required tool must resolve and no fallback target may.
 * Hermes `skill_should_show` semantics, evaluated against one agent's resolved tool view.
 */
export function offeredWithTools(skill: Pick<SkillSummary, 'conditions'>, hasTool: (name: string) => boolean): boolean {
  const conditions = skill.conditions
  if (conditions === undefined) return true
  return (conditions.requiresTools ?? []).every(name => hasTool(name))
    && !(conditions.fallbackForTools ?? []).some(name => hasTool(name))
}
/** Memoize one tool-view lookup per name for the duration of a single evaluation. */
export function toolAvailability(resolves: (name: string) => boolean): (name: string) => boolean {
  const known = new Map<string, boolean>()
  return name => {
    let value = known.get(name)
    if (value === undefined) { value = resolves(name); known.set(name, value) }
    return value
  }
}
export function discoverable(skills: readonly SkillSummary[], query = ''): SkillSummary[] {
  const normalized = query.trim().toLowerCase()
  return skills.filter(s => isModelInvocable(s)
    && `${s.name}\n${s.description}\n${s.whenToUse ?? ''}\n${s.category ?? ''}`.toLowerCase().includes(normalized))
    .sort((a, b) => compare(a.name, b.name))
}

/**
 * Model-facing catalog lines. The pseudo-XML escaping belongs to this frame, not to the
 * published fact, so it is applied here and never stored. Names are `isSkillName`-validated
 * and carry no escapable character. A category header precedes each contiguous group; the
 * preview layout puts uncategorized entries first, so no entry sits under a foreign header.
 */
export function catalogLines(entries: readonly CatalogEntry[]): string[] {
  const lines: string[] = []
  let current: string | undefined
  for (const entry of entries) {
    if (entry.category !== undefined && entry.category !== current) lines.push(categoryLine(entry.category))
    current = entry.category
    lines.push(entryLine(entry))
  }
  return lines
}
function entryLine(entry: CatalogEntry): string { return `- \`${entry.name}\`: ${escapeText(entry.description)}` }
function categoryLine(category: string): string { return `${escapeText(category)}:` }
/**
 * Exact bytes one line adds to the JSON-serialized message content: its escaped text plus
 * the escaped '\n' that joins it. Lines never share an escape, so totals are additive.
 */
export function catalogLineBytes(line: string): number {
  return Buffer.byteLength(JSON.stringify(line), 'utf8')
}

export interface CatalogPreview { entries: CatalogEntry[]; partial: boolean }
/**
 * Bounded preview for the session catalog. Selection takes the project tier first, then the
 * other skills; within a tier it goes round-robin across category groups (uncategorized
 * first, then category name), by name inside each group, so a bound thins every category
 * instead of dropping those late in the alphabet. It skips (never shortens) an entry whose
 * line would exceed the budget. Layout groups by category: uncategorized first, then
 * categories by their best tier and name. `partial` records that the preview omits an
 * offered skill.
 */
export function previewCatalog(skills: readonly SkillSummary[],
  options: { limit: number; descriptionLimit: number; lineBudget: number }): CatalogPreview {
  const offered = discoverable(skills)
  const ordered = [0, 1].flatMap(tier => roundRobin(offered.filter(skill => (isProjectSkill(skill) ? 0 : 1) === tier))
    .map(skill => ({ skill, tier })))
  const selected: { entry: CatalogEntry; tier: number }[] = []
  const headed = new Set<string>()
  let used = 0
  for (const { skill, tier } of ordered) {
    if (selected.length >= options.limit) break
    const category = categoryLabel(skill.category)
    const entry: CatalogEntry = { name: skill.name, description: descriptionOf(skill.description, options.descriptionLimit),
      ...(category === undefined ? {} : { category }) }
    const cost = catalogLineBytes(entryLine(entry))
      + (category === undefined || headed.has(category) ? 0 : catalogLineBytes(categoryLine(category)))
    if (used + cost > options.lineBudget) continue
    used += cost
    if (category !== undefined) headed.add(category)
    selected.push({ entry, tier })
  }
  const groups = new Map<string | undefined, { tier: number; members: typeof selected }>()
  for (const item of selected) {
    const group = groups.get(item.entry.category)
    if (group === undefined) groups.set(item.entry.category, { tier: item.tier, members: [item] })
    else { group.members.push(item); group.tier = Math.min(group.tier, item.tier) }
  }
  const entries = [...groups.entries()]
    .sort(([a, left], [b, right]) => a === undefined ? -1 : b === undefined ? 1 : left.tier - right.tier || compare(a, b))
    .flatMap(([, group]) => group.members.sort((a, b) => a.tier - b.tier || compare(a.entry.name, b.entry.name)).map(item => item.entry))
  return { entries, partial: selected.length < offered.length }
}
/** Interleave name-sorted skills across their category groups, uncategorized group first. */
function roundRobin(sorted: readonly SkillSummary[]): SkillSummary[] {
  const groups = new Map<string | undefined, SkillSummary[]>()
  for (const skill of sorted) {
    const key = categoryLabel(skill.category)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [skill])
    else group.push(skill)
  }
  const queues = [...groups.entries()].sort(([a], [b]) => a === undefined ? -1 : b === undefined ? 1 : compare(a, b))
  // Round r holds each group's r-th member, in group order: O(n log n) for any group shape.
  return queues.flatMap(([, members], group) => members.map((skill, round) => ({ skill, round, group })))
    .sort((a, b) => a.round - b.round || a.group - b.group).map(item => item.skill)
}
export interface CatalogPage {
  revision: string; total: number; offset: number; complete: boolean; skipped: number
  skills: CatalogEntry[]; nextOffset?: number
}
export function catalogPage(skills: readonly SkillSummary[], complete: boolean,
  options: { query: string; offset: number; limit: number; maxBytes: number }): CatalogPage {
  const { query, offset, limit, maxBytes } = options
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(maxBytes) || maxBytes < 512 || query.length > 256) throw new RangeError('invalid catalog page')
  const matching = discoverable(skills, query).map((s): CatalogEntry => {
    const category = categoryLabel(s.category)
    return { name: s.name, description: descriptionOf(s.description, 500), ...(category === undefined ? {} : { category }) }
  })
  const revision = createHash('sha256').update(JSON.stringify([query.trim().toLowerCase(), complete, matching])).digest('hex')
  const selected: CatalogEntry[] = []
  let cursor = Math.min(offset, matching.length), skipped = 0
  const page = (): CatalogPage => ({ revision, total: matching.length, offset, complete, skipped, skills: selected,
    ...(cursor < matching.length ? { nextOffset: cursor } : {}) })
  while (cursor < matching.length && selected.length < limit) {
    const entry = matching[cursor]!
    // An unreturnable name is skipped explicitly, never shortened to a different identity.
    if (Buffer.byteLength(JSON.stringify(entry)) > maxBytes - 256) { skipped++; cursor++; continue }
    selected.push(entry); cursor++
    if (Buffer.byteLength(JSON.stringify(page())) > maxBytes) { selected.pop(); cursor--; break }
  }
  return page()
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
