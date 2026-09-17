import assert from "node:assert/strict"
import test from "node:test"
import {
	parseContextRunMetadata,
	createCompletionReviewAcknowledger,
	withBoundedFixtureCleanup,
	withFixtureCleanup,
} from "../../apps/vscode-e2e/src/suite/proportional-context-support"

test("the on-screen completion review is acknowledged once without accepting recovery or tool asks", () => {
	let approvals = 0
	const acknowledge = createCompletionReviewAcknowledger()
	const task = {
		taskAsk: { ask: "resume_task" },
		approveAsk: () => {
			approvals++
		},
	}
	assert.equal(acknowledge(undefined), false)
	for (const ask of ["resume_task", "resume_completed_task", "command", "tool", "followup"]) {
		task.taskAsk.ask = ask
		assert.equal(acknowledge(task), false)
	}
	assert.equal(approvals, 0)
	task.taskAsk.ask = "completion_result"
	assert.equal(acknowledge(task), true)
	assert.equal(acknowledge(task), false)
	assert.equal(approvals, 1)
})

test("completion acknowledgment skips settled or cancelled Tasks and preserves approval failures", () => {
	const failure = new Error("review response failed")
	const task = {
		didComplete: true,
		abort: false,
		taskAsk: { ask: "completion_result" },
		approveAsk: () => {
			throw failure
		},
	}
	const acknowledge = createCompletionReviewAcknowledger()
	assert.equal(acknowledge(task), false)
	task.didComplete = false
	task.abort = true
	assert.equal(acknowledge(task), false)
	task.abort = false
	assert.throws(
		() => acknowledge(task),
		(error: unknown) => error === failure,
	)
})

test("a stuck publication and stuck cancellation cannot skip restoration or hide the primary failure", async () => {
	const primary = new Error("completion assertion timed out")
	const deadlines: Array<() => void> = []
	const entered: Array<() => void> = []
	const observed = Array.from({ length: 2 }, () => new Promise<void>((resolve) => entered.push(resolve)))
	const seen: string[] = []
	let cancelledTimers = 0
	let rejectLatePublication!: (error: Error) => void
	const publication = new Promise<void>((_resolve, reject) => {
		rejectLatePublication = reject
	})
	const result = assert.rejects(
		withBoundedFixtureCleanup(
			async () => {
				throw primary
			},
			[
				() => {
					seen.push("publication")
					entered[0]!()
					return publication
				},
				() => {
					seen.push("cancel")
					entered[1]!()
					return new Promise<void>(() => undefined)
				},
				() => {
					seen.push("restore")
				},
				() => {
					seen.push("cache")
				},
			],
			(timeout, milliseconds) => {
				assert.equal(milliseconds, 5000)
				deadlines.push(timeout)
				return () => {
					cancelledTimers++
				}
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.equal(error.cause, primary)
			assert.equal(error.errors[0], primary)
			assert.equal(error.errors.length, 3)
			assert.match(error.errors[1].message, /cleanup 1 did not settle/)
			assert.match(error.errors[2].message, /cleanup 2 did not settle/)
			return true
		},
	)
	await observed[0]
	deadlines[0]!()
	await observed[1]
	deadlines[1]!()
	await result
	rejectLatePublication(new Error("late publication failure"))
	assert.deepEqual(seen, ["publication", "cancel", "restore", "cache"])
	assert.equal(cancelledTimers, 4)
})

test("successful cleanup cancels its deadline and preserves cleanup failure identity", async () => {
	const failure = new Error("immediate cleanup failure")
	let cancelledTimers = 0
	await assert.rejects(
		withBoundedFixtureCleanup(
			async () => "success",
			[
				() => {
					throw failure
				},
				() => undefined,
			],
			() => () => {
				cancelledTimers++
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.deepEqual(error.errors, [failure])
			return true
		},
	)
	assert.equal(cancelledTimers, 2)
})

test("cleanup failures never skip task cache eviction or fixture unlink and preserve the primary failure", async () => {
	const primary = new Error("assertion failed")
	const clearFailure = new Error("clear failed")
	const restoreFailure = new Error("restore failed")
	const seen: string[] = []
	await assert.rejects(
		withFixtureCleanup(async () => {
			throw primary
		}, [
			() => {
				seen.push("clear")
				throw clearFailure
			},
			() => {
				seen.push("cache")
			},
			async () => {
				seen.push("restore")
				throw restoreFailure
			},
			async () => {
				seen.push("unlink")
			},
		]),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.equal(error.cause, primary)
			assert.deepEqual(error.errors, [primary, clearFailure, restoreFailure])
			return true
		},
	)
	assert.deepEqual(seen, ["clear", "cache", "restore", "unlink"])
})

test("successful fixture fails when cleanup fails and does not skip later cleanup", async () => {
	let unlinked = false
	await assert.rejects(
		withFixtureCleanup(
			async () => "success",
			[
				async () => {
					throw new Error("restore failed")
				},
				() => {
					unlinked = true
				},
			],
		),
		AggregateError,
	)
	assert.equal(unlinked, true)
	assert.equal(await withFixtureCleanup(async () => 42, []), 42)
})

test("a thrown undefined remains a primary failure", async () => {
	let settled = false
	await withFixtureCleanup(async () => {
		throw undefined
	}, []).then(
		() => assert.fail("must reject"),
		(error) => {
			assert.equal(error, undefined)
			settled = true
		},
	)
	assert.equal(settled, true)
})

test("outer fixture cleanup runs after inner task cleanup fails", async () => {
	const primary = new Error("primary assertion")
	const seen: string[] = []
	await assert.rejects(
		withFixtureCleanup(
			() =>
				withFixtureCleanup(async () => {
					throw primary
				}, [
					() => {
						seen.push("clear")
						throw new Error("clear failed")
					},
					() => {
						seen.push("cache")
					},
				]),
			[
				() => {
					seen.push("restore")
					throw new Error("restore failed")
				},
				() => {
					seen.push("unlink")
				},
			],
		),
		(error: unknown) => {
			assert.ok(error instanceof AggregateError)
			assert.ok(error.cause instanceof AggregateError)
			assert.equal(error.cause.cause, primary)
			return true
		},
	)
	assert.deepEqual(seen, ["clear", "cache", "restore", "unlink"])
})

const metadata = {
	sourceRevision: "a".repeat(40),
	sourceTreeState: "clean",
	buildSha256: "b".repeat(64),
	configurationId: "default-scripted-context-v1",
	hostAtSuiteStart: "fresh",
}

test("metadata records declared build/config identities and shared-host cache conditions without settings", () => {
	const result = parseContextRunMetadata(JSON.stringify({ ...metadata, settings: { apiKey: "secret" } }))
	assert.equal(result.sourceRevision, metadata.sourceRevision)
	assert.equal(result.buildSha256, metadata.buildSha256)
	assert.equal(result.configurationId, metadata.configurationId)
	assert.equal(result.sourceDiffSha256, null)
	assert.match(result.cacheState.sampling, /one host shared/)
	assert.doesNotMatch(JSON.stringify(result), /settings|apiKey|secret/)
	assert.equal(
		parseContextRunMetadata(
			JSON.stringify({
				...metadata,
				sourceTreeState: "modified",
				sourceDiffSha256: "c".repeat(64),
			}),
		).sourceDiffSha256,
		"c".repeat(64),
	)
})

test("reproducible runs reject missing or invalid provenance", () => {
	assert.throws(() => parseContextRunMetadata(undefined), /ALPHA_SCOPE_RUN_METADATA/)
	for (const [field, value] of Object.entries({
		sourceRevision: "unknown",
		buildSha256: "unknown",
		configurationId: "",
		sourceTreeState: "unknown",
		hostAtSuiteStart: "cold-tasks",
	})) {
		assert.throws(() => parseContextRunMetadata(JSON.stringify({ ...metadata, [field]: value })), /Invalid/)
	}
	assert.throws(
		() => parseContextRunMetadata(JSON.stringify({ ...metadata, sourceTreeState: "modified" })),
		/sourceDiffSha256/,
	)
})
