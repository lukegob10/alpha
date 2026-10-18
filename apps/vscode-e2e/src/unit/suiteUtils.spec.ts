import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { test } from "node:test"

import { AlphaCodeEventName, type AlphaCodeAPI } from "@alpha-code/types"

import { waitUntilCompleted } from "../suite/utils"

function fixture() {
	const events = new EventEmitter()
	return { events, api: events as unknown as AlphaCodeAPI }
}

test("completion already published before waiting is read from the task state", async () => {
	const { api, events } = fixture()
	events.emit(AlphaCodeEventName.TaskCompleted, "completed-task")
	const options = {
		api,
		taskId: "completed-task",
		isCompleted: () => true,
		timeout: 0,
	}
	await waitUntilCompleted(options)
	assert.equal(events.listenerCount(AlphaCodeEventName.TaskCompleted), 0)
})

test("completion while waiting remains scoped to the requested task", async () => {
	const { api, events } = fixture()
	const options = { api, taskId: "target-task", isCompleted: () => false }
	const completion = waitUntilCompleted(options)
	events.emit(AlphaCodeEventName.TaskCompleted, "another-task")
	events.emit(AlphaCodeEventName.TaskCompleted, "target-task")
	await completion
	assert.equal(events.listenerCount(AlphaCodeEventName.TaskCompleted), 0)
})

test("an unrelated task completion cannot satisfy the waiter", async () => {
	const { api, events } = fixture()
	await assert.rejects(
		waitUntilCompleted({
			api,
			taskId: "target-task",
			isCompleted: () => {
				events.emit(AlphaCodeEventName.TaskCompleted, "another-task")
				return false
			},
			timeout: 0,
		}),
		/Timed out.*target-task/,
	)
	assert.equal(events.listenerCount(AlphaCodeEventName.TaskCompleted), 0)
})

test("authoritative completion observed after subscription needs no new event", async () => {
	const { api, events } = fixture()
	let completed = false
	const options = { api, taskId: "target-task", isCompleted: () => completed }
	const completion = waitUntilCompleted(options)
	completed = true
	await completion
	assert.equal(events.listenerCount(AlphaCodeEventName.TaskCompleted), 0)
})

test("completion state errors remove the listener and preserve the failure", async () => {
	const { api, events } = fixture()
	const failure = new Error("Task state unavailable")
	const options = {
		api,
		taskId: "target-task",
		isCompleted: (): boolean => {
			throw failure
		},
	}
	await assert.rejects(waitUntilCompleted(options), (error) => error === failure)
	assert.equal(events.listenerCount(AlphaCodeEventName.TaskCompleted), 0)
})
