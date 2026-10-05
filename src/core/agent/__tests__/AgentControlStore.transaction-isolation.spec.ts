import { agentControlStateSchema, type AgentControlState, type AgentMailboxEntry } from "@alpha-code/types"
import { ZodError } from "zod"

import { AgentControlStore, type AgentControlPersistence } from "../AgentControlStore"

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const createPersistence = (isolated = false) => {
	let stored: unknown
	let transaction = Promise.resolve()
	const persistence: AgentControlPersistence = {
		// The generic persistence contract does not promise exclusive read ownership.
		read: vi.fn(async () => stored),
		readIsolated: isolated ? vi.fn(async () => structuredClone(stored)) : undefined,
		write: vi.fn(async (state: AgentControlState) => {
			stored = structuredClone(state)
		}),
		assertTransactionOwner: vi.fn(async () => undefined),
		withTransaction<T>(operation: () => Promise<T>): Promise<T> {
			const next = transaction.then(operation, operation)
			transaction = next.then(
				() => undefined,
				() => undefined,
			)
			return next
		},
	}
	let timestamp = 1_000
	return {
		persistence,
		getStored: () => stored,
		setStored: (state: unknown) => {
			stored = state
		},
		createStore: async () => {
			const store = new AgentControlStore(persistence, () => ++timestamp)
			await store.initialize()
			return store
		},
	}
}

const eventInput = {
	eventId: "result-1",
	recipient: "root-1",
	kind: "result" as const,
	name: "agent_completed",
	createdAt: 2_000,
}

describe.each(["shared", "isolated"] as const)("AgentControlStore transaction isolation with %s reads", (ownership) => {
	const createFixture = () => createPersistence(ownership === "isolated")
	it("keeps a no-op projection isolated from a persistence reader's shared object", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		await store.appendEvent(eventInput)
		await store.appendEvent(eventInput)
		const before = store.getSnapshot()
		const shared = fixture.getStored() as AgentControlState
		shared.mailbox[0]!.name = "external-change"
		expect(store.getSnapshot()).toEqual(before)
	})

	it("refreshes an independent writer's receipt and projection on a no-op without writing or publishing", async () => {
		const fixture = createFixture()
		const first = await fixture.createStore()
		const second = await fixture.createStore()
		await first.ensureRoot({ taskId: "root-1" })
		await first.appendEvent(eventInput)
		await second.claimMailbox("root-1", { claimId: "wait-1", channel: "wait" })
		await second.acknowledgeMailboxClaim("root-1", "wait-1", undefined, 3_000)
		await second.appendEvent({ ...eventInput, eventId: "result-2" })
		const durable = structuredClone(fixture.getStored())
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length
		const published = vi.fn()
		first.subscribe(published)

		const replay = await first.appendEvent(eventInput)

		expect(replay).toMatchObject({
			appended: false,
			entry: { claimId: "wait-1", claimChannel: "wait", deliveredAt: 3_000, acknowledgedAt: 3_000 },
		})
		expect(first.getSnapshot()).toEqual(second.getSnapshot())
		expect(first.getMailboxCursor("root-1")).toMatchObject({ lastAcknowledgedSequence: 1 })
		expect(fixture.getStored()).toEqual(durable)
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount)
		expect(published).not.toHaveBeenCalled()
	})

	it("discards partial lifecycle changes when the event mutator rejects an idempotency mismatch", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		await store.appendEvent(eventInput)
		const before = store.getSnapshot()
		const durable = structuredClone(fixture.getStored())
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length
		const published = vi.fn()
		store.subscribe(published)

		await expect(
			store.updateAgentStatusAndAppendEvent(
				"root-1",
				"completed",
				{ at: 3_000 },
				{
					...eventInput,
					name: "different_content",
				},
			),
		).rejects.toThrow("different content")

		expect(store.getSnapshot()).toEqual(before)
		expect(fixture.getStored()).toEqual(durable)
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount)
		expect(published).not.toHaveBeenCalled()
		await expect(store.appendEvent({ ...eventInput, eventId: "result-2" })).resolves.toMatchObject({
			appended: true,
			entry: { sequence: 2 },
		})
	})

	it.each(["write", "fence"] as const)(
		"rolls back a rejected %s and allows the next transaction",
		async (failure) => {
			const fixture = createFixture()
			const store = await fixture.createStore()
			await store.ensureRoot({ taskId: "root-1" })
			const before = store.getSnapshot()
			const durable = structuredClone(fixture.getStored())
			const published = vi.fn()
			store.subscribe(published)
			if (failure === "write") {
				vi.mocked(fixture.persistence.write).mockRejectedValueOnce(new Error("write rejected"))
			} else {
				vi.mocked(fixture.persistence.assertTransactionOwner!).mockRejectedValueOnce(
					new Error("fence rejected"),
				)
			}

			await expect(
				store.updateAgentStatusAndAppendEvent("root-1", "completed", { at: 3_000 }, eventInput),
			).rejects.toThrow(`${failure} rejected`)

			expect(store.getSnapshot()).toEqual(before)
			expect(fixture.getStored()).toEqual(durable)
			expect(published).not.toHaveBeenCalled()
			await expect(
				store.updateAgentStatusAndAppendEvent("root-1", "completed", { at: 3_000 }, eventInput),
			).resolves.toMatchObject({ record: { status: "completed" }, event: { sequence: 1 }, appended: true })
			expect(published).toHaveBeenCalledTimes(1)
		},
	)

	it("isolates nested payload inputs, outputs, subscribers, and shared persistence reads", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		const writeStarted = deferred()
		const releaseWrite = deferred()
		const write = fixture.persistence.write
		vi.mocked(write).mockImplementationOnce(async (state) => {
			writeStarted.resolve()
			await releaseWrite.promise
			fixture.setStored(structuredClone(state))
		})
		const payload = { nested: { value: "original" } }
		const published: AgentMailboxEntry[] = []
		store.subscribe((entry) => {
			Object.assign(entry.payload!.nested!, { value: "subscriber mutation" })
		})
		store.subscribe((entry) => published.push(entry))
		const append = store.appendEvent({ ...eventInput, payload })
		await writeStarted.promise
		payload.nested.value = "input mutation"
		expect(store.getSnapshot().mailbox).toEqual([])
		releaseWrite.resolve()
		const result = await append
		expect(result.entry.payload).toEqual({ nested: { value: "original" } })
		expect(published[0].payload).toEqual({ nested: { value: "original" } })
		Object.assign(result.entry.payload!.nested!, { value: "result mutation" })
		Object.assign(published[0].payload!.nested!, { value: "retained subscriber mutation" })
		expect(store.getSnapshot().mailbox[0].payload).toEqual({ nested: { value: "original" } })

		const claim = await store.claimMailbox("root-1", { claimId: "wait-1", channel: "wait" })
		Object.assign(claim.entries[0].payload!.nested!, { value: "claim mutation" })
		const replay = await store.appendEvent(eventInput)
		Object.assign(replay.entry.payload!.nested!, { value: "replay mutation" })
		expect(store.getSnapshot().mailbox[0].payload).toEqual({ nested: { value: "original" } })

		// A successful mutation must detach opaque schema leaves from a shared read.
		const sharedRead = fixture.getStored() as AgentControlState
		await store.ensureRoot({ taskId: "root-2" })
		Object.assign(sharedRead.mailbox[0].payload!.nested!, { value: "persistence mutation" })
		expect(store.getSnapshot().mailbox[0].payload).toEqual({ nested: { value: "original" } })
	})

	it("rejects a schema-invalid snapshot mutation without changing durable or projected state", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		const before = store.getSnapshot()
		const durable = structuredClone(fixture.getStored())
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length

		await expect(store.updateAgentSnapshot("root-1", { usage: { tokens: Number.NaN } })).rejects.toThrow()

		expect(store.getSnapshot()).toEqual(before)
		expect(fixture.getStored()).toEqual(durable)
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount)
		await expect(store.updateAgentSnapshot("root-1", { usage: { tokens: 1 } })).resolves.toMatchObject({
			snapshot: { usage: { tokens: 1 } },
		})
	})

	it("rejects malformed durable state before mutation and resumes after valid state is restored", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		const before = store.getSnapshot()
		const durable = structuredClone(fixture.getStored())
		const malformed = { ...before, nextSequence: 0 }
		fixture.setStored(malformed)
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length
		const published = vi.fn()
		store.subscribe(published)

		await expect(store.appendEvent(eventInput)).rejects.toThrow()

		expect(store.getSnapshot()).toEqual(before)
		expect(fixture.getStored()).toEqual(malformed)
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount)
		expect(published).not.toHaveBeenCalled()
		fixture.setStored(durable)
		await expect(store.appendEvent(eventInput)).resolves.toMatchObject({ appended: true, entry: { sequence: 1 } })
	})

	it("normalizes defaults and external unknown fields and repairs sequence without writing a no-op", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		await store.appendEvent(eventInput)
		const external = {
			...store.getSnapshot(),
			nextSequence: 1,
			verificationObligations: undefined,
			unknownExternalField: "preserve until a real mutation",
		}
		fixture.setStored(external)
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length

		await store.ensureRoot({ taskId: "root-1" })

		expect(store.getSnapshot()).toMatchObject({ nextSequence: 2, verificationObligations: [] })
		expect(store.getSnapshot()).not.toHaveProperty("unknownExternalField")
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount)
		expect(fixture.getStored()).toEqual(external)
		await expect(store.appendEvent({ ...eventInput, eventId: "result-2" })).resolves.toMatchObject({
			entry: { sequence: 2 },
		})
	})

	it("migrates a legacy state after a previously validated current read", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		await store.appendEvent(eventInput)
		const before = store.getSnapshot()
		fixture.setStored({ ...before, version: 1 })
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length

		await store.ensureRoot({ taskId: "root-1" })

		expect(store.getSnapshot()).toMatchObject({ version: 2, mailbox: before.mailbox })
		expect(fixture.getStored()).toEqual(store.getSnapshot())
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount + 1)
	})

	it("normalizes previously written records before reusing them as schema-validated state", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		const snapshot = { phase: "retained", futureField: "strip on durable read" }
		await store.updateAgentSnapshot("root-1", snapshot)
		await store.ensureRoot({ taskId: "root-1" })
		expect(store.getAgent("root-1")?.snapshot).toEqual({ phase: "retained" })
		expect(fixture.getStored()).toMatchObject({ agents: [{ snapshot }] })
	})

	it.each(["agents", "tombstones", "mailbox", "verificationObligations"] as const)(
		"rejects sparse %s arrays instead of accepting their holes as validated records",
		async (field) => {
			const fixture = createFixture()
			const store = await fixture.createStore()
			await store.ensureRoot({ taskId: "root-1" })
			const before = store.getSnapshot()
			fixture.setStored({ ...before, [field]: new Array(1) })
			await expect(store.ensureRoot({ taskId: "root-2" })).rejects.toThrow()
			expect(store.getSnapshot()).toEqual(before)
		},
	)

	it.each([
		["agents", { nickname: "" }],
		["tombstones", { taskId: "" }],
		["mailbox", { sequence: 0 }],
		["verificationObligations", { id: "" }],
	] as const)("validates an externally corrupted %s record during an unrelated mutation", async (field, invalid) => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		await store.createAgent({
			taskId: "child-1",
			parentTaskId: "root-1",
			nickname: "Child",
			role: "review",
			objective: "Review",
			status: "completed",
		})
		await store.closeAgent("child-1")
		await store.appendEvent(eventInput)
		await store.reservePrimaryMutation("root-1", "root-1", "/project", "reservation")
		const before = store.getSnapshot()
		const malformed = { ...before, [field]: [{ ...before[field][0], ...invalid }] }
		fixture.setStored(malformed)
		const writeCount = vi.mocked(fixture.persistence.write).mock.calls.length

		await expect(store.ensureRoot({ taskId: "root-2" })).rejects.toThrow()

		expect(store.getSnapshot()).toEqual(before)
		expect(fixture.getStored()).toEqual(malformed)
		expect(fixture.persistence.write).toHaveBeenCalledTimes(writeCount)
		fixture.setStored(before)
		await expect(store.ensureRoot({ taskId: "root-2" })).resolves.toMatchObject({ taskId: "root-2" })
		expect(store.getVerificationObligations()).toEqual(before.verificationObligations)
	})

	it("reports canonical record positions when a later retained record is corrupt", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1" })
		await store.appendEvent(eventInput)
		await store.appendEvent({ ...eventInput, eventId: "result-2" })
		const before = store.getSnapshot()
		const malformed = {
			...before,
			mailbox: [before.mailbox[0], { ...before.mailbox[1], sequence: 0 }],
		}
		fixture.setStored(malformed)
		const expected = agentControlStateSchema.safeParse(malformed)
		const failure = await store.ensureRoot({ taskId: "root-2" }).catch((error: unknown) => error)
		if (expected.success || !(failure instanceof ZodError))
			throw new Error("Expected canonical validation failures")
		const paths = (error: ZodError): unknown[] =>
			error.issues.flatMap((issue) => [
				issue.path,
				...(issue.code === "invalid_union" ? issue.unionErrors.flatMap(paths) : []),
			])
		expect(paths(failure)).toEqual(paths(expected.error))
		expect(store.getSnapshot()).toEqual(before)
	})

	it("preserves externally reordered records and detaches unchanged nested data", async () => {
		const fixture = createFixture()
		const store = await fixture.createStore()
		await store.ensureRoot({ taskId: "root-1", snapshot: { metadata: { nested: { value: "original" } } } })
		await store.ensureRoot({ taskId: "root-2" })
		const before = store.getSnapshot()
		const reordered = { ...before, agents: [...before.agents].reverse() }
		fixture.setStored(reordered)
		await store.ensureRoot({ taskId: "root-2" })
		expect(store.getSnapshot()).toEqual(reordered)
		await store.updateAgentSnapshot("root-2", { phase: "updated" })
		Object.assign(reordered.agents[1].snapshot!.metadata!.nested!, { value: "external mutation" })
		expect(store.getAgent("root-1")?.snapshot?.metadata).toEqual({ nested: { value: "original" } })
		expect(store.getAgent("root-2")?.snapshot?.phase).toBe("updated")
	})
})
