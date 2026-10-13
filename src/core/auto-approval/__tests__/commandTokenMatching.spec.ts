import { createHash } from "crypto"
import { describe, expect, it } from "vitest"
import { subagentCommandApprovalPolicySchema, type SubagentCommandApprovalPolicy } from "@alpha-code/types"

import {
	createSubagentCommandApprovalPolicy,
	findLongestPrefixMatch,
	getCommandDecision,
	getSingleCommandDecision,
	getSubagentCommandDecision,
	isAutoApprovedSingleCommand,
	isAutoDeniedSingleCommand,
} from "../commands"

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform")
	if (!original) throw new Error("The test requires Node's platform descriptor")
	Object.defineProperty(process, "platform", { value: platform, configurable: true })
	try {
		run()
	} finally {
		Object.defineProperty(process, "platform", original)
	}
}

function legacyPolicy(allowed: string[], denied: string[] = []): SubagentCommandApprovalPolicy {
	const salt = "a".repeat(64)
	const rules = (commands: string[]) =>
		commands.map((command) => ({
			prefixLength: command.length,
			digest: createHash("sha256").update(salt).update("\0").update(command.toLowerCase()).digest("hex"),
		}))
	return subagentCommandApprovalPolicySchema.parse({
		algorithm: "sha256-salted-prefix-v1",
		salt,
		allowAll: false,
		denyAll: false,
		allowed: rules(allowed),
		denied: rules(denied),
	})
}

describe("command approval token boundaries", () => {
	it.each([
		["git-impostor status", "git"],
		["pnpmx test", "pnpm"],
		["pnpm test-extra", "pnpm test"],
		["git status-report", "git status"],
		["rm ./build-old", "rm ./build"],
		["node scripts/check.js.backup", "node scripts/check.js"],
		["curl --request POSTER https://example.test", "curl --request POST"],
		["'git status' --short", "git status"],
		["echo 'a b' c", "echo a 'b c'"],
	])("does not inherit approval across a token boundary: %s", (command, rule) => {
		expect(findLongestPrefixMatch(command, [rule])).toBeNull()
		expect(isAutoApprovedSingleCommand(command, [rule])).toBe(false)
		expect(isAutoApprovedSingleCommand(command, [rule], [])).toBe(false)
		expect(getSingleCommandDecision(command, [rule], [])).toBe("ask_user")
		expect(getCommandDecision(command, [rule], [])).toBe("ask_user")
		const policy = createSubagentCommandApprovalPolicy([rule], [], "1".repeat(64))
		expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
	})

	it.each([
		["git-impostor status", "git"],
		["pnpm test-extra", "pnpm test"],
		["rm ./build-old", "rm ./build"],
	])("does not apply a denial to a different complete token: %s", (command, rule) => {
		expect(isAutoDeniedSingleCommand(command, ["*"], [rule])).toBe(false)
		expect(getCommandDecision(command, ["*"], [rule])).toBe("auto_approve")
		const policy = createSubagentCommandApprovalPolicy(["*"], [rule], "2".repeat(64))
		expect(getSubagentCommandDecision(command, policy)).toBe("auto_approve")
	})

	it.each([
		["git status --short", "git status"],
		['"git" status --short', "git status"],
		["pnpm\t  test --run", "pnpm test"],
		["'pnpm' 'test' --run", "pnpm test"],
		['rm "./build output"', "rm './build output'"],
		['echo "a && b; c | d"', "echo 'a && b; c | d'"],
		['echo "" extra', "echo ''"],
		['echo "*"', "echo '*'"],
		['echo "[a-z]*"', "echo '[a-z]*'"],
	])("approves equivalent complete executable/argument tokens: %s", (command, rule) => {
		expect(isAutoApprovedSingleCommand(command, [rule], [])).toBe(true)
		expect(getSingleCommandDecision(command, [rule], [])).toBe("auto_approve")
		expect(getCommandDecision(command, [rule], [])).toBe("auto_approve")
		const policy = createSubagentCommandApprovalPolicy([rule], [], "3".repeat(64))
		expect(getSubagentCommandDecision(command, policy)).toBe("auto_approve")
	})

	it.each([
		["git STATUS", "git status"],
		["pnpm --filter Alpha test", "pnpm --filter alpha"],
		["curl --request post https://example.test", "curl --request POST"],
		['node "Scripts/check.js"', 'node "scripts/check.js"'],
	])("keeps argument matching case-sensitive: %s", (command, rule) => {
		expect(getCommandDecision(command, [rule], [])).toBe("ask_user")
		const policy = createSubagentCommandApprovalPolicy([rule], [], "4".repeat(64))
		expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
	})

	it.each(["git *", "git $ACTION", "git status && rm ./build", 'git "status'])(
		"asks when an unresolved configured denial cannot safely be excluded: %s",
		(denied) => {
			expect(getCommandDecision("pnpm test", ["*"], [denied])).toBe("ask_user")
			const policy = createSubagentCommandApprovalPolicy(["*"], [denied], "f".repeat(64))
			expect(getSubagentCommandDecision("pnpm test", policy)).toBe("ask_user")
		},
	)

	it.each([
		["git push${SUFFIX} origin main", "git", "git push"],
		['git "$ACTION" origin main', "git", "git push"],
		['rm "./build$SUFFIX"', "rm", "rm ./build"],
		["pnpm test$SUFFIX", "pnpm", "pnpm test"],
		["git pu* origin main", "git", "git push"],
		["rm ./build*", "rm", "rm ./build"],
	])("asks when argument expansion could select a denied token: %s", (command, executable, denied) => {
		for (const allowed of [[executable], ["*"]]) {
			expect(getCommandDecision(command, allowed, [denied])).toBe("ask_user")
			const policy = createSubagentCommandApprovalPolicy(allowed, [denied], "2".repeat(64))
			expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
		}
	})

	it("preserves broad executable grants for computed arguments when no denial is configured", () => {
		const policy = createSubagentCommandApprovalPolicy(["git"], [], "3".repeat(64))
		expect(getCommandDecision("git push${SUFFIX} origin main", ["git"], [])).toBe("auto_approve")
		expect(getSubagentCommandDecision("git push${SUFFIX} origin main", policy)).toBe("auto_approve")
	})

	it.each([8, 9, 16])("retains denial protection at the bounded launcher depth %d", (depth) => {
		const command = `${"env ".repeat(depth)}rm ./build`
		const policy = createSubagentCommandApprovalPolicy(["env"], ["rm"], "6".repeat(64))
		for (const decision of [
			getCommandDecision(command, ["env"], ["rm"]),
			getSubagentCommandDecision(command, policy),
		]) {
			expect(decision).not.toBe("auto_approve")
			if (depth === 8) expect(decision).toBe("auto_deny")
		}
	})

	it.each([
		"if true; then rm ./build; fi",
		"for f in files; do rm ./build; done",
		"! rm ./build",
		"time rm ./build",
		'bash -c "for f in files; do rm ./build; done"',
		'bash -c "if true; then rm ./build; fi"',
	])("requires safe denial resolution for shell control syntax: %s", (command) => {
		withPlatform("linux", () => {
			const policy = createSubagentCommandApprovalPolicy(["*"], ["rm"], "7".repeat(64))
			expect(getCommandDecision(command, ["*"], ["rm"])).not.toBe("auto_approve")
			expect(getSubagentCommandDecision(command, policy)).not.toBe("auto_approve")
		})
	})

	it.each(['bash -c "env rm ./build"', "bash -c \"sh -c 'env rm ./build'\"", 'eval "env rm ./build"'])(
		"applies a denial through nested shell and launcher operands: %s",
		(command) => {
			const allowed = ["bash", "eval"]
			const policy = createSubagentCommandApprovalPolicy(allowed, ["rm"], "8".repeat(64))
			expect(getCommandDecision(command, allowed, ["rm"])).toBe("auto_deny")
			expect(getSubagentCommandDecision(command, policy)).toBe("auto_deny")
		},
	)

	it.each(["bash -c 'git pu*'", "bash -c 'env git pu*'", "eval 'git pu*'"])(
		"retains dynamic argument evidence inside nested shell source: %s",
		(command) => {
			withPlatform("linux", () => {
				for (const allowed of [["bash", "eval"], ["*"]]) {
					const policy = createSubagentCommandApprovalPolicy(allowed, ["git push"], "a".repeat(64))
					expect(getCommandDecision(command, allowed, ["git push"])).toBe("ask_user")
					expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
				}
			})
		},
	)

	it.each([
		'env -S "rm ./victim"',
		'env --split-string "rm ./victim"',
		'env "--split-string=rm ./victim"',
		'env --split-str "rm ./victim"',
		'env "--split-str=rm ./victim"',
		'env -S"rm ./victim"',
		'env "-Srm ./victim"',
		'env -vS "rm ./victim"',
		"env -S 'rm\\_./victim'",
		"env -S '${COMMAND} ./victim'",
	])("does not widen finite denial authority through env string splitting: %s", (command) => {
		for (const platform of ["linux", "win32"] as const) {
			withPlatform(platform, () => {
				for (const allowed of [["env"], ["*"]]) {
					const policy = createSubagentCommandApprovalPolicy(allowed, ["rm"], "b".repeat(64))
					expect(getCommandDecision(command, allowed, ["rm"])).not.toBe("auto_approve")
					expect(getSubagentCommandDecision(command, policy)).not.toBe("auto_approve")
				}
			})
		}
	})

	it("preserves literal argument boundaries through a transparent launcher", () => {
		const command = 'env echo "ready; rm ./victim"'
		const policy = createSubagentCommandApprovalPolicy(["env"], ["rm"], "c".repeat(64))
		expect(getCommandDecision(command, ["env"], ["rm"])).toBe("auto_approve")
		expect(getSubagentCommandDecision(command, policy)).toBe("auto_approve")
	})

	it.each(['node -e "console.log(1)"', 'python -c "pass"'])(
		"requires review when an interpreter operand cannot prove a finite denial is excluded: %s",
		(command) => {
			const allowed = ["node", "python"]
			const policy = createSubagentCommandApprovalPolicy(allowed, ["rm"], "9".repeat(64))
			expect(getCommandDecision(command, allowed, ["rm"])).toBe("ask_user")
			expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
			expect(getCommandDecision(command, allowed, [])).toBe("auto_approve")
		},
	)

	it.each([
		["git push --dry-run origin main", ["git push --dry-run"], ["git push"]],
		["rm ./build", ["rm ./build"], ["rm"]],
		["pnpm test --run", ["pnpm test --run"], ["pnpm test"]],
		["git status", ["git status"], ["*"]],
	])("keeps matching denials authoritative over more specific allows: %s", (command, allowed, denied) => {
		expect(isAutoApprovedSingleCommand(command, allowed, denied)).toBe(false)
		expect(isAutoDeniedSingleCommand(command, allowed, denied)).toBe(true)
		expect(getSingleCommandDecision(command, allowed, denied)).toBe("auto_deny")
		expect(getCommandDecision(command, allowed, denied)).toBe("auto_deny")
		const policy = createSubagentCommandApprovalPolicy(allowed, denied, "5".repeat(64))
		expect(getSubagentCommandDecision(command, policy)).toBe("auto_deny")
	})

	it.each(["&&", "||", ";", "|", "&", "\n"])("checks each command in a chain separated by %j", (separator) => {
		const allowed = ["git status", "pnpm test"]
		const denied = ["rm"]
		const policy = createSubagentCommandApprovalPolicy(allowed, denied, "6".repeat(64))
		for (const [tail, decision] of [
			["pnpm test --run", "auto_approve"],
			["pnpm test-extra", "ask_user"],
			["git-impostor status", "ask_user"],
			["rm ./build", "auto_deny"],
		] as const) {
			const command = `git status ${separator} ${tail}`
			expect(getCommandDecision(command, allowed, denied)).toBe(decision)
			expect(getSubagentCommandDecision(command, policy)).toBe(decision)
		}
	})

	it.each(["git status && rm ./build", "git status | git-impostor status", "git status\npnpm test"])(
		"does not let a single-command helper approve a compound command: %s",
		(command) => {
			expect(findLongestPrefixMatch(command, ["git"])).toBeNull()
			expect(isAutoApprovedSingleCommand(command, ["git"], [])).toBe(false)
			expect(getSingleCommandDecision(command, ["git"], [])).toBe("ask_user")
		},
	)

	it.each(['git "status', "git status &&", "git status |", "&& git status", "git status && || pnpm test", ";"])(
		"asks for malformed or empty parsed commands: %s",
		(command) => {
			const allowed = ["git", "pnpm"]
			expect(getCommandDecision(command, allowed, [])).toBe("ask_user")
			const policy = createSubagentCommandApprovalPolicy(allowed, [], "7".repeat(64))
			expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
		},
	)

	it("captures rule arrays independently of later parent settings edits and JSON reload", () => {
		const allowed = ["git status", "pnpm test"]
		const denied = ["git push"]
		const captured = createSubagentCommandApprovalPolicy(allowed, denied, "8".repeat(64))
		const serialized = JSON.stringify(captured)
		allowed.push("rm")
		denied.splice(0)
		const reloaded = subagentCommandApprovalPolicySchema.parse(JSON.parse(serialized))

		for (const policy of [captured, reloaded]) {
			expect(getSubagentCommandDecision("git status --short", policy)).toBe("auto_approve")
			expect(getSubagentCommandDecision("pnpm test-extra", policy)).toBe("ask_user")
			expect(getSubagentCommandDecision("rm ./build", policy)).toBe("ask_user")
			expect(getSubagentCommandDecision("git push origin main", policy)).toBe("auto_deny")
		}
	})

	it.each([
		["git status", ["git status && rm ./build"]],
		["git status", ["git *"]],
		["git status", ["git $ACTION"]],
		["git status", ['git "status']],
		["git status", [""]],
		["git status", [" * "]],
	])("does not derive approval from unsupported configured rules: %s %j", (command, allowed) => {
		expect(getCommandDecision(command, allowed, [])).toBe("ask_user")
		const policy = createSubagentCommandApprovalPolicy(allowed, [], "9".repeat(64))
		expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
	})

	it("uses token count to select the most specific match while preserving the configured spelling", () => {
		expect(findLongestPrefixMatch('"git" status --short', ["*", '"git"', "git status"])).toBe("git status")
		expect(findLongestPrefixMatch("git status", ["  git       ", "git status"])).toBe("git status")
		expect(findLongestPrefixMatch("git status", ["*", "  git  "])).toBe("  git  ")
	})

	it.each(["linux", "win32"] as const)("applies executable normalization at the %s host boundary", (platform) => {
		withPlatform(platform, () => {
			const rule = '"C:\\Program Files\\Git\\git.exe" status'
			const command = '"c:/PROGRAM FILES/Git/GIT.EXE" status --short'
			const expected = platform === "win32" ? "auto_approve" : "ask_user"
			expect(getCommandDecision(command, [rule], [])).toBe(expected)
			const policy = createSubagentCommandApprovalPolicy([rule], [], "b".repeat(64))
			expect(getSubagentCommandDecision(command, policy)).toBe(expected)
			expect(getCommandDecision("GIT status", ["git"], [])).toBe(expected)
			expect(getCommandDecision("git.exe status", ["git"], [])).toBe("ask_user")
			expect(getCommandDecision('"C:/Tools/git.exe" status', ["git.exe"], [])).toBe("ask_user")
			expect(getCommandDecision('"C:/Tools/git.exe-extra" status', ['"C:/Tools/git.exe"'], [])).toBe("ask_user")
		})
	})

	it.each(["g\\it status", "git st\\atus", "g'i't st'a'tus"])(
		"matches literal POSIX shell escaping and adjacent quote fragments: %s",
		(command) => {
			withPlatform("linux", () => {
				expect(getCommandDecision(command, ["git status"], [])).toBe("auto_approve")
				expect(getCommandDecision(command, ["*"], ["git status"])).toBe("auto_deny")
				const policy = createSubagentCommandApprovalPolicy(["git status"], [], "0".repeat(64))
				expect(getSubagentCommandDecision(command, policy)).toBe("auto_approve")
			})
		},
	)

	it.each([
		["git sta\\\ntus", "git status"],
		['git "sta\\\ntus"', "git status"],
		["r\\\nm ./build", "rm"],
	])("applies denied argv tokens across POSIX line continuation: %s", (command, denied) => {
		withPlatform("linux", () => {
			expect(getCommandDecision(command, ["*"], [denied])).not.toBe("auto_approve")
			const policy = createSubagentCommandApprovalPolicy(["*"], [denied], "4".repeat(64))
			expect(getSubagentCommandDecision(command, policy)).not.toBe("auto_approve")
		})
	})

	it("keeps Windows path arguments exact even when executable spelling is normalized", () => {
		withPlatform("win32", () => {
			const allowed = ['git -C "C:\\Work\\Repo"']
			const policy = createSubagentCommandApprovalPolicy(allowed, [], "c".repeat(64))
			for (const command of ['GIT -C "c:/work/repo" status', 'git -C "C:/Work/Repo" status']) {
				expect(getCommandDecision(command, allowed, [])).toBe("ask_user")
				expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
			}
		})
	})

	it.each(["r^m ./build", "r`m ./build", "%COMMAND% ./build", "!COMMAND! ./build"])(
		"does not widen a finite Windows deny policy through a shell-dependent executable: %s",
		(command) => {
			withPlatform("win32", () => {
				expect(getCommandDecision(command, ["*"], ["rm"])).toBe("ask_user")
				const policy = createSubagentCommandApprovalPolicy(["*"], ["rm"], "1".repeat(64))
				expect(getSubagentCommandDecision(command, policy)).toBe("ask_user")
			})
		},
	)

	it.each([
		["%ARG%", "ask_user"],
		["%ARG:~0,6%", "ask_user"],
		["%ARG:x=y%", "ask_user"],
		["%1", "ask_user"],
		["%*", "ask_user"],
		["%~dp0", "ask_user"],
		["%ProgramFiles(x86)%", "ask_user"],
		["!ARG:~0,6!", "ask_user"],
		["%", "auto_approve"],
		["!", "auto_approve"],
	])("preserves host-specific expansion evidence inside single quotes: %s", (argument, windowsDecision) => {
		for (const platform of ["linux", "win32"] as const) {
			withPlatform(platform, () => {
				const command = `echo '${argument}'`
				const policy = createSubagentCommandApprovalPolicy(["*"], ["echo secret"], "6".repeat(64))
				const expected = platform === "win32" ? windowsDecision : "auto_approve"
				expect(getCommandDecision(command, ["*"], ["echo secret"])).toBe(expected)
				expect(getSubagentCommandDecision(command, policy)).toBe(expected)
			})
		}
	})

	it("does not hide a Windows command behind shell-dependent comment syntax", () => {
		withPlatform("win32", () => {
			const command = "git status # comment & rm ./build"
			for (const allowed of [["git"], ["*"]]) {
				expect(getCommandDecision(command, allowed, ["rm"])).not.toBe("auto_approve")
				const policy = createSubagentCommandApprovalPolicy(allowed, ["rm"], "5".repeat(64))
				expect(getSubagentCommandDecision(command, policy)).not.toBe("auto_approve")
			}
		})
	})

	it.each(["linux", "win32"] as const)("freezes %s executable matching across a later host change", (platform) => {
		let captured: SubagentCommandApprovalPolicy | undefined
		withPlatform(platform, () => {
			captured = createSubagentCommandApprovalPolicy(["git status"], [], "d".repeat(64))
			expect(captured.algorithm).toBe("sha256-salted-argv-v2")
		})
		if (!captured) throw new Error("The capture fixture did not create a policy")
		const reloaded = subagentCommandApprovalPolicySchema.parse(JSON.parse(JSON.stringify(captured)))
		withPlatform(platform === "win32" ? "linux" : "win32", () => {
			expect(getSubagentCommandDecision("GIT status", reloaded)).toBe(
				platform === "win32" ? "auto_approve" : "ask_user",
			)
			expect(getSubagentCommandDecision("git STATUS", reloaded)).toBe("ask_user")
			expect(getSubagentCommandDecision("git status-extra", reloaded)).toBe("ask_user")
		})
	})

	it("loads v1 policy records without rewriting their serialized identity", () => {
		const policy = legacyPolicy(["git", "pnpm test"], ["git push"])
		const serialized = JSON.stringify(policy)
		const reloaded = subagentCommandApprovalPolicySchema.parse(JSON.parse(serialized))
		expect(JSON.stringify(reloaded)).toBe(serialized)
		expect(getSubagentCommandDecision("git status", reloaded)).toBe("ask_user")
		expect(getSubagentCommandDecision("pnpm test --run", reloaded)).toBe("ask_user")
		expect(getSubagentCommandDecision("git push origin main", reloaded)).toBe("auto_deny")
	})

	it("retains provable complete lowercase v1 grants when no opaque denial is present", () => {
		const policy = legacyPolicy(["git", "pnpm test"])
		expect(getSubagentCommandDecision("git status", policy)).toBe("auto_approve")
		expect(getSubagentCommandDecision("pnpm test --run", policy)).toBe("auto_approve")
	})

	it.each([
		["git-impostor status", "git"],
		["pnpm test-extra", "pnpm test"],
		["rm ./build-old", "rm ./build"],
		["node scripts/check.js.backup", "node scripts/check.js"],
		["git STATUS", "git status"],
	])("requires a complete safe token boundary for legacy v1 approval: %s", (command, rule) => {
		expect(getSubagentCommandDecision(command, legacyPolicy([rule]))).toBe("ask_user")
	})

	it("retains legacy v1 denials conservatively when the original rule cannot be recovered", () => {
		const policy = legacyPolicy(["git", "git push --dry-run"], ["git push"])
		expect(getSubagentCommandDecision("git push --dry-run origin main", policy)).toBe("auto_deny")
		expect(getSubagentCommandDecision("git push-more origin main", policy)).toBe("auto_deny")
	})

	it.each([
		['"git" push origin main', "git push"],
		["'git' push origin main", "git push"],
		["git push origin main", '"git" push'],
		["'git' push origin main", '"git" push'],
		['rm "./build output"', "rm './build output'"],
		["rm './build output'", 'rm "./build output"'],
	])("does not lose a legacy denial under equivalent quoting: %s", (command, denied) => {
		const policy = { ...legacyPolicy([], [denied]), allowAll: true }
		expect(getSubagentCommandDecision(command, policy)).not.toBe("auto_approve")
	})
})
