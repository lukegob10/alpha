import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { createContext, runInContext } from "node:vm"

import { waitUntil } from "../evidence/sharedStorageProtocol"
import type { CdpConnection } from "./cdp"
import { exerciseRenderedFileReview } from "./renderedFileReview"

const nonce = "a5dc879d-ea3e-4f6a-b41d-99c2977493be"
const fileNames = ["alpha-file-review-one.txt", "alpha-file-review-two.txt", "alpha-file-review-three.txt"]
const rendererSession = "file-review-renderer"
const workbenchSession = "file-review-workbench"

interface ReviewButton {
	textContent: string
	disabled: boolean
	focus(): void
	activate(): void
	getAttribute(name: string): string | null
	getBoundingClientRect(): { width: number }
}

/** Runs the actual probe expressions and trusted keyboard events against controlled accordion state. */
class ControlledFileReview implements Pick<CdpConnection, "request"> {
	readonly nativeActions: string[] = []
	readonly focusedFiles: string[] = []
	readonly dynamicExpressions: string[] = []
	readonly expandedFiles = new Set<string>()
	readonly reviewed: Promise<void>
	private activeButton: ReviewButton | undefined
	private readonly context

	constructor(names = fileNames) {
		let reviewed!: () => void
		this.reviewed = new Promise<void>((resolve) => {
			reviewed = resolve
		})
		const button = (
			textContent: string,
			label: string | undefined,
			activate: () => void,
			expanded?: () => boolean,
		): ReviewButton => {
			const element: ReviewButton = {
				textContent,
				disabled: false,
				focus: () => {
					this.activeButton = element
					if (names.includes(textContent)) this.focusedFiles.push(textContent)
				},
				activate,
				getAttribute: (name) =>
					name === "aria-label"
						? (label ?? null)
						: name === "aria-expanded" && expanded
							? String(expanded())
							: null,
				getBoundingClientRect: () => ({ width: 100 }),
			}
			return element
		}
		let traceExpanded = false
		const expandedFiles = this.expandedFiles
		const trace = button(
			"Worked for 2s",
			undefined,
			() => {
				traceExpanded = !traceExpanded
			},
			() => traceExpanded,
		)
		const review = button("Review", "Review", () => {
			this.nativeActions.push("review")
			expandedFiles.add(names[2]!)
			reviewed()
		})
		const toggles = names.map((fileName) =>
			button(
				fileName,
				undefined,
				() => {
					if (expandedFiles.has(fileName)) expandedFiles.delete(fileName)
					else expandedFiles.add(fileName)
				},
				() => expandedFiles.has(fileName),
			),
		)
		const diffs = names.map((fileName) =>
			button("+1 -1", `Show diff: ${fileName}`, () => {
				this.nativeActions.push(`diff:${fileName}`)
			}),
		)
		const activeElement = () => this.activeButton
		const document = {
			body: { innerText: `Files edited: 3\n${names.join("\n")}` },
			get activeElement() {
				return activeElement()
			},
			getElementById: () => null,
			querySelector: (selector: string): unknown => {
				switch (selector) {
					case "[data-activity-trace-id][aria-expanded=false]":
						return traceExpanded ? null : trace
					case "[data-activity-trace-id]":
						return trace
					case "[data-testid=total-added]":
						return { textContent: "+3" }
					case "[data-testid=total-removed]":
						return { textContent: "-3" }
					case "button[aria-label=Review]":
						return review
					default:
						throw new Error(`Unexpected selector: ${selector}`)
				}
			},
			querySelectorAll: (selector: string): unknown[] => {
				if (selector === "button[aria-expanded]") return toggles
				if (selector === "button") return [trace, review, ...toggles, ...diffs]
				assert.equal(selector, "[data-chat-message-index]")
				return [{ hidden: !traceExpanded, textContent: `alpha-file-review-fixture\n${names.join("\n")}` }]
			},
		}
		this.context = createContext({ document, injected: false })
	}

	get injected(): unknown {
		return this.context.injected
	}

	async request<T>(method: string, params: Record<string, unknown> = {}, session?: string): Promise<T> {
		if (method === "Page.bringToFront" || method === "Page.captureScreenshot") {
			assert.equal(session, workbenchSession)
			return (method === "Page.captureScreenshot" ? { data: "" } : {}) as T
		}
		assert.equal(session, rendererSession)
		if (method === "Runtime.evaluate") {
			assert.equal(params.returnByValue, true)
			const expression = String(params.expression)
			if (expression.includes("querySelectorAll('button")) {
				this.dynamicExpressions.push(expression)
				assert.doesNotMatch(expression, /[<\u2028\u2029]/)
			}
			return { result: { value: runInContext(expression, this.context, { timeout: 100 }) } } as T
		}
		assert.equal(method, "Input.dispatchKeyEvent")
		assert.equal(params.key, "Enter")
		if (params.type === "keyUp") {
			assert.ok(this.activeButton)
			this.activeButton.activate()
		}
		return {} as T
	}
}

test("file-review checks and focus keep adversarial fixture filenames as script-safe literal data", async (context) => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-file-review-literals-"))
	context.after(() => fs.rm(directory, { recursive: true, force: true }))
	const names = [
		"alpha-</script><script>globalThis.injected=true</script>.ts",
		"alpha-'\"\\\n\r\t\0\u2028\u2029` ${globalThis.injected=true}.ts",
		'alpha-雪😀-\\"));globalThis.injected=true;//.ts',
	]
	await fs.writeFile(
		path.join(directory, "ui-stage-file-review.json"),
		JSON.stringify({ nonce, stage: "file-review", fileNames: names }),
	)
	await fs.writeFile(
		path.join(directory, "ui-stage-file-review-file.json"),
		JSON.stringify({ nonce, stage: "file-review-file", fileName: names[1] }),
	)
	const renderer = new ControlledFileReview(names)
	assert.deepEqual(await exerciseRenderedFileReview(renderer, rendererSession, workbenchSession, directory, nonce), [
		"file-review",
		"review-native-multi-diff",
		"review-bottom-file-open",
		"review-all-files-closed",
		"review-native-file-diff",
	])
	assert.equal(renderer.injected, false)
	assert.deepEqual(renderer.focusedFiles, [names[2], names[0], names[0], names[2]])
	assert.ok(renderer.dynamicExpressions.length > names.length)
	assert.deepEqual([...renderer.expandedFiles], [names[2]])
	assert.deepEqual(renderer.nativeActions, ["review", `diff:${names[1]}`])
})

async function waitForReviewReceipt(directory: string): Promise<void> {
	await waitUntil(
		async () => {
			try {
				const receipt = JSON.parse(await fs.readFile(path.join(directory, "ui-done-file-review.json"), "utf8"))
				assert.deepEqual(receipt, { nonce, stage: "file-review", status: "passed" })
				return true
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
				throw error
			}
		},
		Date.now() + 5_000,
		"review_receipt_timeout",
	)
}

for (const response of ["verified", "stale", "cancelled"] as const) {
	test(`per-file input waits for host verification and handles a ${response} response`, async (context) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-file-review-driver-"))
		context.after(() => fs.rm(directory, { recursive: true, force: true }))
		await fs.writeFile(
			path.join(directory, "ui-stage-file-review.json"),
			JSON.stringify({ nonce, stage: "file-review", fileNames }),
		)
		const renderer = new ControlledFileReview()
		const controller = new AbortController()
		context.after(() => controller.abort())
		const operation = exerciseRenderedFileReview(
			renderer,
			rendererSession,
			workbenchSession,
			directory,
			nonce,
			controller.signal,
		)
		const outcome = operation.then(
			(stages) => ({ stages, error: undefined }),
			(error: unknown) => ({ stages: undefined, error }),
		)
		await Promise.race([
			renderer.reviewed,
			operation.then(() => assert.fail("The driver must request Review before completing")),
		])
		await waitForReviewReceipt(directory)
		assert.deepEqual(renderer.nativeActions, ["review"], "Per-file input requires the host's verified next stage")
		if (response === "cancelled") controller.abort(new Error("Host verification cancelled"))
		else {
			await fs.writeFile(
				path.join(directory, "ui-stage-file-review-file.json"),
				JSON.stringify({
					nonce: response === "stale" ? "different-run" : nonce,
					stage: "file-review-file",
					fileName: fileNames[1],
				}),
			)
		}
		const result = await outcome
		if (response !== "verified") {
			assert.ok(result.error)
			if (response === "cancelled") assert.match(String(result.error), /Host verification cancelled/)
			assert.deepEqual(renderer.nativeActions, ["review"])
			await assert.rejects(fs.access(path.join(directory, "ui-done-file-review-file.json")), { code: "ENOENT" })
			return
		}
		assert.equal(result.error, undefined)
		assert.ok(result.stages?.includes("review-native-multi-diff"))
		assert.deepEqual(renderer.nativeActions, ["review", `diff:${fileNames[1]}`])
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "ui-done-file-review-file.json"), "utf8")), {
			nonce,
			stage: "file-review-file",
			status: "passed",
		})
	})
}
