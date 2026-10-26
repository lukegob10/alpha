import fs from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { z } from "zod"

const reference = z.object({ path: z.string().min(1), test: z.string().min(1) }).strict()
const manifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		claim: z.literal("observable-reference-map-only"),
		upstream: z
			.object({
				repository: z.literal("https://github.com/openai/codex"),
				commit: z.literal("970111f6cb62cc02fe36a82ea7d71b37a2889c97"),
				retrievedOn: z.literal("2026-10-23"),
			})
			.strict(),
		executionScope: z.string().min(1),
		excluded: z.array(z.string().min(1)).min(1),
		contracts: z
			.array(
				z
					.object({
						id: z.string().min(1),
						invariant: z.string().min(1),
						upstreamTests: z.array(reference).min(1),
						alphaTests: z.array(reference).min(1),
						normalization: z.array(z.string().min(1)).min(1),
						divergence: z
							.object({
								status: z.enum(["intentional", "unverified"]),
								explanation: z.string().min(1),
							})
							.strict(),
					})
					.strict(),
			)
			.length(6),
	})
	.strict()
const root = path.resolve(process.cwd(), "../..")
const load = async () =>
	manifestSchema.parse(
		JSON.parse(
			await fs.readFile(path.join(root, "evals/agent-workflows/codex-observable-reference-v1.json"), "utf8"),
		),
	)

describe("Codex observable reference map", () => {
	it("pins the inspected upstream revision and explicitly limits its claim", async () => {
		const manifest = await load()
		expect(manifest.executionScope).toContain("does not run upstream tests")
		expect(manifest.contracts.map(({ id }) => id).sort()).toEqual([
			"cancellation",
			"child-restoration",
			"compaction-reload",
			"completion",
			"step-settings",
			"tool-outcomes",
		])
		for (const contract of manifest.contracts) {
			for (const upstream of contract.upstreamTests) {
				expect(upstream.path).toMatch(/^codex-rs\/core\/tests\/suite\/[a-z_]+\.rs$/)
				expect(upstream.test).toMatch(/^[a-z_]+$/)
			}
		}
	})

	it("keeps every mapped Alpha test discoverable without claiming that it ran", async () => {
		const manifest = await load()
		for (const contract of manifest.contracts) {
			for (const local of contract.alphaTests) {
				const file = path.resolve(root, local.path)
				expect(path.relative(root, file)).not.toMatch(/^\.\./)
				expect(path.isAbsolute(local.path)).toBe(false)
				expect(local.path).toMatch(/^(?:src|apps)\/.*\.(?:spec|test)\.ts$/)
				expect(await fs.readFile(file, "utf8"), `${contract.id}: stale local test title`).toContain(local.test)
			}
		}
	})

	it("requires explicit review when changing the upstream reference or overstating verification", async () => {
		const manifest = await load()
		expect(() =>
			manifestSchema.parse({
				...manifest,
				upstream: { ...manifest.upstream, commit: "0".repeat(40) },
			}),
		).toThrow()
		expect(() => manifestSchema.parse({ ...manifest, claim: "differential-equivalence-verified" })).toThrow()
		expect(() =>
			manifestSchema.parse({
				...manifest,
				contracts: manifest.contracts.map((contract) => ({
					...contract,
					divergence: { status: "verified", explanation: "No differential run was executed." },
				})),
			}),
		).toThrow()
	})
})
