import { randomInt } from "crypto"

/**
 * Host-assigned callsigns for managed sub-agents when the model does not supply `task_name`.
 * Sampled randomly from the unused pool so successive sessions do not reuse the same opening names.
 */
export const SUBAGENT_CALLSIGNS = [
	"Aether",
	"Altair",
	"Anvil",
	"Apollo",
	"Atlas",
	"Aurora",
	"Azimuth",
	"Beacon",
	"Bramble",
	"Capella",
	"Cinder",
	"Cipher",
	"Cobalt",
	"Comet",
	"Cypress",
	"Deneb",
	"Ember",
	"Falcon",
	"Flint",
	"Forge",
	"Glacier",
	"Harbor",
	"Helix",
	"Horizon",
	"Indigo",
	"Jasper",
	"Juniper",
	"Kestrel",
	"Lumen",
	"Lyra",
	"Mariner",
	"Meridian",
	"Mistral",
	"Nebula",
	"Nimbus",
	"Nova",
	"Obsidian",
	"Orion",
	"Osprey",
	"Polaris",
	"Prism",
	"Quill",
	"Rigel",
	"Saffron",
	"Sapphire",
	"Solstice",
	"Starling",
	"Summit",
	"Talon",
	"Tempest",
	"Vega",
	"Vertex",
	"Vesper",
	"Willow",
	"Zenith",
	"Zephyr",
] as const

export type SubagentCallsignPickIndex = (size: number) => number

export class SubagentNicknameRegistry {
	private readonly callsigns: readonly string[]
	private readonly pickIndex: SubagentCallsignPickIndex
	private readonly assignedByRoot = new Map<string, Set<string>>()
	private readonly assignments = new Map<string, { rootTaskId: string; names: string[] }>()

	constructor(
		options: {
			callsigns?: readonly string[]
			pickIndex?: SubagentCallsignPickIndex
		} = {},
	) {
		this.callsigns = options.callsigns ?? SUBAGENT_CALLSIGNS
		this.pickIndex = options.pickIndex ?? ((size) => randomInt(size))
		if (this.callsigns.length === 0) {
			throw new Error("Sub-agent callsign pool must contain at least one name")
		}
	}

	assign(
		rootTaskId: string,
		groupId: string,
		count: number,
		reserved: Iterable<string> = [],
		preferredNames: readonly (string | undefined)[] = [],
	): string[] {
		if (!rootTaskId.trim() || !groupId.trim()) {
			throw new Error("Sub-agent nickname assignment requires a root task and reservation group")
		}
		if (this.assignments.has(groupId)) {
			throw new Error("Sub-agent nickname reservation group is already assigned")
		}
		if (!Number.isInteger(count) || count < 1 || count > 2) {
			throw new Error("Sub-agent nickname assignment requires one or two names")
		}
		if (preferredNames.length > 0 && preferredNames.length !== count) {
			throw new Error("Preferred sub-agent names must match the requested count")
		}

		const rootAssignments = this.assignedByRoot.get(rootTaskId) ?? new Set<string>()
		const unavailable = new Set([...rootAssignments, ...Array.from(reserved, (name) => name.toLowerCase())])
		const requested = new Set<string>()
		for (const preferredName of preferredNames) {
			const preferred = preferredName?.trim()
			if (!preferred) continue
			const key = preferred.toLowerCase()
			if (unavailable.has(key) || requested.has(key)) {
				throw new Error(`Sub-agent task_name "${preferred}" is already in use`)
			}
			requested.add(key)
			unavailable.add(key)
		}
		const assigned: string[] = []

		while (assigned.length < count) {
			const preferred = preferredNames[assigned.length]?.trim()
			if (preferred) {
				assigned.push(preferred)
				continue
			}

			const candidate = this.nextCallsign(unavailable)
			unavailable.add(candidate.toLowerCase())
			assigned.push(candidate)
		}

		for (const name of assigned) {
			rootAssignments.add(name.toLowerCase())
		}
		this.assignedByRoot.set(rootTaskId, rootAssignments)
		this.assignments.set(groupId, { rootTaskId, names: assigned.map((name) => name.toLowerCase()) })

		return assigned
	}

	/** Release only this preparation's names; durable agent records remain reserved by the caller. */
	release(groupId: string): void {
		const assignment = this.assignments.get(groupId)
		if (!assignment) return
		this.assignments.delete(groupId)
		const rootAssignments = this.assignedByRoot.get(assignment.rootTaskId)
		if (!rootAssignments) return
		for (const name of assignment.names) rootAssignments.delete(name)
		if (rootAssignments.size === 0) this.assignedByRoot.delete(assignment.rootTaskId)
	}

	clear(): void {
		this.assignments.clear()
		this.assignedByRoot.clear()
	}

	private nextCallsign(unavailable: Set<string>): string {
		for (let cycle = 0; cycle < Number.MAX_SAFE_INTEGER; cycle++) {
			const candidates: string[] = []
			for (const base of this.callsigns) {
				const candidate = cycle === 0 ? base : `${base} ${cycle + 1}`
				if (!unavailable.has(candidate.toLowerCase())) {
					candidates.push(candidate)
				}
			}
			if (candidates.length === 0) continue

			const index = this.pickIndex(candidates.length)
			if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
				throw new Error("Sub-agent callsign picker returned an invalid index")
			}
			return candidates[index]
		}

		throw new Error("Unable to allocate a unique sub-agent callsign")
	}
}
