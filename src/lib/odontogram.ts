import type { DentalChartEntry } from '../types/domain'

/** Preserve every version, while identifying exactly one effective leaf per chain. */
export function dentalEntryChains(entries: DentalChartEntry[]): DentalChartEntry[][] {
  const ids = new Set(entries.map((entry) => entry.id))
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const successors = new Map<string, DentalChartEntry>()
  for (const entry of entries) {
    if (!entry.supersedes_entry_id) continue
    if (!ids.has(entry.supersedes_entry_id) || successors.has(entry.supersedes_entry_id)) {
      throw new Error('Dental correction history is incomplete or branches. Refresh before continuing.')
    }
    const predecessor = byId.get(entry.supersedes_entry_id)!
    if (predecessor.clinic_id !== entry.clinic_id || predecessor.visit_id !== entry.visit_id || predecessor.tooth_number !== entry.tooth_number) {
      throw new Error('Dental correction relationships do not match.')
    }
    successors.set(entry.supersedes_entry_id, entry)
  }
  const visited = new Set<string>()
  const chains = entries.filter((entry) => !entry.supersedes_entry_id).map((root) => {
    const chain: DentalChartEntry[] = []
    let entry: DentalChartEntry | undefined = root
    while (entry) {
      if (visited.has(entry.id)) throw new Error('Invalid dental correction chain.')
      visited.add(entry.id)
      chain.push(entry)
      entry = successors.get(entry.id)
    }
    return chain
  })
  if (visited.size !== entries.length) throw new Error('Invalid dental correction chain.')
  return chains
}

/** Quarantine an entire malformed component, preserving unrelated valid history. */
export function inspectDentalEntryChains(entries: DentalChartEntry[]) {
  const rows = new Map<string, DentalChartEntry[]>()
  const neighbors = new Map<string, Set<string>>()
  for (const entry of entries) {
    rows.set(entry.id, [...(rows.get(entry.id) ?? []), entry])
    if (!neighbors.has(entry.id)) neighbors.set(entry.id, new Set())
  }
  for (const entry of entries) {
    if (!entry.supersedes_entry_id || !rows.has(entry.supersedes_entry_id)) continue
    neighbors.get(entry.id)!.add(entry.supersedes_entry_id)
    neighbors.get(entry.supersedes_entry_id)!.add(entry.id)
  }
  const visited = new Set<string>()
  const chains: DentalChartEntry[][] = []
  const unverifiedEntries: DentalChartEntry[] = []
  for (const id of rows.keys()) {
    if (visited.has(id)) continue
    const pending = [id]
    const component: DentalChartEntry[] = []
    while (pending.length) {
      const next = pending.pop()!
      if (visited.has(next)) continue
      visited.add(next)
      component.push(...rows.get(next)!)
      pending.push(...neighbors.get(next)!)
    }
    try {
      chains.push(...dentalEntryChains(component))
    } catch {
      unverifiedEntries.push(...component)
    }
  }
  return { chains, unverifiedEntries }
}
