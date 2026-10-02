import { setImmediate } from "node:timers/promises"

import { AlphaProvider } from "../AlphaProvider"
import type { Task } from "../../task/Task"
import { WorkspaceMutationCancelledError, WorkspaceMutationGate } from "../../task/WorkspaceMutationGate"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function createHarness(taskId = "ticket-parent") {
	const cancellation = new AbortController()
	const task = {
		taskId,
		abort: false,
		getTaskLifetimeCancellationSignal: () => cancellation.signal,
	} as unknown as Task
	const gate = new WorkspaceMutationGate()
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		workspaceMutationGate: gate,
	}) as AlphaProvider
	return { cancellation, task, gate, provider }
}

describe("AlphaProvider workspace mutation cancellation", () => {
	it("settles a cancelled queued task while the admitted mutation still owns the gate", async () => {
		const { cancellation, task, gate, provider } = createHarness()
		const entered = deferred<void>()
		const release = deferred<void>()
		const active = gate.run("other-task", "active command", async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		const run = vi.fn(async () => undefined)
		const queued = provider.runWorkspaceMutation(task, "queued Worker mutation", run)
		let rejected = false
		const observed = queued.catch((error: unknown) => {
			rejected = true
			expect(error).toBeInstanceOf(WorkspaceMutationCancelledError)
		})
		try {
			cancellation.abort()
			await setImmediate()
			expect(rejected).toBe(true)
			expect(gate.runIfIdle("probe", "still owns mutation", async () => undefined)).toBeUndefined()
			expect(run).not.toHaveBeenCalled()
		} finally {
			task.abort = true
			release.resolve()
			await active
			await observed
		}
		await expect(gate.runIfIdle("probe", "released mutation", async () => true)).resolves.toBe(true)
	})

	it("rejects an already cancelled lifetime even before the legacy abort flag is published", async () => {
		const { cancellation, task, gate, provider } = createHarness()
		cancellation.abort()
		const run = vi.fn(async () => "should not run")
		await expect(provider.runWorkspaceMutation(task, "cancelled write", run)).rejects.toBeInstanceOf(
			WorkspaceMutationCancelledError,
		)
		expect(run).not.toHaveBeenCalled()
		await expect(gate.runIfIdle("probe", "no cancelled owner", async () => true)).resolves.toBe(true)
	})

	it("keeps stopped-task cleanup serialized and eligible to finish", async () => {
		const { cancellation, task, gate, provider } = createHarness()
		const entered = deferred<void>()
		const release = deferred<void>()
		const active = gate.run("other-task", "active command", async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		task.abort = true
		cancellation.abort()
		const cleanup = vi.fn(async () => "cleanup complete")
		const queued = provider.runWorkspaceMutation(task, "settle command outcome", cleanup, {
			allowStoppedTask: true,
		})
		expect(cleanup).not.toHaveBeenCalled()
		release.resolve()
		await active
		await expect(queued).resolves.toBe("cleanup complete")
		expect(cleanup).toHaveBeenCalledOnce()
		await expect(gate.runIfIdle("probe", "cleanup released mutation", async () => true)).resolves.toBe(true)
	})
})
