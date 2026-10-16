import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { createContext, runInContext } from "node:vm"
import { exerciseRenderedFileReview } from "./renderedFileReview"

test("file-review checks and focus keep adversarial fixture filenames as script-safe literal data", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-file-review-literals-"))
	const nonce = "file-review-literals"
	const fileNames = [
		"alpha-</script><script>globalThis.injected=true</script>.ts",
		"alpha-'\"\\\n\r\t\0\u2028\u2029` ${globalThis.injected=true}.ts",
		'alpha-雪😀-\\"));globalThis.injected=true;//.ts',
	]
	interface Button {
		textContent: string
		disabled: boolean
		getAttribute(name: string): string
		getBoundingClientRect(): { width: number }
		focus(): void
		press(): void
	}
	const state: { activeElement?: Button } = {}
	const focusedFiles: string[] = []
	const dynamicExpressions: string[] = []
	const button = (textContent: string, press: () => void): Button => ({
		textContent,
		disabled: false,
		getAttribute: () => "false",
		getBoundingClientRect: () => ({ width: 100 }),
		focus() {
			state.activeElement = this
			if (fileNames.includes(textContent)) focusedFiles.push(textContent)
		},
		press,
	})
	const expanded = [false, false, false]
	const files = fileNames.map((name, index) => ({
		...button(name, () => {
			expanded[index] = !expanded[index]
		}),
		getAttribute: () => String(expanded[index]),
	}))
	let activityExpanded = false
	const activity = {
		...button("Files edited: 3", () => {
			activityExpanded = !activityExpanded
		}),
		getAttribute: () => String(activityExpanded),
	}
	const review = button("Review", () => {
		expanded[2] = true
	})
	const nativeDiff = button("Show diff", () => {})
	const document = {
		get activeElement() {
			return state.activeElement
		},
		getElementById: () => null,
		body: { innerText: `Files edited: 3\n${fileNames.join("\n")}` },
		querySelector(selector: string) {
			if (selector === "[data-activity-trace-id][aria-expanded=false]") return activityExpanded ? null : activity
			if (selector === "[data-activity-trace-id]") return activity
			if (selector === "[data-testid=total-added]") return { textContent: "+3" }
			if (selector === "[data-testid=total-removed]") return { textContent: "-3" }
			if (selector === "button[aria-label=Review]") return review
			if (selector === 'button[aria-label^="Show diff:"]') return nativeDiff
			throw new Error(`Unexpected selector: ${selector}`)
		},
		querySelectorAll(selector: string) {
			if (selector === "button[aria-expanded]") return files
			assert.equal(selector, "[data-chat-message-index]")
			return [{ hidden: false, textContent: "alpha-file-review-fixture" }]
		},
	}
	const context = createContext({ document, injected: false })
	const cdp = {
		async request<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
			if (method === "Runtime.evaluate") {
				assert.equal(sessionId, "renderer")
				assert.equal(typeof params.expression, "string")
				const expression = String(params.expression)
				if (expression.includes("querySelectorAll('button[aria-expanded]')")) {
					dynamicExpressions.push(expression)
					assert.doesNotMatch(expression, /[<\u2028\u2029]/)
				}
				return { result: { value: runInContext(expression, context, { timeout: 100 }) } } as T
			}
			if (method === "Input.dispatchKeyEvent") {
				assert.equal(sessionId, "renderer")
				if (params.type === "keyDown") state.activeElement?.press()
			} else {
				assert.equal(sessionId, "workbench")
				assert.ok(["Page.bringToFront", "Page.captureScreenshot"].includes(method))
			}
			return { data: Buffer.from("fixture screenshot").toString("base64") } as T
		},
	}
	try {
		await fs.writeFile(path.join(directory, "ui-stage-file-review.json"), JSON.stringify({ nonce, fileNames }))
		assert.deepEqual(await exerciseRenderedFileReview(cdp, "renderer", "workbench", directory, nonce), [
			"file-review",
			"review-bottom-file-open",
			"review-all-files-closed",
			"review-native-file-diff",
		])
		assert.equal(context.injected, false)
		assert.deepEqual(focusedFiles, [fileNames[2], fileNames[0], fileNames[0], fileNames[2]])
		assert.ok(dynamicExpressions.length > fileNames.length)
		assert.deepEqual(expanded, [false, false, true])
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "ui-done-file-review.json"), "utf8")), {
			nonce,
			stage: "file-review",
			status: "passed",
		})
	} finally {
		await fs.rm(directory, { recursive: true, force: true })
	}
})
