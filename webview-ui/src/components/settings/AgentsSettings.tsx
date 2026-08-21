import { AlertTriangle, Bot, Coins, Compass, Gauge, GitBranch, Hammer, ShieldCheck, Timer } from "lucide-react"

import { subagentRootCostBudgetSchema, type ProviderSettingsEntry } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui"

import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import {
	clampManagedAgentNumber,
	MANAGED_AGENT_SETTING_LIMITS,
	type ManagedAgentRole,
	type ManagedAgentSettings,
	type SetSettingsCachedStateField,
} from "./managed-agent-settings"

interface AgentsSettingsProps {
	profiles: ProviderSettingsEntry[]
	defaultProfileId?: string
	profileByRole?: { explore?: string; review?: string; worker?: string }
	managedAgentSettings: ManagedAgentSettings
	setCachedStateField: SetSettingsCachedStateField
}

type Role = ManagedAgentRole
type NumericManagedAgentSettingKey =
	| "maxConcurrentSubagents"
	| "subagentMaxInputTokens"
	| "subagentMaxOutputTokens"
	| "subagentMaxDepth"

const numberInputClassName =
	"h-9 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 text-vscode-input-foreground shadow-sm focus-visible:border-[var(--border-accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--alpha-accent)]"

interface NumberSettingProps {
	id: string
	label: string
	description: string
	value: number | undefined
	min: number
	max?: number
	step?: number | "any"
	optional?: boolean
	onChange: (rawValue: string) => void
}

function NumberSetting({
	id,
	label,
	description,
	value,
	min,
	max,
	step = 1,
	optional = false,
	onChange,
}: NumberSettingProps) {
	const descriptionId = `${id}-description`

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<label className="font-medium text-vscode-foreground" htmlFor={id}>
				{label}
			</label>
			<input
				id={id}
				type="number"
				inputMode="decimal"
				className={numberInputClassName}
				min={min}
				max={max}
				step={step}
				value={value ?? ""}
				placeholder={optional ? "No limit" : undefined}
				aria-describedby={descriptionId}
				onChange={(event) => onChange(event.target.value)}
				data-testid={id}
			/>
			<p id={descriptionId} className="m-0 text-xs leading-5 text-vscode-descriptionForeground">
				{description}
			</p>
		</div>
	)
}

function profileLabel(profile: ProviderSettingsEntry): string {
	const provider = profile.apiProvider ?? "Unconfigured"
	const model = profile.modelId ?? "provider default"
	return `${profile.name} · ${provider} · ${model}`
}

export function AgentsSettings({
	profiles,
	defaultProfileId,
	profileByRole,
	managedAgentSettings,
	setCachedStateField,
}: AgentsSettingsProps) {
	const { t } = useAppTranslation()
	const profileIds = new Set(profiles.map((profile) => profile.id))
	const defaultIsStale = Boolean(defaultProfileId && !profileIds.has(defaultProfileId))

	const setRoleProfile = (role: Role, profileId: string) => {
		const next = { ...profileByRole, [role]: profileId || undefined }
		setCachedStateField("subagentApiConfigByRole", next.explore || next.review || next.worker ? next : undefined)
	}

	const setBoundedNumber = (
		field: NumericManagedAgentSettingKey,
		rawValue: string,
		limits: { min: number; max: number },
	) => {
		setCachedStateField(field, clampManagedAgentNumber(rawValue, managedAgentSettings[field], limits))
	}

	const setRoleTimeout = (role: Role, rawValue: string) => {
		const currentValue = managedAgentSettings.subagentRoleTimeoutsMs[role]
		const parsedSeconds = Number(rawValue)
		const requestedMs = Number.isFinite(parsedSeconds) ? parsedSeconds * 1_000 : currentValue
		setCachedStateField("subagentRoleTimeoutsMs", {
			...managedAgentSettings.subagentRoleTimeoutsMs,
			[role]: clampManagedAgentNumber(requestedMs, currentValue, MANAGED_AGENT_SETTING_LIMITS.timeoutMs),
		})
	}

	const buildOptions = (emptyLabel: string, staleProfileId?: string): SearchableSelectOption[] => [
		{ value: "", label: emptyLabel },
		...(staleProfileId && !profileIds.has(staleProfileId)
			? [
					{
						value: staleProfileId,
						label: t("settings:agents.unavailableProfile", { id: staleProfileId }),
						icon: <AlertTriangle className="mr-2 size-4 text-vscode-editorWarning-foreground" />,
					},
				]
			: []),
		...profiles.map((profile) => ({ value: profile.id, label: profileLabel(profile) })),
	]

	const renderStaleWarning = (profileId?: string) =>
		profileId && !profileIds.has(profileId) ? (
			<div className="mt-2 flex items-start gap-2 text-xs text-vscode-editorWarning-foreground" role="status">
				<AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
				<span>{t("settings:agents.staleWarning")}</span>
			</div>
		) : null

	return (
		<div>
			<SectionHeader description={t("settings:agents.description")}>
				{t("settings:sections.agents")}
			</SectionHeader>
			<Section>
				<div className="space-y-4">
					<SearchableSetting
						settingId="agents-default-profile"
						section="agents"
						label={t("settings:agents.defaultProfile.label")}>
						<div className="rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
							<div className="mb-3 flex items-start gap-3">
								<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--alpha-accent-soft)] text-[var(--alpha-brand-teal)]">
									<Bot className="size-4" aria-hidden="true" />
								</div>
								<div className="min-w-0">
									<div className="font-semibold text-vscode-foreground">
										{t("settings:agents.defaultProfile.label")}
									</div>
									<p className="m-0 mt-0.5 text-xs text-vscode-descriptionForeground">
										{t("settings:agents.defaultProfile.description")}
									</p>
								</div>
							</div>
							<SearchableSelect
								aria-label={t("settings:agents.defaultProfile.label")}
								value={defaultProfileId ?? ""}
								onValueChange={(value) =>
									setCachedStateField("subagentDefaultApiConfigId", value || undefined)
								}
								options={buildOptions(
									t("settings:agents.defaultProfile.inheritParent"),
									defaultIsStale ? defaultProfileId : undefined,
								)}
								placeholder={t("settings:agents.defaultProfile.inheritParent")}
								searchPlaceholder={t("settings:agents.searchPlaceholder")}
								emptyMessage={t("settings:agents.noProfilesFound")}
								className="h-9"
								data-testid="subagent-default-profile"
							/>
							{renderStaleWarning(defaultProfileId)}
						</div>
					</SearchableSetting>

					<div className="border-t border-vscode-panel-border pt-4">
						<div className="mb-3">
							<div className="font-semibold text-vscode-foreground">
								{t("settings:agents.roles.title")}
							</div>
							<p className="m-0 mt-1 text-xs text-vscode-descriptionForeground">
								{t("settings:agents.roles.description")}
							</p>
						</div>
						<div className="grid gap-3 xl:grid-cols-3">
							{(["explore", "review", "worker"] as const).map((role) => {
								const selectedId = profileByRole?.[role]
								const RoleIcon = role === "explore" ? Compass : role === "review" ? ShieldCheck : Hammer

								return (
									<SearchableSetting
										key={role}
										settingId={`agents-${role}-profile`}
										section="agents"
										label={t(`settings:agents.roles.${role}.label`)}
										className="rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
										<div className="mb-3 flex items-start gap-3">
											<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-vscode-badge-background text-vscode-badge-foreground">
												<RoleIcon className="size-4" aria-hidden="true" />
											</div>
											<div className="min-w-0">
												<div className="font-semibold text-vscode-foreground">
													{t(`settings:agents.roles.${role}.label`)}
												</div>
												<p className="m-0 mt-0.5 text-xs text-vscode-descriptionForeground">
													{t(`settings:agents.roles.${role}.description`)}
												</p>
											</div>
										</div>
										<SearchableSelect
											aria-label={t(`settings:agents.roles.${role}.label`)}
											value={selectedId ?? ""}
											onValueChange={(value) => setRoleProfile(role, value)}
											options={buildOptions(t("settings:agents.roles.useDefault"), selectedId)}
											placeholder={t("settings:agents.roles.useDefault")}
											searchPlaceholder={t("settings:agents.searchPlaceholder")}
											emptyMessage={t("settings:agents.noProfilesFound")}
											className="h-9"
											data-testid={`subagent-${role}-profile`}
										/>
										{renderStaleWarning(selectedId)}
									</SearchableSetting>
								)
							})}
						</div>
					</div>

					<div className="border-t border-vscode-panel-border pt-5">
						<div className="mb-4 flex items-start gap-3">
							<div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--alpha-accent-soft)] text-[var(--alpha-brand-teal)]">
								<Gauge className="size-4" aria-hidden="true" />
							</div>
							<div className="min-w-0">
								<h3 className="m-0 font-semibold text-vscode-foreground">Orchestration guardrails</h3>
								<p className="m-0 mt-1 text-xs leading-5 text-vscode-descriptionForeground">
									Limits are frozen when a managed-agent root starts, so changing them does not
									rewrite a live run.
								</p>
							</div>
						</div>

						<div className="grid gap-4 md:grid-cols-2">
							<SearchableSetting
								settingId="agents-child-concurrency"
								section="agents"
								label="Concurrent child agents"
								className="rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
								<NumberSetting
									id="max-concurrent-subagents-input"
									label="Concurrent child agents"
									description="Maximum descendants that one root may run at once. Additional work waits for capacity."
									value={managedAgentSettings.maxConcurrentSubagents}
									{...MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents}
									onChange={(value) =>
										setBoundedNumber(
											"maxConcurrentSubagents",
											value,
											MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents,
										)
									}
								/>
							</SearchableSetting>

							<SearchableSetting
								settingId="agents-delegation-policy"
								section="agents"
								label="Delegation policy"
								className="rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
								<div className="font-medium text-vscode-foreground">Delegation policy</div>
								<SearchableSelect
									aria-label="Delegation policy"
									value={managedAgentSettings.subagentDelegationPolicy}
									onValueChange={(value) =>
										setCachedStateField(
											"subagentDelegationPolicy",
											value === "proactive" ? "proactive" : "explicit-only",
										)
									}
									options={[
										{ value: "explicit-only", label: "Explicit requests only" },
										{ value: "proactive", label: "Allow proactive delegation" },
									]}
									placeholder="Select a delegation policy"
									searchPlaceholder="Search delegation policies..."
									emptyMessage="No matching delegation policy"
									className="mt-2 h-9"
									data-testid="subagent-delegation-policy"
								/>
								<p className="m-0 mt-2 text-xs leading-5 text-vscode-descriptionForeground">
									{managedAgentSettings.subagentDelegationPolicy === "proactive"
										? "Agents may delegate when it is useful, within the configured limits and approvals."
										: "Managed children start only when the user or task instructions explicitly request delegation."}
								</p>
							</SearchableSetting>
						</div>

						<div className="mt-4 rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
							<div className="mb-3 flex items-center gap-2 font-semibold text-vscode-foreground">
								<Timer className="size-4" aria-hidden="true" />
								Role timeouts
							</div>
							<div className="grid gap-4 md:grid-cols-3">
								{(["explore", "review", "worker"] as const).map((role) => (
									<SearchableSetting
										key={role}
										settingId={`agents-${role}-timeout`}
										section="agents"
										label={`${role[0].toUpperCase()}${role.slice(1)} timeout`}>
										<NumberSetting
											id={`subagent-${role}-timeout-input`}
											label={`${role[0].toUpperCase()}${role.slice(1)} (seconds)`}
											description={`Stops a ${role} agent after this elapsed time.`}
											value={managedAgentSettings.subagentRoleTimeoutsMs[role] / 1_000}
											min={MANAGED_AGENT_SETTING_LIMITS.timeoutMs.min / 1_000}
											max={MANAGED_AGENT_SETTING_LIMITS.timeoutMs.max / 1_000}
											onChange={(value) => setRoleTimeout(role, value)}
										/>
									</SearchableSetting>
								))}
							</div>
						</div>

						<div className="mt-4 rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
							<div className="mb-3 flex items-center gap-2 font-semibold text-vscode-foreground">
								<Coins className="size-4" aria-hidden="true" />
								Token and cost guardrails
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								<SearchableSetting
									settingId="agents-input-token-limit"
									section="agents"
									label="Input tokens per child">
									<NumberSetting
										id="subagent-max-input-tokens-input"
										label="Input tokens per child"
										description="Maximum input-token allowance captured for one managed child."
										value={managedAgentSettings.subagentMaxInputTokens}
										{...MANAGED_AGENT_SETTING_LIMITS.inputTokens}
										onChange={(value) =>
											setBoundedNumber(
												"subagentMaxInputTokens",
												value,
												MANAGED_AGENT_SETTING_LIMITS.inputTokens,
											)
										}
									/>
								</SearchableSetting>
								<SearchableSetting
									settingId="agents-output-token-limit"
									section="agents"
									label="Output tokens per child">
									<NumberSetting
										id="subagent-max-output-tokens-input"
										label="Output tokens per child"
										description="Maximum generated output tokens for one child before it is stopped."
										value={managedAgentSettings.subagentMaxOutputTokens}
										{...MANAGED_AGENT_SETTING_LIMITS.outputTokens}
										onChange={(value) =>
											setBoundedNumber(
												"subagentMaxOutputTokens",
												value,
												MANAGED_AGENT_SETTING_LIMITS.outputTokens,
											)
										}
									/>
								</SearchableSetting>
								<SearchableSetting
									settingId="agents-root-token-budget"
									section="agents"
									label="Root token budget">
									<NumberSetting
										id="subagent-root-token-budget-input"
										label="Root token budget"
										description="Optional aggregate token ceiling. Leave blank for no limit."
										value={managedAgentSettings.subagentRootTokenBudget ?? undefined}
										{...MANAGED_AGENT_SETTING_LIMITS.rootTokens}
										optional
										onChange={(value) => {
											if (value === "") {
												setCachedStateField("subagentRootTokenBudget", null)
												return
											}
											const parsed = Number(value)
											if (Number.isFinite(parsed)) {
												const { min, max } = MANAGED_AGENT_SETTING_LIMITS.rootTokens
												setCachedStateField(
													"subagentRootTokenBudget",
													Math.trunc(Math.min(Math.max(parsed, min), max)),
												)
											}
										}}
									/>
								</SearchableSetting>
								<SearchableSetting
									settingId="agents-root-cost-budget"
									section="agents"
									label="Root cost budget">
									<NumberSetting
										id="subagent-root-cost-budget-input"
										label="Root cost budget (USD)"
										description="Optional aggregate cost ceiling. Leave blank for no cost limit."
										value={managedAgentSettings.subagentRootCostBudget ?? undefined}
										min={Number.MIN_VALUE}
										step="any"
										optional
										onChange={(value) => {
											if (value === "") {
												setCachedStateField("subagentRootCostBudget", null)
												return
											}
											const parsed = subagentRootCostBudgetSchema.safeParse(Number(value))
											if (parsed.success)
												setCachedStateField("subagentRootCostBudget", parsed.data)
										}}
									/>
								</SearchableSetting>
							</div>
						</div>

						<SearchableSetting
							settingId="agents-max-depth"
							section="agents"
							label="Maximum nesting depth"
							className="mt-4 rounded-xl border border-vscode-panel-border bg-vscode-editor-background/30 p-3">
							<div className="mb-3 flex items-center gap-2 font-semibold text-vscode-foreground">
								<GitBranch className="size-4" aria-hidden="true" />
								Tree depth
							</div>
							<NumberSetting
								id="subagent-max-depth-input"
								label="Maximum nesting depth"
								description="Maximum descendant levels below a root. A value of 1 keeps delegation depth-one."
								value={managedAgentSettings.subagentMaxDepth}
								{...MANAGED_AGENT_SETTING_LIMITS.maxDepth}
								onChange={(value) =>
									setBoundedNumber("subagentMaxDepth", value, MANAGED_AGENT_SETTING_LIMITS.maxDepth)
								}
							/>
						</SearchableSetting>
					</div>
				</div>
			</Section>
		</div>
	)
}
