import * as fs from "fs/promises"
import * as path from "path"

import { z } from "zod"

import type { CampaignConfig } from "./types"

const commandSchema = z.object({
	id: z
		.string()
		.min(1)
		.regex(/^[a-z0-9][a-z0-9-]*$/),
	command: z
		.string()
		.min(1)
		.refine((value) => !/[;&|`\r\n]/.test(value), "command must be a single executable"),
	args: z.array(z.string()).default([]),
	cwd: z.string().min(1).default("."),
})

export const campaignConfigSchema = z.object({
	version: z.literal(1),
	id: z
		.string()
		.min(1)
		.regex(/^[a-z0-9][a-z0-9-]*$/),
	target: z.string().min(1),
	suite: z.string().min(1).optional(),
	artifactRoot: z.string().min(1).default(".frontier-campaign/campaigns"),
	budgets: z.object({
		maxCampaignWallMs: z
			.number()
			.int()
			.positive()
			.max(24 * 60 * 60 * 1_000),
		maxCommandWallMs: z
			.number()
			.int()
			.positive()
			.max(60 * 60 * 1_000),
		maxCommands: z.number().int().positive().max(100),
		maxOutputBytesPerCommand: z
			.number()
			.int()
			.positive()
			.max(50 * 1024 * 1024),
	}),
	allowedCommandPrefixes: z.array(z.array(z.string().min(1)).min(1)).min(1),
	validationCommands: z.array(commandSchema).min(1),
	model: z.object({ enabled: z.literal(false) }),
})

export async function loadCampaignConfig(configPath: string): Promise<CampaignConfig> {
	const raw = await fs.readFile(configPath, "utf8")
	return campaignConfigSchema.parse(JSON.parse(raw)) as CampaignConfig
}

export function resolveContainedPath(root: string, candidate: string): string {
	const resolvedRoot = path.resolve(root)
	const resolved = path.resolve(resolvedRoot, candidate)
	const relative = path.relative(resolvedRoot, resolved)
	if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
		return resolved
	}
	throw new Error(`Path escapes repository root: ${candidate}`)
}

export function assertCommandAllowed(command: CampaignCommand, allowedPrefixes: string[][]): void {
	const tokens = [command.command, ...command.args]
	const allowed = allowedPrefixes.some(
		(prefix) => prefix.length <= tokens.length && prefix.every((token, index) => tokens[index] === token),
	)
	if (!allowed) {
		throw new Error(`Command is not allowlisted: ${tokens.join(" ")}`)
	}
}

type CampaignCommand = CampaignConfig["validationCommands"][number]
