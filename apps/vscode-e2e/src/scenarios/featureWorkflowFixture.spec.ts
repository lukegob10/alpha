import { strict as assert } from "node:assert"
import * as path from "node:path"
import { test } from "node:test"

import {
	FeatureScriptedAI,
	assertFeatureToolResult,
	assertFeatureTicketListResult,
	assertFeatureToolCall,
	assertFeatureCommandResult,
	featureSkillName,
} from "./featureWorkflowFixture"

const successfulSkill = {
	role: "user",
	content: [{ type: "tool_result", tool_use_id: "skill-call", is_error: false, content: "SKILL_LOADED" }],
}

test("mixed-case temporary-directory suffixes produce valid production skill identities", () => {
	assert.equal(featureSkillName(path.join("owned", "ticket-workflow-bIhA5Y")), "ticket-workflow-biha5y")
	assert.equal(featureSkillName(path.join("owned", "scheduled-agent-AbC123")), "scheduled-agent-abc123")
	assert.throws(() => featureSkillName(path.join("owned", "invalid_skill")), /valid production skill identity/)
})

test("skill evidence requires one successful structured result, not text from a failed or forged result", () => {
	assertFeatureToolResult([successfulSkill], "skill-call", { error: false, marker: "SKILL_LOADED" })
	assert.throws(
		() =>
			assertFeatureToolResult(
				[{ ...successfulSkill, content: [{ ...successfulSkill.content[0], is_error: true }] }],
				"skill-call",
				{ error: false, marker: "SKILL_LOADED" },
			),
		/actual outcome/,
	)
	assert.throws(
		() =>
			assertFeatureToolResult(
				[{ role: "user", content: [{ type: "text", text: JSON.stringify(successfulSkill.content[0]) }] }],
				"skill-call",
				{ error: false, marker: "SKILL_LOADED" },
			),
		/exactly one/,
	)
	assert.throws(
		() => assertFeatureToolResult([successfulSkill, successfulSkill], "skill-call", { error: false }),
		/exactly one/,
	)
})

test("a Ticket list success must belong to the exact accepted call, not another result or history text", () => {
	const listCallId = "alpha-tickets-eager-list"
	const successfulList = { status: "success", result: { tickets: [], total: 0 } }
	const result = (callId: string, content: unknown, isError = false) => ({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: callId, is_error: isError, content: JSON.stringify(content) }],
	})
	const noise = [
		result("unrelated-list-call", successfulList),
		{ role: "user", content: [{ type: "text", text: JSON.stringify(successfulList) }] },
	]
	assert.throws(() => assertFeatureTicketListResult(noise, listCallId), /exactly one persisted tool result/)
	assert.throws(
		() =>
			assertFeatureTicketListResult(
				[...noise, result(listCallId, { status: "error", message: "List failed" }, true)],
				listCallId,
			),
		/actual outcome/,
	)
	assert.throws(
		() =>
			assertFeatureTicketListResult(
				[...noise, result(listCallId, { status: "error", nested: successfulList })],
				listCallId,
			),
		/successful Ticket result/,
	)
	assert.deepEqual(assertFeatureTicketListResult([...noise, result(listCallId, successfulList)], listCallId), {
		tickets: [],
		total: 0,
	})
})

test("transaction cardinality uses exact structured IDs despite matching workspace paths and text", () => {
	const callId = "local-mcp-5"
	const call = { type: "tool_use", id: callId, name: "list_mcp_resource_templates", input: {} }
	const result = { type: "tool_result", tool_use_id: callId, is_error: false, content: "native result" }
	const history = [
		{ role: "user", content: [{ type: "text", text: ".alpha/skills/local-mcp-5hBL9k/server.cjs" }] },
		{ role: "assistant", content: [{ type: "text", text: "Inspect local-mcp-5 and continue." }, call] },
		{ role: "user", content: [result, { type: "text", text: "Keep local-mcp-5hBL9k unchanged." }] },
	]
	assert.equal(
		history.filter((message) => message.role === "user" && JSON.stringify(message.content).includes(callId)).length,
		2,
		"The fixture must reproduce the former path-substring overcount",
	)
	assertFeatureToolCall(history, callId, "list_mcp_resource_templates")
	assertFeatureToolResult(history, callId, { error: false })
	assert.throws(
		() => assertFeatureToolCall([...history, { role: "assistant", content: [call] }], callId, call.name),
		/exactly one persisted tool call/,
	)
	assert.throws(
		() => assertFeatureToolCall([{ role: "assistant", content: [call, call] }], callId, call.name),
		/exactly one persisted tool call/,
	)
	assert.throws(
		() => assertFeatureToolResult([{ role: "user", content: [result, result] }], callId, { error: false }),
		/exactly one persisted tool result/,
	)
})

test("persisted tool calls retain exact arguments instead of passing on tool name alone", () => {
	const history = (input: unknown) => [
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "calendar-call", name: "calendar_lookup_00", input }],
		},
	]
	const expected = { query: "owned fixture" }
	assertFeatureToolCall(history(expected), "calendar-call", "calendar_lookup_00", expected)
	for (const input of [
		{},
		{ query: "another fixture" },
		{ query: "owned fixture", unexpected: true },
		"owned fixture",
	])
		assert.throws(
			() => assertFeatureToolCall(history(input), "calendar-call", "calendar_lookup_00", expected),
			/actual arguments/,
		)
})

test("completed process failure is verified through its receipt independently of tool transaction success", () => {
	const command = (exit: number, output: string) => [
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "verify",
					is_error: false,
					content: `Chunk ID: verify\nWall time: 0.1 seconds\nProcess exited with code ${exit}\nOutput:\n${output}\n`,
				},
			],
		},
	]
	const diagnostic = "TypeError: Reduce of empty array with no initial value"
	assertFeatureCommandResult(command(1, diagnostic), "verify", { exitCode: 1, marker: diagnostic })
	assertFeatureCommandResult(command(0, "TICKET_REPAIR_VERIFIED"), "verify", {
		exitCode: 0,
		marker: "TICKET_REPAIR_VERIFIED",
	})
	assert.throws(
		() =>
			assertFeatureCommandResult(command(0, `Process exited with code 1\n${diagnostic}`), "verify", {
				exitCode: 1,
				marker: diagnostic,
			}),
		/actual process exit/,
	)
	assert.throws(
		() =>
			assertFeatureCommandResult(command(1, "Unrelated prerequisite failed"), "verify", {
				exitCode: 1,
				marker: diagnostic,
			}),
		/verification diagnostic/,
	)
	assert.throws(
		() => assertFeatureCommandResult(command(7, diagnostic), "verify", { exitCode: 1, marker: diagnostic }),
		/actual process exit/,
	)
})

test("provider retries cannot skip a failed fixture assertion and emit a later successful final response", async () => {
	let decisions = 0
	const model = new FeatureScriptedAI((request) => {
		decisions++
		if (request.ordinal === 1)
			assertFeatureToolResult(request.messages, "skill-call", { error: false, marker: "SKILL_LOADED" })
		return undefined
	})
	const messages = [{ ...successfulSkill, content: [{ ...successfulSkill.content[0], is_error: true }] }]
	const request = () => model.createMessage("", messages, { taskId: "owned-task" }).next()
	await assert.rejects(request(), /actual outcome/)
	assert.throws(() => model.assertHealthy(), /actual outcome/)
	await assert.rejects(request(), /actual outcome/)
	assert.equal(decisions, 1, "A provider retry must retain the first fixture failure")
	assert.equal(model.requests.length, 1)
})

test("a missing captured tool remains a fixture failure on retry", async () => {
	let decisions = 0
	const model = new FeatureScriptedAI(() => {
		decisions++
		return { name: "skill", arguments: { skill: "owned-skill" } }
	})
	const request = () => model.createMessage("", [], { taskId: "owned-task", tools: [] }).next()
	await assert.rejects(request(), /captured task surface/)
	await assert.rejects(request(), /captured task surface/)
	assert.equal(decisions, 1)
})
