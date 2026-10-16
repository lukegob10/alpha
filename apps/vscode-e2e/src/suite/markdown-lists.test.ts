import * as assert from "assert"

import { AlphaCodeEventName, toolNames, type AlphaMessage } from "@alpha-code/types"

import { waitFor } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"
import { withBoundedFixtureCleanup } from "./proportional-context-support"

async function runMarkdownCase(prompt: string, verify: (messages: AlphaMessage[]) => void): Promise<void> {
	const api = globalThis.api
	const originalConfiguration = api.getConfiguration()
	const provider = (
		api as unknown as {
			sidebarProvider: {
				getLiveTask(taskId: string): { didComplete?: boolean; waitForTermination(): Promise<void> } | undefined
			}
		}
	).sidebarProvider
	const messages: Array<{ taskId: string; message: AlphaMessage }> = []
	const completions = new Set<string>()
	const onMessage = (event: { taskId: string; message: AlphaMessage }) => {
		if (event.message.type === "say" && event.message.partial === false) messages.push(event)
	}
	const onCompleted = (completedTaskId: string) => completions.add(completedTaskId)
	api.on(AlphaCodeEventName.Message, onMessage)
	api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
	let taskId: string | undefined
	await withBoundedFixtureCleanup(async () => {
		taskId = await api.startNewTask({
			configuration: {
				...originalConfiguration,
				mode: "code",
				autoApprovalEnabled: true,
				disabledTools: [...toolNames],
			},
			text: `Return the requested Markdown directly in this chat message. Do not inspect or edit workspace files, run commands, or use tools.\n\n${prompt}`,
		})
		await waitFor(() => completions.has(taskId!), { description: "Markdown task completion" })
		await provider.getLiveTask(taskId)?.waitForTermination()
		verify(messages.filter((event) => event.taskId === taskId).map((event) => event.message))
	}, [
		async () => {
			if (taskId && !provider.getLiveTask(taskId)?.didComplete) await api.cancelCurrentTask()
			if (taskId) await provider.getLiveTask(taskId)?.waitForTermination()
		},
		() => api.clearCurrentTask(),
		() => api.off(AlphaCodeEventName.Message, onMessage),
		() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
		() => api.setConfiguration(originalConfiguration),
	])
}

suite("Markdown chat source", function () {
	setDefaultSuiteTimeout(this)

	test("Should return unordered Markdown list lines in chat", async () => {
		await runMarkdownCase(
			"Please show me an example of an unordered list with the following items: Apple, Banana, Orange",
			(messages) => {
				// Find the message containing the list
				const listMessage = messages.find(
					({ say, text }) =>
						(say === "completion_result" || say === "text") &&
						text?.includes("Apple") &&
						text?.includes("Banana") &&
						text?.includes("Orange"),
				)

				assert.ok(listMessage, "Should have a message containing the list items")

				const messageText = listMessage?.text || ""
				for (const item of ["Apple", "Banana", "Orange"])
					assert.match(messageText, new RegExp(`^[ \\t]*[-*•][ \\t]+${item}[ \\t]*$`, "m"))
			},
		)
	})

	test("Should return ordered Markdown list lines in chat", async () => {
		await runMarkdownCase(
			"Please show me a numbered list with three steps: First step, Second step, Third step",
			(messages) => {
				// Find the message containing the numbered list
				const listMessage = messages.find(
					({ say, text }) =>
						(say === "completion_result" || say === "text") &&
						text?.includes("First step") &&
						text?.includes("Second step") &&
						text?.includes("Third step"),
				)

				assert.ok(listMessage, "Should have a message containing the numbered list")

				const messageText = listMessage?.text || ""
				for (const [index, item] of ["First step", "Second step", "Third step"].entries())
					assert.match(messageText, new RegExp(`^[ \\t]*${index + 1}[.)][ \\t]+${item}[ \\t]*$`, "m"))
			},
		)
	})

	test("Should return nested Markdown list lines with horizontal indentation", async () => {
		await runMarkdownCase(
			"Please create a nested list with 'Main item' having two sub-items: 'Sub-item A' and 'Sub-item B'",
			(messages) => {
				// Find the message containing the nested list
				const listMessage = messages.find(
					({ say, text }) =>
						(say === "completion_result" || say === "text") &&
						text?.includes("Main item") &&
						text?.includes("Sub-item A") &&
						text?.includes("Sub-item B"),
				)

				assert.ok(listMessage, "Should have a message containing the nested list")

				const messageText = listMessage?.text || ""
				assert.match(messageText, /^[-*•][ \t]+Main item[ \t]*$/m)
				for (const item of ["Sub-item A", "Sub-item B"])
					assert.match(messageText, new RegExp(`^(?: {2,}|\\t)[ \\t]*[-*•][ \\t]+${item}[ \\t]*$`, "m"))
			},
		)
	})

	test("Should return mixed ordered and unordered Markdown list lines", async () => {
		await runMarkdownCase(
			"Please create a list that has both numbered items and bullet points, mixing ordered and unordered lists",
			(messages) => {
				// Find a message that contains both types of lists
				const listMessage = messages.find(
					({ say, text }) =>
						(say === "completion_result" || say === "text") &&
						text &&
						/^[ \t]*\d+[.)][ \t]+\S/m.test(text) &&
						/^[ \t]*[-*•][ \t]+\S/m.test(text),
				)

				assert.ok(listMessage, "Should have a message containing mixed list types")
			},
		)
	})
})
