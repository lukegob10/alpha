import {
	containsDangerousSubstitution,
	createSubagentCommandApprovalPolicy,
	getCommandDecision,
	getSubagentCommandDecision,
} from "../commands"

describe("containsDangerousSubstitution", () => {
	describe("zsh array assignments (should NOT be flagged)", () => {
		it("should return false for files=(a b c)", () => {
			expect(containsDangerousSubstitution("files=(a b c)")).toBe(false)
		})

		it("should return false for var=(item1 item2)", () => {
			expect(containsDangerousSubstitution("var=(item1 item2)")).toBe(false)
		})

		it("should return false for x=(hello)", () => {
			expect(containsDangerousSubstitution("x=(hello)")).toBe(false)
		})
	})

	describe("zsh process substitution (should be flagged)", () => {
		it("should return true for standalone =(whoami)", () => {
			expect(containsDangerousSubstitution("=(whoami)")).toBe(true)
		})

		it("should return true for =(ls) with leading space", () => {
			expect(containsDangerousSubstitution(" =(ls)")).toBe(true)
		})

		it("should return true for echo =(cat /etc/passwd)", () => {
			expect(containsDangerousSubstitution("echo =(cat /etc/passwd)")).toBe(true)
		})
	})
})

describe("getCommandDecision", () => {
	it("should auto_approve array assignment command with wildcard allowlist", () => {
		const command = 'files=(a.ts b.ts); for f in "${files[@]}"; do echo "$f"; done'
		const result = getCommandDecision(command, ["*"])
		expect(result).toBe("auto_approve")
	})
})

describe("plaintext-free inherited command approval", () => {
	it("preserves longest-prefix and chain decisions without persisting command text", () => {
		const allowed = ["git", "git push --dry-run", "mycli --token hunter2"]
		const denied = ["git push", "curl -u user:password"]
		const policy = createSubagentCommandApprovalPolicy(allowed, denied, "8".repeat(64))
		const serialized = JSON.stringify(policy)

		for (const command of [...allowed, ...denied]) expect(serialized).not.toContain(command)
		for (const command of [
			"git status",
			"git push origin main",
			"git push --dry-run origin main",
			"npm test",
			"git status && git push origin main",
		]) {
			expect(getSubagentCommandDecision(command, policy)).toBe(getCommandDecision(command, allowed, denied))
		}
	})

	it("preserves wildcard approval and denial precedence", () => {
		const policy = createSubagentCommandApprovalPolicy(["*"], ["git push"], "9".repeat(64))

		expect(getSubagentCommandDecision("pnpm test", policy)).toBe("auto_approve")
		expect(getSubagentCommandDecision("git push origin main", policy)).toBe("auto_deny")
		expect(getSubagentCommandDecision('echo "${var@P}"', policy)).toBe("ask_user")
	})

	it("preserves configured prefix whitespace semantics", () => {
		const allowed = [" git", " * "]
		const policy = createSubagentCommandApprovalPolicy(allowed, [], "a".repeat(64))

		expect(getSubagentCommandDecision("git status", policy)).toBe(getCommandDecision("git status", allowed, []))
		expect(getSubagentCommandDecision("git status", policy)).toBe("ask_user")
	})
})

describe("containsDangerousSubstitution — node -e one-liner false positive regression", () => {
	const nodeOneLiner = `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('prd.json','utf8'));const allowed=new Set(['pending','in-progress','complete','blocked']);const bad=(p.items||[]).filter(i=>!allowed.has(i.status));console.log('meta.status',p.meta?.status);console.log('workstreams', (p.workstreams||[]).length);console.log('items', (p.items||[]).length);console.log('statusCounts', (p.items||[]).reduce((a,i)=>(a[i.status]=(a[i.status]||0)+1,a),{}));console.log('invalidStatuses', bad.length);if(bad.length){console.log(bad.map(i=>i.id+':'+i.status).join('\\\\n'));process.exit(2);} "`

	it("should NOT flag the complex node -e one-liner as dangerous substitution", () => {
		expect(containsDangerousSubstitution(nodeOneLiner)).toBe(false)
	})
})

describe("containsDangerousSubstitution — arrow function patterns (should NOT be flagged)", () => {
	it("should return false for node -e with simple arrow function", () => {
		expect(containsDangerousSubstitution(`node -e "const a=(b)=>b"`)).toBe(false)
	})

	it("should return false for node -e with spaced arrow function", () => {
		expect(containsDangerousSubstitution(`node -e "const fn = (x) => x * 2"`)).toBe(false)
	})

	it("should return false for node -e with arrow function in method chain", () => {
		expect(containsDangerousSubstitution(`node -e "arr.filter(i=>!set.has(i))"`)).toBe(false)
	})
})

describe("containsDangerousSubstitution — true positives still caught", () => {
	it("should flag dangerous parameter expansion ${var@P}", () => {
		expect(containsDangerousSubstitution('echo "${var@P}"')).toBe(true)
	})

	it("should flag here-string with command substitution <<<$(…)", () => {
		expect(containsDangerousSubstitution("cat <<<$(whoami)")).toBe(true)
	})

	it("should flag indirect variable reference ${!var}", () => {
		expect(containsDangerousSubstitution("echo ${!prefix}")).toBe(true)
	})

	it("should flag zsh process substitution =(…) at start of token", () => {
		expect(containsDangerousSubstitution("echo =(cat /etc/passwd)")).toBe(true)
	})

	it("should flag zsh glob qualifier with code execution", () => {
		expect(containsDangerousSubstitution("ls *(e:whoami:)")).toBe(true)
	})
})

describe("getCommandDecision — integration with dangerous substitution checks", () => {
	const allowedCommands = ["node", "echo"]

	it("should auto-approve the complex node -e one-liner when node is allowed", () => {
		const nodeOneLiner = `node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('prd.json','utf8'));const allowed=new Set(['pending','in-progress','complete','blocked']);const bad=(p.items||[]).filter(i=>!allowed.has(i.status));console.log('meta.status',p.meta?.status);console.log('workstreams', (p.workstreams||[]).length);console.log('items', (p.items||[]).length);console.log('statusCounts', (p.items||[]).reduce((a,i)=>(a[i.status]=(a[i.status]||0)+1,a),{}));console.log('invalidStatuses', bad.length);if(bad.length){console.log(bad.map(i=>i.id+':'+i.status).join('\\\\n'));process.exit(2);} "`

		expect(getCommandDecision(nodeOneLiner, allowedCommands)).toBe("auto_approve")
	})

	it("should ask user for echo $(whoami) because subshell whoami is not in the allowlist", () => {
		expect(getCommandDecision("echo $(whoami)", allowedCommands)).toBe("ask_user")
	})

	it("should ask user for dangerous parameter expansion even when command is allowed", () => {
		expect(getCommandDecision('echo "${var@P}"', allowedCommands)).toBe("ask_user")
	})

	it.each(['echo "$(whoami)"', "echo ${value:-$(whoami)}", "echo $(( $(whoami) ))", 'echo "`whoami`"'])(
		"checks executable substitutions hidden from the outer command parser: %s",
		(command) => {
			expect(getCommandDecision(command, allowedCommands)).toBe("ask_user")
		},
	)

	it("preserves auto-approval when both the outer and substituted commands are allowed", () => {
		expect(getCommandDecision('echo "$(whoami)"', ["echo", "whoami"])).toBe("auto_approve")
		expect(getCommandDecision('echo "line`nbreak"', ["echo"])).toBe("auto_approve")
	})

	it("asks for malformed substitutions instead of inheriting approval from the outer command", () => {
		expect(getCommandDecision('echo "$(whoami"', allowedCommands)).toBe("ask_user")
	})

	it("does not inherit wildcard approval for an executable supplied by variable expansion", () => {
		expect(getCommandDecision("x=rm; $x victim", ["*"], ["rm"])).toBe("ask_user")
		expect(getCommandDecision("x=rm; ${x} victim", ["*"], ["rm"])).toBe("ask_user")
	})

	it("asks when command substitution supplies the executable name", () => {
		expect(getCommandDecision("$(echo rm) victim", ["echo"], ["rm"])).toBe("ask_user")
		expect(getCommandDecision("`echo rm` victim", ["echo"], ["rm"])).toBe("ask_user")
	})

	it("checks commands executed through process substitution", () => {
		expect(getCommandDecision("cat <(whoami)", ["cat"])).toBe("ask_user")
		expect(getCommandDecision("cat >(whoami)", ["cat"])).toBe("ask_user")
		expect(getCommandDecision('cat <(echo "$(whoami)")', ["cat", "echo"])).toBe("ask_user")
		expect(getCommandDecision('echo "$(cat <(whoami))"', ["echo", "cat"])).toBe("ask_user")
		expect(getCommandDecision("cat <(whoami", ["cat", "whoami"])).toBe("ask_user")
		expect(getCommandDecision("cat >(whoami", ["cat", "whoami"])).toBe("ask_user")
	})

	it("preserves quoted process-substitution literals and fully allowed process commands", () => {
		expect(getCommandDecision('cat "<(whoami)"', ["cat"])).toBe("auto_approve")
		expect(getCommandDecision("cat <(echo allowed)", ["cat", "echo"])).toBe("auto_approve")
	})

	it("preserves approval for literal dollar-prefixed executable names", () => {
		expect(getCommandDecision("'$cmd' victim", ["*"], ["rm"])).toBe("auto_approve")
		expect(getCommandDecision("\\$cmd victim", ["*"], ["rm"])).toBe("auto_approve")
	})

	it("applies substitution and executable-variable checks to hashed inherited policy", () => {
		const policy = createSubagentCommandApprovalPolicy(["*"], ["rm"], "b".repeat(64))

		expect(getSubagentCommandDecision('echo "$(rm victim)"', policy)).toBe("auto_deny")
		expect(getSubagentCommandDecision("x=rm; $x victim", policy)).toBe("ask_user")
	})
})
