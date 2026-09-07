import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import { generateImageTool } from "../GenerateImageTool"
import type { Task } from "../../task/Task"
import { EXPERIMENT_IDS } from "../../../shared/experiments"
import { OpenRouterHandler } from "../../../api/providers/openrouter"
import { captureVerificationContent, extractMutationPaths } from "../../agent/VerificationScope"

vi.mock("../../../i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../i18n")>()
	const { default: enTools } = await import("../../../i18n/locales/en/tools.json")
	return {
		...actual,
		t: (key: string, options?: Record<string, unknown>) => {
			const [namespace, translationPath] = key.split(":")
			let value: unknown = namespace === "tools" ? enTools : undefined
			for (const segment of translationPath?.split(".") ?? []) {
				value =
					typeof value === "object" && value !== null
						? (value as Record<string, unknown>)[segment]
						: undefined
			}
			if (typeof value !== "string") return key
			return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? `{{${name}}}`))
		},
	}
})

vi.mock("../../../api/providers/openrouter", () => ({ OpenRouterHandler: vi.fn() }))
vi.mock("vscode", async (importOriginal) => {
	const original = await importOriginal<typeof vscode>()
	return {
		...original,
		window: { ...original.window, tabGroups: { all: [] } },
		TabInputCustom: class {
			constructor(public uri: vscode.Uri) {}
		},
	}
})

describe("generateImageTool output mutation safety", () => {
	const original = Buffer.from([0xff, 0x00, 0x81, 0x82, 0x03, 0x04])
	const changed = Buffer.from([0xff, 0x00, 0x83, 0x84, 0x03, 0x04])
	const generated = Buffer.from([0x89, 0x50, 0x4e, 0x47])
	let directory: string
	let destination: string
	let task: any
	let callbacks: any
	let controller: AbortController
	let generate: ReturnType<typeof vi.fn>

	beforeEach(async () => {
		vi.clearAllMocks()
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-image-mutation-"))
		destination = path.join(directory, "output.png")
		;(vscode.workspace as any).textDocuments = []
		;(vscode.window.tabGroups as any).all = []
		controller = new AbortController()
		generate = vi.fn().mockResolvedValue({
			success: true,
			imageData: `data:image/png;base64,${generated.toString("base64")}`,
		})
		vi.mocked(OpenRouterHandler).mockImplementation(() => ({ generateImage: generate }) as any)
		task = {
			cwd: directory,
			abort: false,
			consecutiveMistakeCount: 0,
			didEditFile: false,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			recordToolUsage: vi.fn(),
			say: vi.fn(),
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
			fileContextTracker: { trackFileContext: vi.fn() },
			providerRef: {
				deref: () => ({
					getState: async () => ({
						experiments: { [EXPERIMENT_IDS.IMAGE_GENERATION]: true },
						openRouterImageApiKey: "test-key",
					}),
				}),
			},
		}
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
			signal: controller.signal,
		}
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		;(vscode.workspace as any).textDocuments = []
		;(vscode.window.tabGroups as any).all = []
		await fs.rm(directory, { recursive: true, force: true })
	})

	const execute = (outputPath = "output.png", image?: string) =>
		generateImageTool.execute({ prompt: "Test image", path: outputPath, image }, task as Task, callbacks)

	function expectNoWriteReceipt() {
		expect(task.didEditFile).toBe(false)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		expect(task.say.mock.calls.some(([kind]: string[]) => kind === "image")).toBe(false)
	}

	for (const wait of ["approval", "generation"] as const) {
		for (const initiallyExists of [true, false]) {
			it(`preserves a destination ${initiallyExists ? "edited" : "created"} during ${wait}`, async () => {
				if (initiallyExists) await fs.writeFile(destination, original)
				const intervene = async () => {
					await fs.writeFile(destination, changed)
					return wait === "approval"
						? true
						: { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
				}
				;(wait === "approval" ? callbacks.askApproval : generate).mockImplementationOnce(intervene)

				await execute()

				expect(await fs.readFile(destination)).toEqual(changed)
				expectNoWriteReceipt()
				expect(task.didToolFailInCurrentTurn).toBe(true)
				expect(callbacks.handleError).toHaveBeenCalledWith("generating image", expect.any(Error))
			})
		}
	}

	it("does not recreate a destination deleted during generation", async () => {
		await fs.writeFile(destination, original)
		generate.mockImplementationOnce(async () => {
			await fs.unlink(destination)
			return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
		})
		await execute()
		await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
		expectNoWriteReceipt()
	})

	for (const wait of ["before approval", "approval", "generation"]) {
		it(`preserves an open dirty destination ${wait}`, async () => {
			await fs.writeFile(destination, original)
			const dirty = () => {
				;(vscode.workspace as any).textDocuments = [{ uri: vscode.Uri.file(destination), isDirty: true }]
			}
			if (wait === "before approval") dirty()
			if (wait === "approval")
				callbacks.askApproval.mockImplementationOnce(() => {
					dirty()
					return true
				})
			if (wait === "generation")
				generate.mockImplementationOnce(() => {
					dirty()
					return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
				})
			await execute()
			expect(await fs.readFile(destination)).toEqual(original)
			expectNoWriteReceipt()
		})
	}

	for (const kind of ["signal", "task"] as const) {
		for (const wait of ["approval", "generation", "mkdir"] as const) {
			it(`does not write after ${kind} cancellation during ${wait}`, async () => {
				await fs.writeFile(destination, original)
				const cancel = () => (kind === "signal" ? controller.abort() : (task.abort = true))
				if (wait === "approval")
					callbacks.askApproval.mockImplementationOnce(() => {
						cancel()
						return true
					})
				if (wait === "generation")
					generate.mockImplementationOnce(() => {
						cancel()
						return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
					})
				if (wait === "mkdir") {
					const mkdir = fs.mkdir.bind(fs)
					vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args: any[]) => {
						const result = await (mkdir as any)(...args)
						cancel()
						return result
					})
				}
				await execute()
				expect(await fs.readFile(destination)).toEqual(original)
				expectNoWriteReceipt()
				expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "cancelled" })
				if (wait === "approval") expect(generate).not.toHaveBeenCalled()
			})
		}
	}

	it("preserves a suffixed destination created during generation", async () => {
		generate.mockImplementationOnce(async () => {
			await fs.writeFile(destination, changed)
			return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
		})
		await execute("output")
		expect(await fs.readFile(destination)).toEqual(changed)
		expectNoWriteReceipt()
	})

	it("checks ignore policy on the actual suffixed destination", async () => {
		task.rooIgnoreController.validateAccess.mockImplementation((name: string) => name !== "output.png")
		await execute("output")
		await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
		expectNoWriteReceipt()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("output.png"))
	})

	it("requires protected-path approval on the actual suffixed destination", async () => {
		task.rooProtectedController.isWriteProtected.mockImplementation((name: string) => name === "output.png")
		callbacks.askApproval.mockImplementation(
			(_type: string, _message: string, _progress: unknown, force: boolean) => !force,
		)
		await execute("output")
		await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
		expect(callbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining("output.png"),
			undefined,
			true,
		)
		expectNoWriteReceipt()
	})

	it("writes the exact generated bytes when the approved destination is unchanged", async () => {
		await fs.writeFile(destination, original)
		await execute()
		expect(await fs.readFile(destination)).toEqual(generated)
		expect(task.didEditFile).toBe(true)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("creates a missing destination and retains input image data", async () => {
		const input = path.join(directory, "input.jpg")
		await fs.writeFile(input, original)
		await execute("output.png", "input.jpg")
		expect(await fs.readFile(destination)).toEqual(generated)
		expect(generate).toHaveBeenCalledWith(
			"Test image",
			expect.any(String),
			"test-key",
			`data:image/jpeg;base64,${original.toString("base64")}`,
		)
		expect(task.didEditFile).toBe(true)
	})

	it("exclusively creates a missing output when another writer races the final write", async () => {
		const open = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
			await fs.writeFile(destination, changed)
			return open(...args)
		})
		await execute()
		expect(await fs.readFile(destination)).toEqual(changed)
		expectNoWriteReceipt()
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"generating image",
			expect.objectContaining({ message: expect.stringContaining("created") }),
		)
	})

	it("preserves a same-byte file replacement during generation", async () => {
		await fs.writeFile(destination, original)
		generate.mockImplementationOnce(async () => {
			await fs.rename(destination, path.join(directory, "previous.png"))
			await fs.writeFile(destination, original)
			return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
		})
		await execute()
		expect(await fs.readFile(destination)).toEqual(original)
		expect(await fs.readFile(path.join(directory, "previous.png"))).toEqual(original)
		expectNoWriteReceipt()
	})

	for (const change of ["edit", "cancel"] as const) {
		it(`checks for a late ${change} after opening an existing output`, async () => {
			await fs.writeFile(destination, original)
			const open = fs.open.bind(fs)
			vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
				const handle = await open(...args)
				if (change === "edit") await fs.writeFile(destination, changed)
				else controller.abort()
				return handle
			})
			await execute()
			expect(await fs.readFile(destination)).toEqual(change === "edit" ? changed : original)
			expectNoWriteReceipt()
		})
	}

	it("preserves a dirty custom image editor", async () => {
		await fs.writeFile(destination, original)
		;(vscode.window.tabGroups as any).all = [
			{ tabs: [{ isDirty: true, input: new vscode.TabInputCustom(vscode.Uri.file(destination), "test.image") }] },
		]
		await execute()
		expect(await fs.readFile(destination)).toEqual(original)
		expectNoWriteReceipt()
	})

	it("preserves a dirty editor opened through a different directory alias", async () => {
		const actual = path.join(directory, "actual")
		const alias = path.join(directory, "alias")
		await fs.mkdir(actual)
		await fs.symlink(actual, alias, "junction")
		const output = path.join(actual, "output.png")
		await fs.writeFile(output, original)
		;(vscode.workspace as any).textDocuments = [{ uri: vscode.Uri.file(output), isDirty: true }]
		await execute("alias/output.png")
		expect(await fs.readFile(output)).toEqual(original)
		expectNoWriteReceipt()
	})

	for (const format of ["png", "jpg", "jpeg"]) {
		it(`approves the actual ${format} suffix and writes only that target`, async () => {
			generate.mockResolvedValue({
				success: true,
				imageData: `data:image/${format};base64,${generated.toString("base64")}`,
			})
			const actualName = `output.${format === "jpeg" ? "jpg" : format}`
			await execute("output")
			expect(await fs.readFile(path.join(directory, actualName))).toEqual(generated)
			await expect(fs.stat(path.join(directory, "output"))).rejects.toMatchObject({ code: "ENOENT" })
			expect(callbacks.askApproval).toHaveBeenLastCalledWith(
				"tool",
				expect.stringContaining(actualName),
				undefined,
				false,
			)
			expect(task.fileContextTracker.trackFileContext).toHaveBeenCalledWith(actualName, "roo_edited")
		})
	}

	for (const change of ["edit", "cancel", "deny"] as const) {
		it(`preserves the output after ${change} during exact-suffix approval`, async () => {
			await fs.writeFile(destination, original)
			callbacks.askApproval.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
				if (change === "edit") await fs.writeFile(destination, changed)
				if (change === "cancel") controller.abort()
				return change !== "deny"
			})
			await execute("output")
			expect(await fs.readFile(destination)).toEqual(change === "edit" ? changed : original)
			expectNoWriteReceipt()
		})
	}

	for (const policy of ["ignore", "protected"] as const) {
		it(`rechecks ${policy} policy after generation`, async () => {
			generate.mockImplementationOnce(() => {
				if (policy === "ignore") task.rooIgnoreController.validateAccess.mockReturnValue(false)
				else task.rooProtectedController.isWriteProtected.mockReturnValue(true)
				return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
			})
			await execute()
			await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
			expectNoWriteReceipt()
		})
	}

	for (const result of [
		{ success: false, error: "Provider rejected request" },
		{ success: true },
		{ success: true, imageData: "data:text/plain;base64,Zm9v" },
	]) {
		it(`does not write an unsuccessful or invalid provider response ${JSON.stringify(result)}`, async () => {
			generate.mockResolvedValue(result)
			await execute()
			await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" })
			expectNoWriteReceipt()
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		})
	}

	for (const failure of ["tracking", "presentation"] as const) {
		it(`reports the durable write if post-save ${failure} fails`, async () => {
			if (failure === "tracking")
				task.fileContextTracker.trackFileContext.mockRejectedValue(new Error("Tracking failed"))
			else task.say.mockRejectedValue(new Error("Presentation failed"))
			await execute()
			expect(await fs.readFile(destination)).toEqual(generated)
			expect(task.didEditFile).toBe(true)
			expect(task.didToolFailInCurrentTurn).toBe(false)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Image saved, but"))
		})
	}

	it("does not treat an inspection permission error as a missing file", async () => {
		await fs.writeFile(destination, original)
		vi.spyOn(fs, "lstat").mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { code: "EACCES" }))
		await execute()
		expect(await fs.readFile(destination)).toEqual(original)
		expect(generate).not.toHaveBeenCalled()
		expectNoWriteReceipt()
	})

	for (const format of ["png", "jpeg"]) {
		it(`captures the actual ${format} output in mutation accounting`, async () => {
			generate.mockResolvedValue({
				success: true,
				imageData: `data:image/${format};base64,${generated.toString("base64")}`,
			})
			const paths = extractMutationPaths({
				type: "tool_use",
				name: "generate_image",
				params: {},
				nativeArgs: { prompt: "Test image", path: "output" },
				partial: false,
			})!
			const before = await captureVerificationContent(directory, paths)
			await execute("output")
			const after = await captureVerificationContent(directory, paths)
			const target = format === "jpeg" ? "output.jpg" : "output.png"
			expect(before[target]).toBe("missing")
			expect(after[target]).toMatch(/^[a-f0-9]{64}$/)
			expect(Object.keys(after).filter((name) => after[name] !== before[name])).toEqual([target])
		})
	}

	it("requires outside-workspace approval through a directory junction", async () => {
		const workspace = path.join(directory, "workspace")
		const outside = path.join(directory, "outside")
		await fs.mkdir(workspace)
		await fs.mkdir(outside)
		await fs.symlink(outside, path.join(workspace, "linked"), "junction")
		task.cwd = workspace
		const previousFolders = vscode.workspace.workspaceFolders
		;(vscode.workspace as any).workspaceFolders = [{ uri: vscode.Uri.file(workspace) }]
		callbacks.askApproval.mockImplementation(
			(_type: string, message: string) => !JSON.parse(message).isOutsideWorkspace,
		)
		try {
			await execute("linked/output.png")
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(callbacks.askApproval).toHaveBeenCalledWith(
				"tool",
				expect.stringContaining('"isOutsideWorkspace":true'),
				undefined,
				false,
			)
			await expect(fs.stat(path.join(outside, "output.png"))).rejects.toMatchObject({ code: "ENOENT" })
			expectNoWriteReceipt()
		} finally {
			;(vscode.workspace as any).workspaceFolders = previousFolders
		}
	})

	it("preserves a destination whose parent directory is redirected during generation", async () => {
		const target = path.join(directory, "target")
		const redirected = path.join(directory, "redirected")
		await fs.mkdir(target)
		await fs.mkdir(redirected)
		generate.mockImplementationOnce(async () => {
			await fs.rename(target, path.join(directory, "previous"))
			await fs.symlink(redirected, target, "junction")
			return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
		})
		await execute("target/new/output.png")
		await expect(fs.stat(path.join(redirected, "new"))).rejects.toMatchObject({ code: "ENOENT" })
		expectNoWriteReceipt()
	})

	it("does not create parent directories after output policy is revoked", async () => {
		generate.mockImplementationOnce(() => {
			task.rooProtectedController.isWriteProtected.mockReturnValue(true)
			return { success: true, imageData: `data:image/png;base64,${generated.toString("base64")}` }
		})
		await execute("new/output.png")
		await expect(fs.stat(path.join(directory, "new"))).rejects.toMatchObject({ code: "ENOENT" })
		expectNoWriteReceipt()
	})

	for (const change of ["cancel", "policy", "dirty"] as const) {
		it(`finishes an exclusively created output if ${change} arrives after creation while open resolves`, async () => {
			const open = fs.open.bind(fs)
			vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
				const handle = await open(...args)
				expect(args[1]).toBe("wx")
				// Creation is already committed; pause its completion to inject the change.
				expect(await fs.readFile(destination)).toEqual(Buffer.alloc(0))
				if (change === "cancel") controller.abort()
				if (change === "policy") task.rooIgnoreController.validateAccess.mockReturnValue(false)
				if (change === "dirty") {
					;(vscode.workspace as any).textDocuments = [{ uri: vscode.Uri.file(destination), isDirty: true }]
				}
				return handle
			})
			await execute()
			expect(await fs.readFile(destination)).toEqual(generated)
			expect(task.didEditFile).toBe(true)
			expect(task.didToolFailInCurrentTurn).toBe(false)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(callbacks.setResultMetadata).not.toHaveBeenCalledWith({ status: "cancelled" })
		})
	}

	it("reports a completed write when closing the output handle fails", async () => {
		await fs.writeFile(destination, original)
		const open = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
			const handle = await open(...args)
			const close = handle.close.bind(handle)
			vi.spyOn(handle, "close").mockImplementationOnce(async () => {
				await close()
				throw new Error("Close failed after saving")
			})
			return handle
		})
		await execute()
		expect(await fs.readFile(destination)).toEqual(generated)
		expect(task.didEditFile).toBe(true)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Image saved, but"))
	})

	it("reports that a failed write may have changed the output", async () => {
		await fs.writeFile(destination, original)
		const open = fs.open.bind(fs)
		vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
			const handle = await open(...args)
			const write = handle.write.bind(handle)
			vi.spyOn(handle, "write").mockImplementationOnce(async () => {
				await write(generated, 0, 2, 0)
				throw new Error("Disk write failed")
			})
			return handle
		})
		await execute()
		expect(await fs.readFile(destination)).toEqual(Buffer.concat([generated.subarray(0, 2), original.subarray(2)]))
		expect(task.didEditFile).toBe(true)
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"generating image",
			expect.objectContaining({ message: expect.stringContaining("may be incomplete") }),
		)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
	})
})
