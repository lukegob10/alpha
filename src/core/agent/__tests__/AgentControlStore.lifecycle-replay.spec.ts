import { AgentControlStore, InMemoryAgentControlPersistence } from "../AgentControlStore"

const terminalEvent = {
	eventId: "first-turn-result",
	rootTaskId: "root",
	sender: "child",
	recipient: "root",
	kind: "result" as const,
	name: "agent_completed",
	payload: { taskId: "child", status: "completed", summary: "First turn" },
	createdAt: 2_000,
}

const terminalInput = {
	at: 2_000,
	snapshot: { summary: "First turn" },
	pendingFollowupEventId: null,
	terminalResult: { status: "completed" as const, summary: "First turn", completedAt: 2_000 },
}

const followupEvent = {
	eventId: "followup-receipt",
	rootTaskId: "root",
	sender: "root",
	recipient: "child",
	kind: "followup" as const,
	name: "followup_started",
	payload: { message: "Second turn" },
	createdAt: 3_000,
}

const followupInput = {
	at: 3_000,
	groupId: "second-group",
	pendingFollowupEventId: followupEvent.eventId,
	snapshot: { phase: "queued" },
}

async function setup() {
	let transaction = Promise.resolve()
	const persistence = Object.assign(new InMemoryAgentControlPersistence(), {
		withTransaction<T>(operation: () => Promise<T>): Promise<T> {
			const next = transaction.then(operation, operation)
			transaction = next.then(
				() => undefined,
				() => undefined,
			)
			return next
		},
	})
	let timestamp = 1_000
	const store = new AgentControlStore(persistence, () => ++timestamp)
	await store.initialize()
	await store.ensureRoot({ taskId: "root", status: "running" })
	await store.createAgent({
		taskId: "child",
		parentTaskId: "root",
		groupId: "first-group",
		nickname: "Child",
		role: "review",
		objective: "Inspect lifecycle",
		status: "running",
	})
	const complete = () =>
		store.updateAgentStatusAndAppendEvent("child", "completed", terminalInput, terminalEvent, "root")
	const admit = () => store.updateAgentStatusAndAppendEvent("child", "pending", followupInput, followupEvent, "root")
	return { store, persistence, complete, admit }
}

describe("AgentControlStore lifecycle event replay", () => {
	it.each(["pending", "running"] as const)(
		"does not complete a successor %s turn when the old terminal event is replayed",
		async (status) => {
			const { store, persistence, complete, admit } = await setup()
			await complete()
			await admit()
			if (status === "running") {
				await store.updateAgentStatus("child", "running", {
					at: 4_000,
					snapshot: { phase: "requesting", summary: "Second turn is running" },
					pendingFollowupEventId: null,
				})
			}
			const before = store.getSnapshot()
			const durable = await persistence.read()
			const write = vi.spyOn(persistence, "write")
			const published = vi.fn()
			store.subscribe(published)

			await expect(complete()).resolves.toMatchObject({ appended: false, record: { status } })

			expect(store.getSnapshot()).toEqual(before)
			expect(await persistence.read()).toEqual(durable)
			expect(write).not.toHaveBeenCalled()
			expect(published).not.toHaveBeenCalled()
		},
	)

	it("does not revive a completed turn when its started event is replayed", async () => {
		const { store, complete } = await setup()
		const startedEvent = {
			...terminalEvent,
			eventId: "first-turn-started",
			kind: "lifecycle" as const,
			name: "agent_started",
			payload: { taskId: "child", status: "running" },
			createdAt: 1_500,
		}
		const start = () =>
			store.updateAgentStatusAndAppendEvent("child", "running", { at: 1_500 }, startedEvent, "root")
		await start()
		await complete()
		const before = store.getSnapshot()

		await expect(start()).resolves.toMatchObject({ appended: false, record: { status: "completed" } })
		expect(store.getSnapshot()).toEqual(before)
	})

	it("does not restart a completed turn from a spent follow-up receipt", async () => {
		const { store, complete, admit } = await setup()
		await complete()
		await admit()
		await store.updateAgentStatus("child", "running", { pendingFollowupEventId: null })
		await store.updateAgentStatus("child", "completed", {
			at: 4_000,
			terminalResult: { status: "completed", completedAt: 4_000, summary: "Second turn" },
		})
		const before = store.getSnapshot()

		await expect(admit()).resolves.toMatchObject({ appended: false, record: { status: "completed" } })
		expect(store.getSnapshot()).toEqual(before)
	})

	it("does not overwrite a newer pending follow-up with an older receipt", async () => {
		const { store, complete, admit } = await setup()
		await complete()
		await admit()
		await store.updateAgentStatus("child", "running", { pendingFollowupEventId: null })
		await store.updateAgentStatus("child", "completed")
		await store.updateAgentStatus("child", "pending", {
			at: 5_000,
			groupId: "third-group",
			pendingFollowupEventId: "newer-followup-receipt",
			snapshot: { phase: "queued", summary: "Third turn" },
		})
		const before = store.getSnapshot()

		await expect(admit()).resolves.toMatchObject({
			appended: false,
			record: { status: "pending", pendingFollowupEventId: "newer-followup-receipt", groupId: "third-group" },
		})
		expect(store.getSnapshot()).toEqual(before)
	})

	it("can readmit only the still-owned follow-up receipt after prelaunch rollback", async () => {
		const { store, complete, admit } = await setup()
		const previous = (await complete()).record
		await admit()
		expect(await store.rollbackAgentFollowup(previous, followupEvent.eventId)).toBe(true)

		await expect(admit()).resolves.toMatchObject({
			appended: false,
			record: { status: "pending", pendingFollowupEventId: followupEvent.eventId, groupId: "second-group" },
		})
		expect(store.getSnapshot().mailbox.filter((entry) => entry.eventId === followupEvent.eventId)).toHaveLength(1)
	})

	it("can readmit the still-owned unlaunched receipt after reload marks it interrupted", async () => {
		const { persistence, complete, admit } = await setup()
		await complete()
		await admit()
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		expect(reloaded.getAgent("child")).toMatchObject({
			status: "interrupted",
			pendingFollowupEventId: followupEvent.eventId,
		})

		await expect(
			reloaded.updateAgentStatusAndAppendEvent("child", "pending", followupInput, followupEvent, "root"),
		).resolves.toMatchObject({
			appended: false,
			record: { status: "pending", pendingFollowupEventId: followupEvent.eventId, groupId: "second-group" },
		})
		expect(reloaded.getSnapshot().mailbox.filter((entry) => entry.eventId === followupEvent.eventId)).toHaveLength(
			1,
		)
	})

	it.each(["root", "other-root"])(
		"rejects an existing receipt reused for another agent in %s",
		async (rootTaskId) => {
			const { store, complete } = await setup()
			await complete()
			if (rootTaskId !== "root") await store.ensureRoot({ taskId: rootTaskId, status: "running" })
			await store.createAgent({
				taskId: "other-child",
				parentTaskId: rootTaskId,
				nickname: "Other child",
				role: "review",
				objective: "Inspect independently",
				status: "running",
			})
			const before = store.getSnapshot()

			await expect(
				store.updateAgentStatusAndAppendEvent(
					"other-child",
					"completed",
					terminalInput,
					terminalEvent,
					rootTaskId,
				),
			).rejects.toThrow("different agent lifecycle")
			expect(store.getSnapshot()).toEqual(before)
		},
	)

	it("rejects changed receipt content without changing a successor turn", async () => {
		const { store, complete, admit } = await setup()
		await complete()
		await admit()
		const before = store.getSnapshot()

		await expect(
			store.updateAgentStatusAndAppendEvent(
				"child",
				"completed",
				terminalInput,
				{ ...terminalEvent, payload: { ...terminalEvent.payload, summary: "Changed old result" } },
				"root",
			),
		).rejects.toThrow("different content")
		expect(store.getSnapshot()).toEqual(before)
	})
})
