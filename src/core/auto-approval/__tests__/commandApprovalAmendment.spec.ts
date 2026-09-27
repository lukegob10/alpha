import { describe, expect, it } from "vitest"

import { createPersistentCommandPrefixAmendment } from "../commandApprovalAmendment"

describe("persistent command approval amendments", () => {
	it("offers a static command as the prefix the user can approve", () => {
		expect(createPersistentCommandPrefixAmendment("git status --short")).toEqual({
			kind: "command_prefix",
			prefix: "git status --short",
		})
		expect(createPersistentCommandPrefixAmendment("node scripts/check.js")).toEqual({
			kind: "command_prefix",
			prefix: "node scripts/check.js",
		})
	})

	it.each([
		"git status && git push",
		"git status | cat",
		"echo $(whoami)",
		"$COMMAND --help",
		"git status > result.txt",
		" FOO=bar git status",
		"git status\nrm -rf .",
		"git 'status --short'",
	])("does not offer a persistent prefix for shell-dependent command %s", (command) => {
		expect(createPersistentCommandPrefixAmendment(command)).toBeUndefined()
	})

	it.each([
		"env",
		"command",
		"exec",
		"sudo",
		"npx echo",
		"npm exec echo",
		"pnpm exec echo",
		"uv run echo",
		"eval echo",
		"source script.sh",
		"bash -lc true",
		"dash -c true",
		"C:\\Windows\\System32\\cmd.exe /c dir",
		"powershell.exe -EncodedCommand AAAA",
		"pwsh -Command Get-Date",
		"node -e 1",
		"nodejs -e 1",
		"deno run",
		"python3.12 -c pass",
		"ruby -e 1",
		"php -r 1",
	])("does not save a launcher or inline evaluator as a future command prefix: %s", (command) => {
		expect(createPersistentCommandPrefixAmendment(command)).toBeUndefined()
	})
})
