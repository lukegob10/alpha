import type { HarnessProcessRunner } from "../orchestration/index"

export async function captureWorkspaceBaseline(workspaceRoot: string, runner: HarnessProcessRunner): Promise<string> {
	const commit = (await readGitEvidence(workspaceRoot, runner, ["rev-parse", "--verify", "HEAD"])).trim()
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Invalid workspace baseline evidence")
	return commit
}

export async function collectChangedPaths(
	workspaceRoot: string,
	runner: HarnessProcessRunner,
	baselineCommit: string,
): Promise<string[]> {
	// Index flags can hide real working-tree edits even when comparing against the starting commit.
	const indexed = (await readGitEvidence(workspaceRoot, runner, ["ls-files", "-v", "-z", "--", "."])).split("\0")
	if (indexed.pop() !== "") throw new Error("Incomplete workspace index evidence")
	for (const record of indexed) {
		if (!/^[HSMRCK?hsmrck] /.test(record) || record.length < 3) throw new Error("Invalid workspace index evidence")
		const status = record[0]!
		if (status === "S" || status !== status.toUpperCase())
			throw new Error("Workspace changed-path evidence is suppressed by index flags")
	}
	const changed = new Set<string>()
	// Pin the pre-agent commit: a task may commit or stage changes and leave a clean worktree.
	// Disable rename detection so both deleted sources and added destinations remain policy inputs.
	const commands = [
		[
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--relative",
			baselineCommit,
			"--",
			".",
		],
		[
			"diff",
			"--cached",
			"--name-only",
			"-z",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			"--relative",
			baselineCommit,
			"--",
			".",
		],
		// Deliberately omit exclusion rules: agent-controlled .gitignore cannot narrow a grader's policy.
		["ls-files", "--others", "-z", "--", "."],
	]
	for (const args of commands) {
		const output = await readGitEvidence(workspaceRoot, runner, args)
		const records = output.split("\0")
		if (records.pop() !== "") throw new Error("Incomplete changed-path evidence")
		for (const record of records) {
			if (!record) throw new Error("Invalid changed-path evidence")
			changed.add(record)
		}
	}
	return [...changed].sort()
}

async function readGitEvidence(workspaceRoot: string, runner: HarnessProcessRunner, args: string[]): Promise<string> {
	const result = await runner.run({
		command: "git",
		args,
		cwd: workspaceRoot,
		timeoutMs: 30_000,
		maxOutputBytes: 10 * 1024 * 1024,
	})
	if (result.timedOut || result.exitCode !== 0 || result.outputTruncated) {
		throw new Error(`Unable to collect complete Git ${args[0]} evidence`)
	}
	return result.stdout
}
