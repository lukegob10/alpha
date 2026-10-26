import { afterEach, describe, expect, it, vi } from "vitest"

import { canonicalJson, sha256 } from "../../evidence/canonical"
import { sealCampaignExport, type CampaignExport } from "../../experiments/campaign"
import { immutableIdentity } from "../../experiments/identity"
import {
	createHostCampaignConfirmationRunner,
	evaluateConfirmation,
	parseConfirmationPlan,
	parseConfirmationReceipt,
	runFreshConfirmation,
	sealConfirmationPlan,
	type ConfirmationPlan,
	type ConfirmationReceipt,
	type ConfirmationRunRequest,
} from "../confirmation"
import { sealHarnessContext, sealReviewedHandoffRepair } from "../handoff"
import { CONFIRMATION_TIME, createConfirmationFixture } from "./confirmationFixtures"

afterEach(() => vi.useRealTimers())

function resealPlan(value: ConfirmationPlan): ConfirmationPlan {
	const { digest: _digest, ...body } = value
	return sealConfirmationPlan(body)
}

function alterCampaign(value: CampaignExport, edit: (body: Omit<CampaignExport, "digest">) => void): CampaignExport {
	const { digest: _digest, ...body } = structuredClone(value)
	edit(body)
	return sealCampaignExport(body)
}

function legacyConservativeReceipt(value: ConfirmationReceipt): ConfirmationReceipt {
	const { digest: _digest, ...body } = structuredClone(value)
	Reflect.deleteProperty(body, "decisionPolicy")
	body.status = "inconclusive"
	body.reasons = ["Infrastructure, cancelled or otherwise unscoreable attempts remain in the denominator"]
	return { ...body, digest: sha256(canonicalJson(body)) }
}

describe("fresh source repair confirmation", () => {
	it("keeps imported successes descriptive and retains null cost and missing phase metrics", async () => {
		const fixture = await createConfirmationFixture()
		const receipt = evaluateConfirmation(fixture.plan, fixture.sources, fixture.campaigns())
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.origin).toBe("imported")
		expect(receipt.decisionPolicy).toBe("scoreable-status-v1")
		expect(receipt.execution).toEqual([])
		expect(receipt.liveQualityImprovement).toBe(false)
		expect(receipt.campaigns.candidate?.accounting?.totalCost).toBeNull()
		expect(receipt.campaigns.candidate?.observations[0]?.performance?.providerMs).toBeUndefined()
		expect(receipt.pairedReport?.candidate.overall.coverage?.knownCost).toBe(0)
		expect(parseConfirmationReceipt(receipt, fixture.sources)).toEqual(receipt)
	})

	it("confirms a fresh scripted target and neighbors without claiming live quality or promotion", async () => {
		const fixture = await createConfirmationFixture()
		const runCampaign = vi.fn(fixture.ports.runCampaign)
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, { ...fixture.ports, runCampaign })
		expect(runCampaign.mock.calls.map(([request]) => request.arm)).toEqual(["control", "candidate"])
		expect(receipt.status).toBe("keep")
		expect(receipt.decisionPolicy).toBe("scoreable-status-v1")
		expect(receipt.evidenceKind).toBe("scripted-host-regression-validation")
		expect(receipt.liveQualityImprovement).toBe(false)
		expect(receipt.pairedReport?.decisionEvidence.status).toBe("inconclusive")
		expect(receipt.promotion?.allowed).toBe(false)
		expect(receipt.promotion?.reasons).toContain("golden certification is not current")
		expect(Object.isFrozen(receipt.campaigns.candidate?.observations)).toBe(true)
		expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt)
		expect(parseConfirmationReceipt(JSON.parse(JSON.stringify(receipt)), fixture.sources)).toEqual(receipt)
	})

	it("rejects missing evidence bytes before any runner dispatch", async () => {
		const fixture = await createConfirmationFixture()
		fixture.retained.clear()
		const runCampaign = vi.fn(fixture.ports.runCampaign)
		await expect(
			runFreshConfirmation(fixture.plan, fixture.sources, { ...fixture.ports, runCampaign }),
		).rejects.toThrow(/integrity/i)
		expect(runCampaign).not.toHaveBeenCalled()
	})

	it("rejects an expired predeclared execution block before launching a runner", async () => {
		const fixture = await createConfirmationFixture()
		const runCampaign = vi.fn(fixture.ports.runCampaign)
		await expect(
			runFreshConfirmation(fixture.plan, fixture.sources, {
				...fixture.ports,
				runCampaign,
				now: () => "2026-10-23T16:00:00.000Z",
			}),
		).rejects.toThrow(/outside.*block/i)
		expect(runCampaign).not.toHaveBeenCalled()
	})

	it("rejects stale source bytes and mismatched reviewed patch replacements before dispatch", async () => {
		const fixture = await createConfirmationFixture()
		const runCampaign = vi.fn(fixture.ports.runCampaign)
		await expect(
			runFreshConfirmation(fixture.plan, fixture.sources, {
				...fixture.ports,
				runCampaign,
				readSource: async () => Buffer.from("unreviewed source"),
			}),
		).rejects.toThrow(/source.*stale|stale.*source/i)
		const { digest: _digest, ...body } = fixture.sources.reviewedRepair
		const changed = sealReviewedHandoffRepair({
			...body,
			patch: {
				...body.patch,
				edits: body.patch.edits.map((edit) => ({ ...edit, replacement: "unreviewed replacement" })),
			},
		})
		const plan = structuredClone(fixture.plan)
		plan.sources.reviewedRepairDigest = changed.digest
		await expect(
			runFreshConfirmation(
				resealPlan(plan),
				{ ...fixture.sources, reviewedRepair: changed },
				{ ...fixture.ports, runCampaign },
			),
		).rejects.toThrow(/reviewed patch/i)
		expect(runCampaign).not.toHaveBeenCalled()
	})

	it("aborts a noncooperative preflight source reader before runner dispatch", async () => {
		const fixture = await createConfirmationFixture()
		const abort = new AbortController()
		let reading!: () => void
		const ready = new Promise<void>((resolve) => {
			reading = resolve
		})
		const runCampaign = vi.fn(fixture.ports.runCampaign)
		const pending = runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			signal: abort.signal,
			runCampaign,
			readSource: async () => {
				reading()
				return new Promise<Uint8Array>(() => {})
			},
		})
		await ready
		abort.abort()
		await expect(pending).rejects.toThrow(/abort|interrupted|cancelled/i)
		expect(runCampaign).not.toHaveBeenCalled()
	})

	it("bounds a stalled post-run source verification and preserves the completed producer receipt", async () => {
		const fixture = await createConfirmationFixture()
		vi.useFakeTimers()
		let reading!: () => void
		const ready = new Promise<void>((resolve) => {
			reading = resolve
		})
		let reads = 0
		const runCampaign = vi.fn(fixture.ports.runCampaign)
		const pending = runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign,
			readSource: async (arm, relativePath) => {
				if (++reads === 4) {
					reading()
					return new Promise<Uint8Array>(() => {})
				}
				return fixture.ports.readSource(arm, relativePath)
			},
		})
		await ready
		await vi.advanceTimersByTimeAsync(fixture.plan.limits.maxDurationMsPerArm)
		const receipt = await pending
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.execution[0]?.status).toBe("timed-out")
		expect(receipt.campaigns.control?.runId).toBe("fresh-control")
		expect(runCampaign).toHaveBeenCalledTimes(1)
	})

	it("rejects an unchanged build, identical source frame, held model change and undeclared source treatment", async () => {
		const fixture = await createConfirmationFixture()
		const sameBuild = structuredClone(fixture.plan)
		sameBuild.candidate.context.extensionBuildDigest = sameBuild.control.context.extensionBuildDigest
		const { digest: _digest, ...context } = sameBuild.candidate.context
		sameBuild.candidate.context = sealHarnessContext(context)
		sameBuild.candidate.variant.extensionBuildDigest = sameBuild.control.variant.extensionBuildDigest
		sameBuild.experiment.candidateVariantIdentity = immutableIdentity(sameBuild.candidate.variant)
		sameBuild.experiment.allowedDifferenceFields = sameBuild.experiment.allowedDifferenceFields!.filter(
			(field) => field !== "extensionBuildDigest",
		)
		expect(() => resealPlan(sameBuild)).toThrow(/changed candidate build/i)
		const sameSource = structuredClone(fixture.plan)
		const { digest: _sourceDigest, ...sourceContext } = sameSource.candidate.context
		sameSource.candidate.context = sealHarnessContext({
			...sourceContext,
			sourceFiles: sameSource.control.context.sourceFiles,
		})
		expect(() => resealPlan(sameSource)).toThrow(/actual source change/i)
		const model = structuredClone(fixture.plan)
		model.candidate.variant.model = "different-model"
		expect(() => resealPlan(model)).toThrow(/model|effort/i)
		const undeclared = structuredClone(fixture.plan)
		undeclared.experiment.allowedDifferenceFields = ["extensionBuildDigest"]
		expect(() => resealPlan(undeclared)).toThrow(/confounder/i)
	})

	it("retains a failed candidate and recommends revision when the intended target is unresolved", async () => {
		const fixture = await createConfirmationFixture()
		const campaigns = fixture.campaigns()
		campaigns.candidate = alterCampaign(campaigns.candidate, (body) => {
			body.observations[0]!.status = "outcome_failed"
			body.observations[0]!.firstAttemptStatus = "outcome_failed"
			body.accounting!.sampling!.passed--
			body.accounting!.sampling!.failed++
		})
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => campaigns[arm],
		})
		expect(receipt.status).toBe("revise")
		expect(receipt.campaigns.candidate?.observations[0]?.status).toBe("outcome_failed")
		expect(receipt.campaigns.candidate?.accounting?.sampling).toMatchObject({ planned: 2, completed: 2, failed: 1 })
	})

	it("recommends revert for a reproduced neighboring regression and retains its paired evidence", async () => {
		const fixture = await createConfirmationFixture()
		const campaigns = fixture.campaigns()
		campaigns.candidate = alterCampaign(campaigns.candidate, (body) => {
			body.observations[1]!.status = "outcome_failed"
			body.observations[1]!.firstAttemptStatus = "outcome_failed"
			body.accounting!.sampling!.passed--
			body.accounting!.sampling!.failed++
		})
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => campaigns[arm],
		})
		expect(receipt.status).toBe("revert")
		expect(receipt.pairedReport?.highRiskRegressions).toBe(1)
	})

	it.each([
		{
			status: "agent_error" as const,
			task: "target",
			index: 0,
			decision: "revise",
			legacyDigest: "sha256:2b3944c065dd796ef9d0484b258b5ad8549a9488f5b185e0b19a82f1840664fe",
		},
		{
			status: "budget_exhausted" as const,
			task: "target",
			index: 0,
			decision: "revise",
			legacyDigest: "sha256:be498c9ee3a13ac55609a56d1b84c2d8a7895ccaa754978ce1429c170db7c4d8",
		},
		{
			status: "agent_error" as const,
			task: "neighbor",
			index: 1,
			decision: "revert",
			legacyDigest: "sha256:de0d5b378c03dfd99fc61718ca27cfde8364972b5e09d4995c2cb974b624b100",
		},
		{
			status: "budget_exhausted" as const,
			task: "neighbor",
			index: 1,
			decision: "revert",
			legacyDigest: "sha256:3bb92efc2cc13fd1792db99c49c4a04c37c2fb545be49cf83c4f0bb1611852a3",
		},
	])(
		"classifies observed $task $status with decision $decision and replays its legacy receipt",
		async ({ status, index, decision, legacyDigest }) => {
			const fixture = await createConfirmationFixture()
			const campaigns = fixture.campaigns()
			campaigns.candidate = alterCampaign(campaigns.candidate, (body) => {
				body.observations[index]!.status = status
				body.observations[index]!.firstAttemptStatus = status
				body.accounting!.sampling!.passed--
				body.accounting!.sampling!.failed++
			})
			const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
				...fixture.ports,
				runCampaign: async ({ arm }) => campaigns[arm],
			})
			expect(receipt.status).toBe(decision)
			expect(receipt.campaigns.candidate!.observations[index]!.status).toBe(status)
			expect(receipt.campaigns.candidate!.accounting!.sampling).toMatchObject({
				completed: 2,
				failed: 1,
				blocked: 0,
			})
			expect(receipt.pairedReport!.candidate.overall.outcome).toMatchObject({
				successes: 1,
				failures: 1,
				excluded: 0,
			})
			expect(receipt.reasons).not.toContain(
				"Infrastructure, cancelled or otherwise unscoreable attempts remain in the denominator",
			)
			expect(parseConfirmationReceipt(JSON.parse(JSON.stringify(receipt)), fixture.sources)).toEqual(receipt)
			// Digests captured from the actual unmarked conservative producer on 2026-10-24.
			// Reconstructing its otherwise identical body keeps the historic fixtures readable.
			const legacy = legacyConservativeReceipt(receipt)
			expect(legacy.digest).toBe(legacyDigest)
			expect(parseConfirmationReceipt(JSON.parse(JSON.stringify(legacy)), fixture.sources)).toEqual(legacy)
			expect(legacy).not.toHaveProperty("decisionPolicy")
			expect(receipt).toHaveProperty("decisionPolicy", "scoreable-status-v1")
		},
	)

	it("rejects unknown or downgraded decision policies and an unsafe unmarked keep", async () => {
		const fixture = await createConfirmationFixture()
		const campaigns = fixture.campaigns()
		campaigns.candidate = alterCampaign(campaigns.candidate, (body) => {
			body.observations[0]!.status = "agent_error"
			body.observations[0]!.firstAttemptStatus = "agent_error"
			body.accounting!.sampling!.passed--
			body.accounting!.sampling!.failed++
		})
		const current = await runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => campaigns[arm],
		})
		const legacy = legacyConservativeReceipt(current)
		const { digest: _digest, ...currentBody } = current
		const { digest: _legacyDigest, ...legacyBody } = legacy
		const downgraded = { ...currentBody }
		Reflect.deleteProperty(downgraded, "decisionPolicy")
		const changedPolicy = { ...legacyBody, decisionPolicy: "scoreable-status-v1" }
		const unsafeKeep = { ...legacyBody, status: "keep", reasons: [] }
		for (const body of [
			{ ...currentBody, decisionPolicy: "unrecognized-policy" },
			{ ...currentBody, decisionPolicy: "legacy-conservative-v1" },
			downgraded,
			changedPolicy,
			unsafeKeep,
		]) {
			expect(() =>
				parseConfirmationReceipt({ ...body, digest: sha256(canonicalJson(body)) }, fixture.sources),
			).toThrow()
		}
	})

	it("retains a failed infrastructure denominator without calling it an observed quality regression", async () => {
		const fixture = await createConfirmationFixture()
		const campaigns = fixture.campaigns()
		campaigns.candidate = alterCampaign(campaigns.candidate, (body) => {
			body.observations[1]!.status = "infrastructure_error"
			body.observations[1]!.firstAttemptStatus = "infrastructure_error"
			body.accounting!.sampling!.passed--
			body.accounting!.sampling!.failed++
		})
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => campaigns[arm],
		})
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.pairedReport?.highRiskRegressions).toBe(1)
		expect(receipt.campaigns.candidate?.accounting?.sampling).toMatchObject({ completed: 2, failed: 1, blocked: 0 })
		expect(receipt.reasons).toContain(
			"Infrastructure, cancelled or otherwise unscoreable attempts remain in the denominator",
		)
	})

	it("retains incomplete runs, invalid denominators and old artifacts as inconclusive", async () => {
		const fixture = await createConfirmationFixture()
		for (const edit of [
			(body: Omit<CampaignExport, "digest">) => {
				body.incomplete.push({ reason: "Campaign reached its request budget" })
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.accounting!.sampling!.notRun = 1
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.accounting!.sampling = undefined
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.observations[0]!.startedAt = "2026-10-23T14:30:00.000Z"
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.observations[0]!.decisionPlanDigest = undefined
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.observations[0]!.firstAttemptStatus = "outcome_failed"
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.observations[0]!.retryAssisted = true
			},
			(body: Omit<CampaignExport, "digest">) => {
				body.runId = "archived-run"
			},
		]) {
			const campaigns = fixture.campaigns()
			campaigns.candidate = alterCampaign(campaigns.candidate, edit)
			const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
				...fixture.ports,
				runCampaign: async ({ arm }) => campaigns[arm],
			})
			expect(receipt.status).toBe("inconclusive")
			expect(receipt.campaigns.candidate?.digest).toBe(campaigns.candidate.digest)
		}
	})

	it("omits only schema-optional object absence and never invokes a transport getter", async () => {
		const fixture = await createConfirmationFixture()
		const campaigns = fixture.campaigns()
		let invoked = false
		const candidate = structuredClone(campaigns.candidate)
		Object.defineProperty(candidate.observations[0]!, "status", {
			enumerable: true,
			get: () => {
				invoked = true
				return "passed"
			},
		})
		const receipt = evaluateConfirmation(fixture.plan, fixture.sources, { control: campaigns.control, candidate })
		expect(invoked).toBe(false)
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.campaigns.candidate).toBeNull()
		for (const candidate of [
			{ ...campaigns.candidate, unrecognizedAbsence: undefined },
			{ ...campaigns.candidate, observations: [...campaigns.candidate.observations, undefined] },
		])
			expect(
				evaluateConfirmation(fixture.plan, fixture.sources, { control: campaigns.control, candidate }).campaigns
					.candidate,
			).toBeNull()
	})

	it("preserves control evidence when the candidate runner fails without leaking its error text", async () => {
		const fixture = await createConfirmationFixture()
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => {
				if (arm === "candidate") throw new Error("Secret-bearing provider diagnostic")
				return fixture.campaigns().control
			},
		})
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.campaigns.control).not.toBeNull()
		expect(receipt.campaigns.candidate).toBeNull()
		expect(receipt.execution.map(({ status }) => status)).toEqual(["returned", "failed"])
		expect(JSON.stringify(receipt)).not.toContain("Secret-bearing")
	})

	it("waits for an aborted runner to settle and never dispatches the candidate after its deadline", async () => {
		const fixture = await createConfirmationFixture()
		vi.useFakeTimers()
		let resolveRunner!: (value: CampaignExport) => void
		let dispatched!: () => void
		const ready = new Promise<void>((resolve) => {
			dispatched = resolve
		})
		let request: ConfirmationRunRequest | undefined
		const runCampaign = vi.fn(async (value: ConfirmationRunRequest) => {
			request = value
			dispatched()
			return new Promise<CampaignExport>((resolve) => {
				resolveRunner = resolve
			})
		})
		let settled = false
		const pending = runFreshConfirmation(fixture.plan, fixture.sources, { ...fixture.ports, runCampaign }).then(
			(receipt) => {
				settled = true
				return receipt
			},
		)
		await ready
		await vi.advanceTimersByTimeAsync(fixture.plan.limits.maxDurationMsPerArm)
		expect(request?.signal.aborted).toBe(true)
		expect(settled).toBe(false)
		expect(runCampaign).toHaveBeenCalledTimes(1)
		resolveRunner(fixture.campaigns().control)
		const receipt = await pending
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.execution[0]?.status).toBe("timed-out")
		expect(receipt.campaigns.control).not.toBeNull()
		expect(runCampaign).toHaveBeenCalledTimes(1)
	})

	it("keeps live improvement inconclusive when the existing paired bound overlaps zero", async () => {
		const fixture = await createConfirmationFixture({ live: true })
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, fixture.ports)
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.liveQualityImprovement).toBe(false)
		expect(receipt.pairedReport?.decisionEvidence.status).toBe("inconclusive")
	})

	it("preserves a declared noninferiority scope and withholds promotion without golden certification", async () => {
		const fixture = await createConfirmationFixture({ live: true, additionalCases: 40, samples: 3 })
		const changed = structuredClone(fixture.plan)
		changed.experiment.decisionPlan!.objective = "noninferiority"
		changed.experiment.decisionPlan!.margin = 0.5
		const plan = resealPlan(changed)
		const campaigns = fixture.campaigns(plan)
		const receipt = await runFreshConfirmation(plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => campaigns[arm],
		})
		expect(
			receipt.status,
			JSON.stringify({ reasons: receipt.reasons, decision: receipt.pairedReport?.decisionEvidence }),
		).toBe("keep")
		expect(receipt.pairedReport?.decisionEvidence).toMatchObject({
			status: "accepted",
			objective: "noninferiority",
			margin: 0.5,
		})
		expect(receipt.liveQualityImprovement).toBe(false)
		expect(receipt.promotion).toEqual({ allowed: false, reasons: ["golden certification is not current"] })
	})

	it("keeps unknown cost distinct from an observed cost regression after an accepted live decision", async () => {
		const fixture = await createConfirmationFixture({ live: true, additionalCases: 40, samples: 3 })
		const changed = structuredClone(fixture.plan)
		changed.experiment.decisionPlan!.objective = "noninferiority"
		changed.experiment.decisionPlan!.margin = 0.5
		const plan = resealPlan(changed)
		const campaigns = fixture.campaigns(plan)
		for (const arm of ["control", "candidate"] as const)
			campaigns[arm] = alterCampaign(campaigns[arm], (body) => {
				body.accounting!.totalCost = null
				for (const observation of body.observations) observation.cost = null
			})
		const receipt = await runFreshConfirmation(plan, fixture.sources, {
			...fixture.ports,
			runCampaign: async ({ arm }) => campaigns[arm],
		})
		expect(receipt.pairedReport?.decisionEvidence.status).toBe("accepted")
		expect(receipt.status).toBe("inconclusive")
		expect(receipt.reasons).toContain("Required cost coverage is incomplete")
		expect(receipt.reasons).not.toContain("cost-per-success regression")
	})

	it("adapts the existing raw host producer while passing bounded execution context intact", async () => {
		const fixture = await createConfirmationFixture()
		const raw = vi.fn(async (request: ConfirmationRunRequest) =>
			fixture.rawCampaign(request.arm, request.experiment.decisionPlan),
		)
		const receipt = await runFreshConfirmation(fixture.plan, fixture.sources, {
			...fixture.ports,
			runCampaign: createHostCampaignConfirmationRunner(raw),
		})
		expect(receipt.status).toBe("keep")
		expect(raw.mock.calls[0]?.[0]).toMatchObject({
			runId: "fresh-control",
			timeWindow: "confirmation-block",
			limits: fixture.plan.limits,
		})
		expect(raw.mock.calls[0]?.[0].decisionPlanDigest).toBe(
			sha256(canonicalJson(fixture.plan.experiment.decisionPlan)),
		)
	})

	it("rejects raw verdicts, changed seals and recomputed forged statuses at report read", async () => {
		const fixture = await createConfirmationFixture()
		expect(() =>
			parseConfirmationReceipt({ status: "keep", digest: "anything", reasons: [] }, fixture.sources),
		).toThrow()
		const receipt = evaluateConfirmation(fixture.plan, fixture.sources, fixture.campaigns())
		expect(() => parseConfirmationReceipt({ ...receipt, status: "keep" }, fixture.sources)).toThrow(/digest/i)
		const { digest: _digest, ...body } = receipt
		const forged = { ...body, status: "keep", liveQualityImprovement: true }
		expect(() =>
			parseConfirmationReceipt({ ...forged, digest: sha256(canonicalJson(forged)) }, fixture.sources),
		).toThrow(/recomputed/i)
		expect(() => parseConfirmationPlan({ ...fixture.plan, declaredAt: CONFIRMATION_TIME })).toThrow(/digest/i)
	})
})
