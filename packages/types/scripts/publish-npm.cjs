/* eslint-env node */

const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")
const readline = require("readline")
const { pnpmInvocation } = require("../../../scripts/harness/pnpm.mjs")

const PACKAGE_NAME = "@alpha-code/types"
const BRANCH_NAME = "alpha-code-types-v"

const rootDir = path.join(__dirname, "..")
const npmDir = path.join(rootDir, "npm")
const monorepoPackagePath = path.join(rootDir, "package.json")
const npmMetadataPath = path.join(npmDir, "package.metadata.json")
const npmPackagePath = path.join(npmDir, "package.json")

const args = process.argv.slice(2)
const publishOnly = args.includes("--publish-only")

function git(args, options = {}) {
	return execFileSync("git", args, { cwd: rootDir, stdio: "pipe", ...options })
}

function runPnpm(args, options = {}) {
	const invocation = pnpmInvocation(process.env.npm_execpath, args)
	return execFileSync(invocation.executable, invocation.args, { cwd: rootDir, ...options })
}

function assertCleanWorkingTree() {
	const status = git(["status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" })
	if (status.trim()) {
		throw new Error("Publishing requires a clean Git working tree, including staged and untracked files.")
	}
}

async function confirmPublish() {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})

	return new Promise((resolve) => {
		rl.question("\n⚠️  Are you sure you want to publish to npm? (y/n): ", (answer) => {
			rl.close()
			resolve(answer.toLowerCase() === "y")
		})
	})
}

function updatePackageVersion(filePath, version) {
	try {
		const packageContent = JSON.parse(fs.readFileSync(filePath, "utf8"))
		const oldVersion = packageContent.version
		packageContent.version = version
		fs.writeFileSync(filePath, JSON.stringify(packageContent, null, 2) + "\n")

		try {
			runPnpm(["exec", "prettier", "--write", filePath], { stdio: "pipe" })
			console.log(`✨ Formatted ${path.basename(filePath)} with prettier`)
		} catch (prettierError) {
			console.warn(`⚠️  Could not format with prettier:`, prettierError.message)
		}

		const fileName = path.basename(filePath)
		console.log(`✅ Updated ${fileName} version: ${oldVersion} → ${version}`)
		return oldVersion
	} catch (error) {
		throw new Error(`Failed to update version in ${path.basename(filePath)}: ${error.message}`)
	}
}

function syncVersionToMetadata(version) {
	console.log("  📝 Syncing version to package.metadata.json...")
	updatePackageVersion(npmMetadataPath, version)
}

function commitVersionChanges(version) {
	console.log("  📝 Committing version changes to git...")
	const metadata = "npm/package.metadata.json"
	const status = git(["status", "--porcelain=v1", "--", metadata], { encoding: "utf8" })
	if (!status.trim()) {
		console.log("  ⚠️  No version changes to commit")
		return
	}
	git(["add", "--", metadata])
	const commitMessage = `chore: bump version to v${version}`
	// An explicit path also excludes unrelated files staged during the build.
	git(["commit", "--only", "-m", commitMessage, "--", metadata])
	console.log(`  ✅ Committed: ${commitMessage}`)
}

function checkGitHubCLI() {
	try {
		execFileSync("gh", ["--version"], { cwd: rootDir, stdio: "pipe" })
		execFileSync("gh", ["auth", "status"], { cwd: rootDir, stdio: "pipe" })
		return true
	} catch (_error) {
		return false
	}
}

function createPullRequest(branchName, baseBranch, version) {
	try {
		console.log(`  🔄 Creating pull request...`)

		if (!checkGitHubCLI()) {
			console.warn("  ⚠️  GitHub CLI not found or not authenticated")
			console.log("     Install gh CLI and run: gh auth login")
			console.log("     Then manually create PR with: gh pr create")
			return
		}

		const title = `Release: v${version}`
		const body = `## 🚀 Release v${version}

This PR contains the version bump for the SDK release v${version}.

### Changes
- Bumped version from previous to v${version}
- Published to npm as ${PACKAGE_NAME}@${version}

### Checklist
- [x] Version bumped
- [x] Package published to npm
- [ ] Changelog updated (if applicable)
- [ ] Documentation updated (if applicable)

---
*This PR was automatically created by the npm publish script.*`

		try {
			// Create the pull request
			const prUrl = execFileSync(
				"gh",
				["pr", "create", "--base", baseBranch, "--head", branchName, "--title", title, "--body-file", "-"],
				{ cwd: rootDir, encoding: "utf8", stdio: "pipe", input: body },
			).trim()

			console.log(`  ✅ Pull request created: ${prUrl}`)
		} catch (error) {
			if (error.message.includes("already exists")) {
				console.log("  ℹ️  Pull request already exists for this branch")
			} else {
				throw error
			}
		}
	} catch (error) {
		console.error("  ❌ Failed to create pull request:", error.message)
		console.log("     You can manually create a PR with:")
		console.log(`     gh pr create --base "${baseBranch}" --head "${branchName}"`)
	}
}

function createVersionBranchAndCommit(version) {
	try {
		const branchName = `${BRANCH_NAME}${version}`
		console.log(`  🌿 Creating version branch: ${branchName}...`)

		const currentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()

		git(["checkout", "-b", branchName])
		console.log(`  ✅ Created branch: ${branchName}`)
		commitVersionChanges(version)
		git(["push", "--set-upstream", "origin", branchName])
		console.log(`  ✅ Pushed branch to origin with upstream tracking`)
		createPullRequest(branchName, currentBranch, version)

		if (currentBranch) {
			git(["checkout", currentBranch])
			console.log(`  ✅ Returned to branch: ${currentBranch}`)
		}

		console.log(`  🎯 Version branch created with commits: ${branchName}`)
	} catch (error) {
		throw new Error(`Package published, but its version branch could not be recorded: ${error.message}`, {
			cause: error,
		})
	}
}

function generateNpmPackage() {
	try {
		console.log("  📖 Reading monorepo package.json...")

		const monorepoPackageContent = fs.readFileSync(monorepoPackagePath, "utf8")
		const monorepoPackage = JSON.parse(monorepoPackageContent)

		console.log("  📖 Reading npm package metadata...")

		const npmMetadataContent = fs.readFileSync(npmMetadataPath, "utf8")
		const npmMetadata = JSON.parse(npmMetadataContent)

		console.log("  🔨 Generating npm package.json...")

		const npmPackage = {
			...npmMetadata,
			dependencies: monorepoPackage.dependencies || {},
			main: "./dist/index.cjs",
			module: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": {
					types: "./dist/index.d.ts",
					import: "./dist/index.js",
					require: {
						types: "./dist/index.d.cts",
						default: "./dist/index.cjs",
					},
				},
			},
			files: ["dist"],
		}

		const outputContent = JSON.stringify(npmPackage, null, 2) + "\n"
		fs.writeFileSync(npmPackagePath, outputContent)

		console.log("  ✅ npm/package.json generated successfully")
		console.log(`  📦 Package name: ${npmPackage.name}`)
		console.log(`  📌 Version: ${npmPackage.version}`)
		console.log(`  📚 Dependencies: ${Object.keys(npmPackage.dependencies).length}`)
	} catch (error) {
		throw new Error(`Failed to generate npm package.json: ${error.message}`)
	}
}

async function publish() {
	try {
		console.log("\n🚀 NPM PUBLISH WORKFLOW")
		if (publishOnly) {
			console.log("📌 Mode: Publish only (no git writes)")
		}
		console.log("=".repeat(60))
		assertCleanWorkingTree()
		pnpmInvocation(process.env.npm_execpath, [])

		console.log("\n📦 Step 1: Generating npm package.json...")
		generateNpmPackage()

		const npmPackage = JSON.parse(fs.readFileSync(npmPackagePath, "utf8"))
		const originalVersion = npmPackage.version // Save original version
		console.log(`\n📌 Current version: ${npmPackage.version}`)
		console.log(`📦 Package name: ${npmPackage.name}`)

		console.log("\n📈 Step 2: Bumping version (minor)...")

		try {
			runPnpm(["version", "minor", "--no-git-tag-version"], {
				cwd: npmDir,
				stdio: "inherit",
			})
		} catch (error) {
			console.error("❌ Failed to bump version:", error.message)
			throw error
		}

		const updatedPackage = JSON.parse(fs.readFileSync(npmPackagePath, "utf8"))
		console.log(`✅ New version: ${updatedPackage.version}`)

		console.log("\n🔨 Step 3: Building production bundle...")
		console.log("  This may take a moment...")

		try {
			runPnpm(["exec", "tsup", "--outDir", "npm/dist"], {
				cwd: rootDir,
				stdio: "inherit",
				env: { ...process.env, NODE_ENV: "production" },
			})

			console.log("✅ Production build complete")
		} catch (error) {
			console.error("❌ Build failed:", error.message)
			throw error
		}

		console.log("\n" + "=".repeat(60))
		console.log("📋 PUBLISH SUMMARY:")
		console.log(`   Package: ${updatedPackage.name}`)
		console.log(`   Version: ${updatedPackage.version}`)
		console.log(`   Registry: ${updatedPackage.publishConfig?.registry || "https://registry.npmjs.org/"}`)
		console.log(`   Access: ${updatedPackage.publishConfig?.access || "public"}`)
		console.log("=".repeat(60))

		const confirmed = await confirmPublish()

		if (!confirmed) {
			console.log("\n❌ Publishing cancelled by user")
			console.log("🔙 Reverting version change...")

			try {
				updatePackageVersion(npmPackagePath, originalVersion)
			} catch (revertError) {
				console.error("⚠️  Could not revert version:", revertError.message)
				console.log(`   You may need to manually change version back to ${originalVersion}`)
			}

			process.exit(0)
		}

		console.log("\n💾 Step 4: Syncing version to metadata...")
		syncVersionToMetadata(updatedPackage.version)

		console.log("\n🚀 Step 5: Publishing to npm...")

		try {
			runPnpm(["publish", "--no-git-checks"], {
				cwd: npmDir,
				stdio: "inherit",
			})
		} catch (error) {
			console.error("❌ Publish failed:", error.message)
			console.error("💡 The package was built but not published.")
			console.error("   You can try publishing manually from the npm directory.")

			throw error
		}

		if (!publishOnly) {
			console.log("\n🌿 Step 6: Creating version branch, committing, and opening PR...")
			createVersionBranchAndCommit(updatedPackage.version)
		} else {
			console.log("\n📝 Step 6: Skipping version branch creation (--publish-only mode)")
		}

		console.log("\n" + "=".repeat(60))
		console.log("✅ Successfully published to npm!")
		console.log(`🎉 ${updatedPackage.name}@${updatedPackage.version} is now live`)
		console.log(`📦 View at: https://www.npmjs.com/package/${updatedPackage.name}`)

		if (!publishOnly) {
			console.log(`🌿 Version branch: ${BRANCH_NAME}${updatedPackage.version}`)
		}

		console.log("=".repeat(60) + "\n")
	} catch (error) {
		console.error("\n❌ Error during publish process:", error.message)
		console.error("\n💡 Troubleshooting tips:")
		console.error("   1. Ensure you are logged in to npm: npm whoami")
		console.error("   2. Check your npm permissions for this package")
		console.error("   3. Verify the package name is not already taken")
		console.error("   4. Make sure all dependencies are installed: pnpm install")
		process.exit(1)
	}
}

async function main() {
	await publish()
}

module.exports = { commitVersionChanges, createVersionBranchAndCommit, publish }

if (require.main === module) {
	main().catch((error) => {
		console.error("Unexpected error:", error)
		process.exit(1)
	})
}
