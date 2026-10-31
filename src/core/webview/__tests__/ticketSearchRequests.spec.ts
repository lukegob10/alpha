import { cancelTicketSearches, enqueueFileSearch, enqueueTicketSearch } from "../ticketSearchRequests"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => (resolve = complete))
	return { promise, resolve }
}

describe("picker search ownership", () => {
	it("joins one active file reader and keeps only the latest pending query", async () => {
		const provider = {}
		const blocked = deferred()
		const started: string[] = []
		let firstSignal!: AbortSignal
		const first = enqueueFileSearch(provider, "task", async (signal) => {
			firstSignal = signal
			started.push("first")
			await blocked.promise
		})
		const superseded = enqueueFileSearch(provider, "task", async () => {
			started.push("superseded")
		})
		const latest = enqueueFileSearch(provider, "task", async () => {
			started.push("latest")
		})
		await superseded
		expect(firstSignal.aborted).toBe(true)
		expect(started).toEqual(["first"])
		blocked.resolve()
		await Promise.all([first, latest])
		expect(started).toEqual(["first", "latest"])
	})

	it("isolates file readers from ticket searches and other providers", async () => {
		const provider = {}
		const blocked = deferred()
		let fileSignal!: AbortSignal
		const first = enqueueFileSearch(provider, "task", async (signal) => {
			fileSignal = signal
			await blocked.promise
		})
		const ticket = vi.fn(async () => {})
		const otherView = vi.fn(async () => {})
		try {
			await Promise.all([enqueueTicketSearch(provider, "task", ticket), enqueueFileSearch({}, "task", otherView)])
			expect(ticket).toHaveBeenCalledOnce()
			expect(otherView).toHaveBeenCalledOnce()
			expect(fileSignal.aborted).toBe(false)
		} finally {
			blocked.resolve()
			await first
		}
	})

	it("bounds file lanes without consuming existing ticket admission capacity", async () => {
		const provider = {}
		const blocked = deferred()
		const readers = Array.from({ length: 8 }, (_, index) =>
			enqueueFileSearch(provider, `task-${index}`, async () => blocked.promise),
		)
		try {
			await expect(enqueueFileSearch(provider, "overflow", async () => {})).rejects.toThrow(
				"Too many concurrent file searches",
			)
			const ticket = vi.fn(async () => {})
			await enqueueTicketSearch(provider, "task-0", ticket)
			expect(ticket).toHaveBeenCalledOnce()
		} finally {
			blocked.resolve()
			await Promise.all(readers)
		}
	})

	it("cancels both namespaces and drops queued work before provider disposal joins", async () => {
		const provider = {}
		const blocked = deferred()
		const signals: AbortSignal[] = []
		const active = (signal: AbortSignal) => {
			signals.push(signal)
			return blocked.promise
		}
		const file = enqueueFileSearch(provider, undefined, active)
		const ticket = enqueueTicketSearch(provider, undefined, active)
		const pending = vi.fn(async () => {})
		const queued = [
			enqueueFileSearch(provider, undefined, pending),
			enqueueTicketSearch(provider, undefined, pending),
		]
		cancelTicketSearches(provider)
		await Promise.all(queued)
		expect(signals.every((signal) => signal.aborted)).toBe(true)
		expect(pending).not.toHaveBeenCalled()
		blocked.resolve()
		await Promise.all([file, ticket])
	})
})
