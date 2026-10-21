// pnpm --filter @alpha-code/core test src/custom-tools/__tests__/custom-tool-registry.spec.ts

import path from "path"
import * as fs from "fs/promises"
import os from "os"
import { registerHooks } from "module"
import { fileURLToPath, pathToFileURL } from "url"

import { execa } from "execa"

import { type CustomToolDefinition, parametersSchema as z } from "@alpha-code/types"

import { CustomToolRegistry } from "../custom-tool-registry.js"
import { runEsbuild, NODE_BUILTIN_MODULES, COMMONJS_REQUIRE_BANNER } from "../esbuild-runner.js"
import { createRegistryProcessTrace, type RegistryProcessTrace } from "./registry-process-trace.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const TEST_FIXTURES_DIR = path.join(__dirname, "fixtures")
const TEST_FIXTURES_OVERRIDE_DIR = path.join(__dirname, "fixtures-override")

describe("CustomToolRegistry", () => {
	let registry: CustomToolRegistry
	let nativeRegistryRoot: string
	let nativeRegistryBundle: string

	beforeAll(async () => {
		nativeRegistryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "custom-tool-native-registry-"))
		nativeRegistryBundle = path.join(nativeRegistryRoot, "registry.mjs")
		await runEsbuild({
			entryPoint: path.join(__dirname, "..", "custom-tool-registry.ts"),
			outfile: nativeRegistryBundle,
			external: NODE_BUILTIN_MODULES,
			banner: COMMONJS_REQUIRE_BANNER,
		})
	})

	afterAll(async () => {
		if (nativeRegistryRoot) await fs.rm(nativeRegistryRoot, { recursive: true, force: true })
	})

	beforeEach(() => {
		registry = new CustomToolRegistry()
	})

	async function runNativeScenario(body: string, signal: AbortSignal, trace?: RegistryProcessTrace): Promise<void> {
		trace?.stage("parent cache mkdir begin")
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "custom-tool-native-case-"))
		trace?.stage("parent cache mkdir complete", cacheDir)
		try {
			if (trace) await trace.instrumentBundle(nativeRegistryBundle)
			// A fresh Node process has no Vitest module hooks; require(esm) inside this worker still has them.
			const script = `
			import assert from "node:assert/strict"
			import { CustomToolRegistry } from ${JSON.stringify(pathToFileURL(trace?.bundle ?? nativeRegistryBundle).href)}
			const registry = new CustomToolRegistry({ cacheDir: ${JSON.stringify(cacheDir)} })
			const TEST_FIXTURES_DIR = ${JSON.stringify(TEST_FIXTURES_DIR)}
			const TEST_FIXTURES_OVERRIDE_DIR = ${JSON.stringify(TEST_FIXTURES_OVERRIDE_DIR)}
			${body}
		`
			const child = execa(
				process.execPath,
				[
					...(trace ? ["--require", trace.preload] : []),
					"--input-type=module",
					"--eval",
					trace ? trace.wrapScript(script) : script,
				],
				{
					stdin: "ignore",
					cancelSignal: signal,
					...(trace ? { env: trace.env } : {}),
				},
			)
			trace?.observe(child)
			await child
			trace?.stage("parent child await complete")
		} finally {
			trace?.stage("parent cache cleanup begin")
			await fs.rm(cacheDir, { recursive: true, force: true })
			trace?.stage("parent cache cleanup complete")
		}
	}

	it("keeps file-loading scenarios outside test-worker module hooks", async ({ signal }) => {
		const trace = createRegistryProcessTrace("worker-hook")
		trace?.bindSignal(signal)
		const hooks = registerHooks({
			load(url, context, nextLoad) {
				if (url.endsWith("/bundle.mjs")) throw new Error("Test-worker loader intercepted a custom tool")
				return nextLoad(url, context)
			},
		})
		trace?.stage("parent hook registered")
		try {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				assert.ok(result.loaded.includes("simple"))
				assert.equal(result.failed.length, 1)
				assert.equal(result.failed[0].file, "invalid.ts")
			`,
				signal,
				trace,
			)
		} finally {
			hooks.deregister()
			trace?.stage("parent hook deregistered")
			trace?.dispose()
		}
	}, 60_000)

	it("loads module URL characters through native imports and both compilation caches", async () => {
		const trace = createRegistryProcessTrace("encoded-paths")
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "custom-tool-paths-"))
		try {
			const toolDir = path.join(tempDir, "tools")
			const cacheDir = path.join(tempDir, "compiled #100%")
			const registryBundle = path.join(tempDir, "registry.mjs")
			await fs.mkdir(toolDir)
			await fs.writeFile(path.join(toolDir, "package.json"), JSON.stringify({ type: "module" }))
			for (const [file, name] of [
				["hash#.js", "hash_path"],
				["percent%.js", "percent_path"],
				["compiled.ts", "compiled_path"],
			] as const) {
				await fs.writeFile(
					path.join(toolDir, file),
					`${file.endsWith(".ts") ? 'import { parametersSchema } from "@alpha-code/types"; ' : ""}
					export default { name: "${name}", description: "Encoded path",
					${file.endsWith(".ts") ? "parameters: parametersSchema.object({})," : ""}
					execute: async () => "loaded" }`,
				)
			}
			// Exercise Node's actual file-URL loader; Vitest resolves dynamic imports through Vite.
			trace?.stage("parent registry compile begin")
			await runEsbuild({
				entryPoint: path.join(__dirname, "..", "custom-tool-registry.ts"),
				outfile: registryBundle,
				external: NODE_BUILTIN_MODULES,
				banner: COMMONJS_REQUIRE_BANNER,
			})
			trace?.stage("parent registry compile complete")
			if (trace) await trace.instrumentBundle(registryBundle)
			const script = `
				import assert from "node:assert/strict"
				import { CustomToolRegistry } from ${JSON.stringify(pathToFileURL(trace?.bundle ?? registryBundle).href)}
				const toolDir = ${JSON.stringify(toolDir)}
				const cacheDir = ${JSON.stringify(cacheDir)}
				const registry = new CustomToolRegistry({ cacheDir })
				for (const currentRegistry of [registry, registry, new CustomToolRegistry({ cacheDir })]) {
					const result = await currentRegistry.loadFromDirectory(toolDir)
					assert.deepEqual(result.failed, [])
					assert.deepEqual(result.loaded.sort(), ["compiled_path", "hash_path", "percent_path"])
					for (const name of result.loaded) {
						assert.equal(await currentRegistry.get(name).execute({}, {}), "loaded")
					}
					assert.deepEqual(currentRegistry.get("compiled_path").parameters.parse({}), {})
				}
			`
			const child = execa(
				process.execPath,
				[
					...(trace ? ["--require", trace.preload] : []),
					"--input-type=module",
					"--eval",
					trace ? trace.wrapScript(script) : script,
				],
				{ timeout: 25_000, ...(trace ? { env: trace.env } : {}) },
			)
			trace?.observe(child)
			await child
			trace?.stage("parent child await complete")
		} finally {
			trace?.stage("parent temporary cleanup begin")
			await fs.rm(tempDir, { recursive: true, force: true })
			trace?.stage("parent temporary cleanup complete")
			trace?.dispose()
		}
	}, 60_000)

	describe("validation", () => {
		it("should accept a valid tool definition", () => {
			const validTool = {
				name: "valid_tool",
				description: "A valid tool",
				parameters: z.object({ name: z.string() }),
				execute: async () => "result",
			}

			expect(() => registry.register(validTool)).not.toThrow()
			expect(registry.has("valid_tool")).toBe(true)
		})

		it("should reject empty description", () => {
			const invalidTool = {
				name: "invalid_tool",
				description: "",
				parameters: z.object({}),
				execute: async () => "result",
			}

			expect(() => registry.register(invalidTool as CustomToolDefinition)).toThrow(/Invalid tool definition/)
		})

		it("should reject non-Zod parameters", () => {
			const invalidTool = {
				name: "bad_params_tool",
				description: "Tool with bad params",
				parameters: { foo: "bar" },
				execute: async () => "result",
			}

			expect(() => registry.register(invalidTool as unknown as CustomToolDefinition)).toThrow(
				/Invalid tool definition/,
			)
		})

		it("should allow missing parameters", () => {
			const toolWithoutParams = {
				name: "no_params_tool",
				description: "Tool without parameters",
				execute: async () => "result",
			}

			expect(() => registry.register(toolWithoutParams)).not.toThrow()
			expect(registry.has("no_params_tool")).toBe(true)
		})

		it("should reject empty name", () => {
			const invalidTool = {
				name: "",
				description: "Tool with empty name",
				execute: async () => "result",
			}

			expect(() => registry.register(invalidTool as CustomToolDefinition)).toThrow(/Invalid tool definition/)
		})

		it("should reject missing name", () => {
			const invalidTool = {
				description: "Tool without name",
				execute: async () => "result",
			}

			expect(() => registry.register(invalidTool as unknown as CustomToolDefinition)).toThrow(
				/Invalid tool definition/,
			)
		})
	})

	describe("register", () => {
		it("should register a valid tool", () => {
			const tool: CustomToolDefinition = {
				name: "test_tool",
				description: "Test tool",
				parameters: z.object({ input: z.string() }),
				execute: async (args: { input: string }) => `Processed: ${args.input}`,
			}

			registry.register(tool)

			expect(registry.has("test_tool")).toBe(true)
			expect(registry.size).toBe(1)
		})

		it("should throw for invalid tool definition", () => {
			const invalidTool = {
				name: "bad_tool",
				description: "",
				execute: async () => "result",
			}

			expect(() => registry.register(invalidTool as CustomToolDefinition)).toThrow(/Invalid tool definition/)
		})

		it("should overwrite existing tool with same id", () => {
			const tool1: CustomToolDefinition = {
				name: "tool",
				description: "First version",
				execute: async () => "v1",
			}

			const tool2: CustomToolDefinition = {
				name: "tool",
				description: "Second version",
				execute: async () => "v2",
			}

			registry.register(tool1)
			registry.register(tool2)

			expect(registry.size).toBe(1)
			expect(registry.get("tool")?.description).toBe("Second version")
		})
	})

	describe("unregister", () => {
		it("should remove a registered tool", () => {
			registry.register({
				name: "tool",
				description: "Test",
				execute: async () => "result",
			})

			const result = registry.unregister("tool")

			expect(result).toBe(true)
			expect(registry.has("tool")).toBe(false)
		})

		it("should return false for non-existent tool", () => {
			const result = registry.unregister("nonexistent")
			expect(result).toBe(false)
		})
	})

	describe("get", () => {
		it("should return registered tool", () => {
			registry.register({
				name: "my_tool",
				description: "My tool",
				execute: async () => "result",
			})

			const tool = registry.get("my_tool")

			expect(tool).toBeDefined()
			expect(tool?.name).toBe("my_tool")
			expect(tool?.description).toBe("My tool")
		})

		it("should return undefined for non-existent tool", () => {
			expect(registry.get("nonexistent")).toBeUndefined()
		})
	})

	describe("list", () => {
		it("should return all tool IDs", () => {
			registry.register({ name: "tool_a", description: "A", execute: async () => "a" })
			registry.register({ name: "tool_b", description: "B", execute: async () => "b" })
			registry.register({ name: "tool_c", description: "C", execute: async () => "c" })

			const ids = registry.list()

			expect(ids).toHaveLength(3)
			expect(ids).toContain("tool_a")
			expect(ids).toContain("tool_b")
			expect(ids).toContain("tool_c")
		})

		it("should return empty array when no tools registered", () => {
			expect(registry.list()).toEqual([])
		})
	})

	describe("getAll", () => {
		it("should return all tools as array", () => {
			registry.register({ name: "tool1", description: "Tool 1", execute: async () => "1" })
			registry.register({ name: "tool2", description: "Tool 2", execute: async () => "2" })

			const all = registry.getAll()

			expect(all).toHaveLength(2)
			expect(all.find((t) => t.name === "tool1")?.description).toBe("Tool 1")
			expect(all.find((t) => t.name === "tool2")?.description).toBe("Tool 2")
		})
	})

	describe("clear", () => {
		it("should remove all registered tools", () => {
			registry.register({ name: "tool1", description: "1", execute: async () => "1" })
			registry.register({ name: "tool2", description: "2", execute: async () => "2" })

			expect(registry.size).toBe(2)

			registry.clear()

			expect(registry.size).toBe(0)
			expect(registry.list()).toEqual([])
		})
	})

	describe.sequential("loadFromDirectory", () => {
		it("should load tools from TypeScript files", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				assert.ok(result.loaded.includes("simple"))
				assert.equal(registry.has("simple"), true)
			`,
				signal,
			)
		}, 120_000)

		it("should handle named exports", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				assert.ok(result.loaded.includes("multi_toolA"))
				assert.ok(result.loaded.includes("multi_toolB"))
			`,
				signal,
			)
		}, 30000)

		it("should report validation failures", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				const invalidFailure = result.failed.find(f => f.file === "invalid.ts")
				assert.notEqual(invalidFailure, undefined)
				assert.ok(invalidFailure?.error.includes("Invalid tool definition"))
			`,
				signal,
			)
		}, 30000)

		it("should return empty results for non-existent directory", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory("/nonexistent/path")
				assert.equal(result.loaded.length, 0)
				assert.equal(result.failed.length, 0)
			`,
				signal,
			)
		})

		it("should skip non-tool exports silently", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				assert.ok(result.loaded.includes("mixed_validTool"))
				assert.equal(result.loaded.includes("mixed_someString"), false)
				assert.equal(result.loaded.includes("mixed_someNumber"), false)
				assert.equal(result.loaded.includes("mixed_someObject"), false)
			`,
				signal,
			)
		}, 30000)

		it("should support args as alias for parameters", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				assert.ok(result.loaded.includes("legacy"))
				assert.notEqual(registry.get("legacy")?.parameters, undefined)
			`,
				signal,
			)
		}, 30000)
	})

	describe.sequential("clearCache", () => {
		it("should clear the TypeScript compilation cache", async ({ signal }) => {
			await runNativeScenario(
				`
				await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				registry.clearCache()
				registry.clear()
				const result = await registry.loadFromDirectory(TEST_FIXTURES_DIR)
				assert.ok(result.loaded.includes("cached"))
			`,
				signal,
			)
		}, 120_000)
	})

	describe.sequential("loadFromDirectories", () => {
		it("should load tools from multiple directories", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])
				assert.ok(result.loaded.includes("simple"))
				assert.ok(result.loaded.includes("unique_override"))
				assert.ok(result.loaded.includes("multi_toolA"))
			`,
				signal,
			)
		}, 60000)

		it("should allow later directories to override earlier ones", async ({ signal }) => {
			await runNativeScenario(
				`
				await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])
				const simpleTool = registry.get("simple")
				assert.notEqual(simpleTool, undefined)
				assert.equal(simpleTool?.description, "Simple tool - OVERRIDDEN")
			`,
				signal,
			)
		}, 60000)

		it("should preserve order: first directory loaded first, second overrides", async ({ signal }) => {
			await runNativeScenario(
				`
				await registry.loadFromDirectories([TEST_FIXTURES_OVERRIDE_DIR, TEST_FIXTURES_DIR])
				const simpleTool = registry.get("simple")
				assert.notEqual(simpleTool, undefined)
				assert.equal(simpleTool?.description, "Simple tool")
			`,
				signal,
			)
		}, 60000)

		it("should handle non-existent directories in the array", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectories([
					"/nonexistent/path", TEST_FIXTURES_DIR, "/another/nonexistent",
				])
				assert.ok(result.loaded.includes("simple"))
				assert.equal(result.failed.length, 1)
			`,
				signal,
			)
		}, 60000)

		it("should handle empty array", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectories([])
				assert.equal(result.loaded.length, 0)
				assert.equal(result.failed.length, 0)
			`,
				signal,
			)
		})

		it("should combine results from all directories", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectories([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])
				assert.equal(result.loaded.filter(name => name === "simple").length, 2)
			`,
				signal,
			)
		}, 60000)
	})

	describe.sequential("loadFromDirectoriesIfStale", () => {
		it("should load tools from multiple directories when stale", async ({ signal }) => {
			await runNativeScenario(
				`
				const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])
				assert.ok(result.loaded.includes("simple"))
				assert.ok(result.loaded.includes("unique_override"))
			`,
				signal,
			)
		}, 60000)

		it("should restore a cleared catalog even if directory contents are unchanged", async ({ signal }) => {
			await runNativeScenario(
				`
				await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])
				registry.clear()
				const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])
				assert.ok(result.loaded.includes("simple"))
				assert.equal(registry.has("simple"), true)
			`,
				signal,
			)
		}, 30000)

		it("should handle mixed stale and non-stale directories", async ({ signal }) => {
			await runNativeScenario(
				`
				await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR])
				const result = await registry.loadFromDirectoriesIfStale([TEST_FIXTURES_DIR, TEST_FIXTURES_OVERRIDE_DIR])
				assert.ok(result.loaded.includes("simple"))
				assert.ok(result.loaded.includes("unique_override"))
			`,
				signal,
			)
		}, 60000)
	})
})
