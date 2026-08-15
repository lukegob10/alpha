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

	assign(count: number, reserved: Iterable<string> = []): string[] {
		if (!Number.isInteger(count) || count < 1 || count > 2) {
			throw new Error("Sub-agent nickname assignment requires one or two names")
		}

		const unavailable = new Set(Array.from(reserved, (name) => name.toLowerCase()))
		const assigned: string[] = []

		while (assigned.length < count) {
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
