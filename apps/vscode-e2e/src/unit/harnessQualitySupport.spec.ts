import assert from "node:assert/strict"
import test from "node:test"
import { assertCommandSession, assertRepairChecks } from "../suite/harness-quality-support"
import type { Transaction } from "../suite/live-file-tool-support"

const transaction = (name: string, input: Record<string, unknown>, result: string): Transaction => ({
	name,
	input,
	result,
	isError: false,
})
const checker = "node live-acceptance/check.cjs"
const checks = [
	transaction("exec_command", { cmd: checker }, "Process exited with code 1\nOutput:\nAssertionError"),
	transaction("exec_command", { cmd: "type live-acceptance/invoice.cjs" }, "exports.total = ..."),
	transaction("exec_command", { cmd: "type live-acceptance/check.cjs" }, "assert.equal(...)"),
	transaction("exec_command", { cmd: checker }, "Process exited with code 0\nOutput:\n3 checks passed"),
] as const

test("repair validation counts exact checks while permitting separate file inspection", () => {
	assert.doesNotThrow(() => assertRepairChecks(checks, checker))
})

test("repair validation rejects extra checker runs and a missing initial failure", () => {
	assert.throws(() => assertRepairChecks([...checks, checks[0]], checker), /One failing baseline/)
	assert.throws(() => assertRepairChecks([checks[3], checks[3]], checker), /failing baseline and passing repair/)
})

test("chained commands do not satisfy the exact checker contract", () => {
	const chained = checks.map((call) => ({ ...call, input: { cmd: `${checker} && echo extra` } }))
	assert.throws(() => assertRepairChecks(chained, checker), /One failing baseline/)
})

const start = "node live-server/server.cjs"
const check = "node live-server/check.cjs"
const launch = transaction(
	"exec_command",
	{ cmd: start },
	"Process running with session ID 42\nOutput:\nREADY http://127.0.0.1:1234",
)
const verify = transaction("exec_command", { cmd: check }, "Process exited with code 0\nOutput:\nHTTP behavior passed")
const shutdown = transaction("write_stdin", { session_id: 42 }, "Process exited with code 0\nOutput:\nSERVER_STOPPED")

test("readiness in the initial launch is retained as valid session evidence", () => {
	assert.doesNotThrow(() => assertCommandSession([launch, verify, shutdown], start, check))
})

test("shutdown output and successful exit may arrive in consecutive polls", () => {
	assert.doesNotThrow(() =>
		assertCommandSession(
			[
				launch,
				verify,
				transaction(
					"write_stdin",
					{ session_id: 42 },
					"Process running with session ID 42\nOutput:\nSERVER_STOPPED",
				),
				transaction("write_stdin", { session_id: 42 }, "Process exited with code 0\nOutput:\n"),
			],
			start,
			check,
		),
	)
})

test("a successful exit without shutdown output cannot pass", () => {
	assert.throws(
		() =>
			assertCommandSession(
				[
					launch,
					verify,
					transaction("write_stdin", { session_id: 42 }, "Process exited with code 0\nOutput:\n"),
				],
				start,
				check,
			),
		/shutdown output/,
	)
})

test("a failed HTTP check cannot pass even when stdout contains the success marker", () => {
	assert.throws(
		() =>
			assertCommandSession(
				[launch, { ...verify, result: verify.result.replace("code 0", "code 1") }, shutdown],
				start,
				check,
			),
		/HTTP check must succeed/,
	)
})

test("a different session and failsafe termination cannot pass", () => {
	assert.throws(() => assertCommandSession([launch, verify, { ...shutdown, input: { session_id: 7 } }], start, check))
	assert.throws(
		() =>
			assertCommandSession(
				[launch, verify, { ...shutdown, result: shutdown.result + "\nSERVER_FAILSAFE_STOP" }],
				start,
				check,
			),
		/requested graceful shutdown/,
	)
})
