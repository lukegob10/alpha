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
	hasAttribute(name: string): boolean
	querySelector(selector: string): null
	getAttribute(name: string): string | null
	getBoundingClientRect(): { width: number }
}

/** Runs the actual probe expressions and trusted keyboard events against controlled accordion state. */
class ControlledFileReview implements Pick<CdpConnection, "request"> {
	readonly nativeActions: string[] = []
	readonly reviewActions: string[] = []
	private nativeCollapsed = false
	private nativeSideBySide = false
	private quickPickOpen = false
	private quickPickText = ""
	private nativeFocused: string | undefined
	private readonly nativeContext
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
				hasAttribute: (name) => name === "aria-expanded" && !!expanded,
				querySelector: () => null,
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
			reviewed()
		})
		let panelExpanded = false
		const panel = button(
			"Files edited: 3",
			undefined,
			() => {
				panelExpanded = !panelExpanded
			},
			() => panelExpanded,
		)
		const diffs = names.map((fileName) =>
			button(fileName, `Show diff: ${fileName}`, () => {
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
				if (selector === "button[aria-expanded]") return [panel]
				if (selector === "button") return [trace, review, panel, ...diffs]
				assert.equal(selector, "[data-chat-message-index]")
				return [{ hidden: !traceExpanded, textContent: `alpha-file-review-fixture\n${names.join("\n")}` }]
			},
		}
		const actions = ["Review Actions…", "Collapse All Diffs", "Expand All Diffs"].map((label) => ({
			getAttribute: () => label,
			getBoundingClientRect: () => ({
				width: label === "Review Actions…" || (label === "Expand All Diffs") === this.nativeCollapsed ? 100 : 0,
			}),
			focus: () => {
				this.nativeFocused = label
			},
		}))
		const nativeDocument = {
			get activeElement() {
				return actions.find((action) => action.getAttribute() === nativeFocused())
			},
			querySelectorAll: (selector: string) =>
				selector === ".multiDiffEntry .status.renamed"
					? []
					: selector === ".multiDiffEntry .monaco-diff-editor"
						? fileNames.map(() => ({ classList: { contains: () => this.nativeSideBySide } }))
						: selector === ".multiDiffEntry .editorContainer"
							? fileNames.map(() => ({ style: { display: this.nativeCollapsed ? "none" : "block" } }))
							: actions,
			querySelector: () => ({
				getBoundingClientRect: () => ({ width: this.quickPickOpen ? 100 : 0 }),
				textContent: this.quickPickText,
			}),
		}
		const nativeFocused = () => this.nativeFocused
		this.nativeContext = createContext({ document: nativeDocument })
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
		if (session === workbenchSession) {
			if (method === "Runtime.evaluate") {
				return {
					result: { value: runInContext(String(params.expression), this.nativeContext, { timeout: 100 }) },
				} as T
			}
			if (method === "Input.insertText") {
				this.quickPickText = String(params.text)
				return {} as T
			}
			assert.equal(method, "Input.dispatchKeyEvent")
			if (params.type === "keyUp") {
				if (params.key === "Enter") {
					if (!this.quickPickOpen) {
						this.quickPickOpen = true
						this.quickPickText = ""
					} else {
						this.reviewActions.push(this.quickPickText)
						if (this.quickPickText === "Side-by-side view") this.nativeSideBySide = true
						if (this.quickPickText === "Inline view") this.nativeSideBySide = false
						if (this.quickPickText === "Collapse all files") this.nativeCollapsed = true
						if (this.quickPickText === "Expand all files") this.nativeCollapsed = false
						this.quickPickOpen = false
					}
				} else {
					assert.equal(params.modifiers, 3)
					assert.ok(params.key === "0" || params.key === "9")
					this.nativeCollapsed = params.key === "0"
					this.reviewActions.push(`key:${params.key}`)
				}
			}
			return {} as T
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
	await fs.writeFile(
		path.join(directory, "ui-stage-file-review-controls.json"),
		JSON.stringify({ nonce, stage: "file-review-controls" }),
	)
	const renderer = new ControlledFileReview(names)
	assert.deepEqual(await exerciseRenderedFileReview(renderer, rendererSession, workbenchSession, directory, nonce), [
		"file-review",
		"review-native-multi-diff",
		"review-collapse-expand-navigation",
		"review-side-by-side-layout",
		"review-chat-stays-collapsed",
		"review-full-row-actions",
		"review-native-file-diff",
	])
	assert.deepEqual(renderer.reviewActions, [
		"Collapse all files",
		"Expand all files",
		"Inline view",
		"Side-by-side view",
		"Next change",
		"Previous change",
		"key:0",
		"key:9",
	])
	assert.equal(renderer.injected, false)
	assert.deepEqual(renderer.focusedFiles, [names[1]])
	assert.ok(renderer.dynamicExpressions.length > names.length)
	assert.deepEqual([...renderer.expandedFiles], [])
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
		await fs.writeFile(
			path.join(directory, "ui-stage-file-review-controls.json"),
			JSON.stringify({ nonce, stage: "file-review-controls" }),
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
