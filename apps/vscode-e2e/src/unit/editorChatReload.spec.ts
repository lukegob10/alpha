import assert from "node:assert/strict"
import { test } from "node:test"

import type { ExtensionTestRunResult } from "../runTest"
import { assertEditorReloadHostPair } from "../runEditorChatReload"
import {
	createEditorReloadProvider,
	EDITOR_RELOAD_COMPLETION,
	EDITOR_RELOAD_DRAFTS,
	EDITOR_RELOAD_FRESH_INPUT,
	EDITOR_RELOAD_MODEL,
	parseEditorReloadTaskIds,
} from "../scenarios/editorChatReloadFixture"

test("editor reload provider observes data routing without retaining request bodies or credentials", async () => {
	const fixture = await createEditorReloadProvider()
	try {
		const catalog = await fetch(`${fixture.baseUrl}/models`).then((response) => response.json())
		assert.equal((catalog as { data: Array<{ id: string }> }).data[0]?.id, EDITOR_RELOAD_MODEL)
		assert.deepEqual(fixture.requests, [], "Discovery must not count as model invocation")
		const response = await fetch(`${fixture.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-fixture-marker" },
			body: JSON.stringify({
				model: EDITOR_RELOAD_MODEL,
				stream: false,
				messages: [{ role: "user", content: `${EDITOR_RELOAD_DRAFTS[0]} ${EDITOR_RELOAD_FRESH_INPUT}` }],
			}),
		}).then((value) => value.json())
		assert.equal(
			(response as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content,
			EDITOR_RELOAD_COMPLETION,
		)
		assert.deepEqual(fixture.requests, [
			{ freshContinuation: true, firstDraft: true, secondDraft: false, streaming: false },
		])
		assert.equal(JSON.stringify(fixture.requests).includes("synthetic-fixture-marker"), false)
		assert.equal((await fetch(`${fixture.baseUrl}/other`)).status, 404)
	} finally {
		await fixture.close()
		await fixture.close()
	}
})

function host(pid: number): ExtensionTestRunResult {
	return {
		launchKind: "development-sidecar",
		completionStatus: "passed",
		runId: `editor-${pid}`,
		exitCode: 0,
		providerMode: "scripted",
		vscodeVersion: "1.138.0",
		actualVSCodeVersion: "1.138.0",
		workspace: "/owned/workspace",
		userDataDir: "/owned/profile/1.138.0/user-data",
		extensionsDir: "/owned/profile/1.138.0/extensions",
		artifactsDir: `/owned/evidence/editor-${pid}`,
		retained: true,
		status: "passed",
		execution: "extension-host",
		hostExitObserved: true,
		extensionHostPid: pid,
		ownershipGate: "verified",
		captureComplete: true,
		evidenceManifestPath: `/owned/evidence/editor-${pid}/manifest.json`,
	}
}

test("reload correlation captures a validated distinct pair instead of trusting arbitrary indexed JSON", () => {
	assert.deepEqual(parseEditorReloadTaskIds(["first-task", "second-task"]), ["first-task", "second-task"])
	for (const value of [
		undefined,
		[],
		["first-task"],
		["same", "same"],
		["first", 2],
		["first", "../other"],
		["first", "second", "third"],
	])
		assert.throws(() => parseEditorReloadTaskIds(value))
})

test("restart certification requires two verified cold native hosts sharing only their dedicated profile", () => {
	const first = host(101)
	const second = host(102)
	assert.doesNotThrow(() => assertEditorReloadHostPair([first, second]))
	assert.throws(() => assertEditorReloadHostPair([first]))
	for (const change of [
		{ actualVSCodeVersion: "1.139.0" },
		{ execution: "test-seam" },
		{ launchKind: "extension-test" },
		{ status: "blocked" },
		{ exitCode: 1 },
		{ completionStatus: undefined },
		{ ownershipGate: undefined },
		{ hostExitObserved: false },
		{ captureComplete: false },
		{ evidenceManifestPath: undefined },
		{ extensionHostPid: 101 },
		{ userDataDir: "/another/profile" },
		{ workspace: "/another/workspace" },
	] as const) {
		assert.throws(() => assertEditorReloadHostPair([first, { ...second, ...change }]))
	}
})
