import { strict as assert } from "node:assert"
import type { Transaction } from "./live-file-tool-support"

export function assertRepairChecks(calls: readonly Transaction[], command: string): void {
	const checks = calls.filter((call) => call.name === "exec_command" && String(call.input.cmd).trim() === command)
	assert.equal(checks.length, 2, "One failing baseline and one passing repair check")
	assert.ok(
		checks.every((call) => !call.isError),
		"Checker process exits must retain successful tool transactions",
	)
	assert.deepEqual(
		checks.map((call) => /^Process exited with code (\d+)$/m.exec(call.result)?.[1]),
		["1", "0"],
		"Persisted tool results must show the failing baseline and passing repair",
	)
	assert.ok(checks[0] && checks[1])
	assert.match(checks[0].result, /AssertionError/)
	assert.match(checks[1].result, /3 checks passed/)
}

export function assertCommandSession(calls: readonly Transaction[], startCommand: string, checkCommand: string): void {
	const commands = calls.filter((call) => call.name === "exec_command")
	const launches = commands.filter((call) => call.input.cmd === startCommand)
	assert.equal(launches.length, 1, "The fixture must start exactly one owned server")
	const launch = launches[0]
	assert.ok(launch)
	assert.ok(!launch.isError)
	const sessionId = /Process running with session ID (\d+)/.exec(launch.result)?.[1]
	assert.ok(sessionId, "The background launch must expose a numeric session ID")
	assert.equal(commands.length, 2, "Only the fixture start and one HTTP check command may run")
	assert.ok(
		commands.some(
			(call) =>
				call.input.cmd === checkCommand &&
				!call.isError &&
				/^Process exited with code 0$/m.test(call.result) &&
				/HTTP behavior passed/.test(call.result),
		),
		"The fixture HTTP check must succeed",
	)
	const polls = calls.filter((call) => call.name === "write_stdin")
	assert.ok(polls.length > 0, "The model must use write_stdin to observe its command session")
	assert.ok(polls.every((call) => call.input.session_id === Number(sessionId) && !call.isError))
	const output = [launch.result, ...polls.map((call) => call.result)].join("\n")
	assert.match(output, /READY /, "Readiness may arrive in the launch or a subsequent poll")
	assert.doesNotMatch(output, /SERVER_FAILSAFE_STOP/, "The server must stop through the requested graceful shutdown")
	assert.ok(
		polls.some((call) => call.result.includes("SERVER_STOPPED")),
		"A session poll must deliver the owned server shutdown output",
	)
	assert.match(polls.at(-1)!.result, /^Process exited with code 0$/m, "The final poll must observe successful exit")
}
