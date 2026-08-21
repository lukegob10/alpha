const ALPHA_SUBAGENT_NICKNAMES = [
	"Beacon",
	"Cinder",
	"Drift",
	"Ember",
	"Harbor",
	"Indigo",
	"Juniper",
	"Kestrel",
	"Lumen",
	"Maple",
	"Nova",
	"Orbit",
] as const

export class SubagentNicknameRegistry {
	private cursor = 0

	assign(
		count: number,
		reserved: Iterable<string> = [],
		preferredNames: readonly (string | undefined)[] = [],
	): string[] {
		if (!Number.isInteger(count) || count < 1 || count > 2) {
			throw new Error("Sub-agent nickname assignment requires one or two names")
		}
		if (preferredNames.length > 0 && preferredNames.length !== count) {
			throw new Error("Preferred sub-agent names must match the requested count")
		}

		const unavailable = new Set(Array.from(reserved, (name) => name.toLowerCase()))
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

			const base = ALPHA_SUBAGENT_NICKNAMES[this.cursor % ALPHA_SUBAGENT_NICKNAMES.length]
			const cycle = Math.floor(this.cursor / ALPHA_SUBAGENT_NICKNAMES.length)
			const candidate = cycle === 0 ? base : `${base} ${cycle + 1}`
			this.cursor++

			if (unavailable.has(candidate.toLowerCase())) continue
			unavailable.add(candidate.toLowerCase())
			assigned.push(candidate)
		}

		return assigned
	}
}
