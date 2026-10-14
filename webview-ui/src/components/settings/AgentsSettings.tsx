import { useEffect, useRef, useState, type HTMLAttributes } from "react"
import {
	DEFAULT_MAX_CONCURRENT_TASKS,
	subagentAgentTypeDefinitionSchema,
	subagentSpawnAgentTypeSchema,
	type ProviderSettingsEntry,
	type SubagentAgentTypeDefinition,
} from "@alpha-code/types"

import { Button } from "@/components/ui/button"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import {
	DEFAULT_MANAGED_AGENT_SETTINGS,
	MANAGED_AGENT_SETTING_LIMITS,
	type SettingsCachedState,
	type SetSettingsCachedStateField,
} from "./managed-agent-settings"
import {
	getManagedAgentSettingsIssues,
	MANAGED_AGENT_ROLES,
	parseManagedAgentNumericInput,
	parseManagedAgentTimeoutSeconds,
	parseOptionalManagedAgentNumericInput,
} from "./agents-settings-validation"

const inputClassName =
	"max-w-full rounded bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 focus-visible:outline focus-visible:outline-vscode-focusBorder"

interface AgentsSettingsProps extends HTMLAttributes<HTMLDivElement> {
	values: SettingsCachedState
	setCachedStateField: SetSettingsCachedStateField
	listApiConfigMeta?: ProviderSettingsEntry[]
}

interface NumberSettingProps {
	settingId: string
	label: string
	description: string
	value: number | null
	min: number
	max?: number
	step?: number | "any"
	placeholder?: string
	error?: string
	onChange: (rawValue: string, badInput: boolean) => void
}

function NumberSetting({
	settingId,
	label,
	description,
	value,
	min,
	max,
	step = 1,
	placeholder,
	error,
	onChange,
}: NumberSettingProps) {
	return (
		<SearchableSetting settingId={settingId} section="agents" label={label}>
			<div className="flex flex-col gap-2">
				<label className="font-medium" htmlFor={settingId}>
					{label}
				</label>
				<input
					id={settingId}
					data-testid={settingId}
					className={`${inputClassName} w-44`}
					type="number"
					min={min}
					max={max}
					step={step}
					placeholder={placeholder}
					value={value !== null && Number.isFinite(value) ? value : ""}
					aria-invalid={!!error}
					aria-describedby={`${settingId}-description${error ? ` ${settingId}-error` : ""}`}
					onChange={(event) => onChange(event.target.value, event.target.validity.badInput)}
				/>
				<p id={`${settingId}-description`} className="text-vscode-descriptionForeground text-sm m-0">
					{description}
				</p>
				{error && (
					<p id={`${settingId}-error`} role="alert" className="text-vscode-errorForeground text-sm m-0">
						{error}
					</p>
				)}
			</div>
		</SearchableSetting>
	)
}

interface ProfileSelectProps {
	id: string
	label: string
	value: string | undefined
	inheritLabel: string
	profiles: ProviderSettingsEntry[]
	onChange: (profileId: string | undefined) => void
}

function ProfileSelect({ id, label, value, inheritLabel, profiles, onChange }: ProfileSelectProps) {
	const { t } = useAppTranslation()
	const selectedProfile = profiles.find((profile) => profile.id === value)
	const missing = !!value && !selectedProfile
	const unconfigured = !!selectedProfile && !selectedProfile.apiProvider
	const warning = missing
		? t("agents:profile.missingWarning")
		: unconfigured
			? t("agents:profile.unconfiguredWarning")
			: undefined

	return (
		<div className="flex flex-col gap-2">
			<label className="font-medium" htmlFor={id}>
				{label}
			</label>
			<select
				id={id}
				data-testid={id}
				className={`${inputClassName} w-full`}
				value={value ?? ""}
				aria-describedby={warning ? `${id}-warning` : undefined}
				onChange={(event) => onChange(event.target.value || undefined)}>
				<option value="">{inheritLabel}</option>
				{missing && <option value={value}>{t("agents:profile.missingOption", { id: value })}</option>}
				{profiles.map((profile) => (
					<option key={profile.id} value={profile.id}>
						{profile.name}
					</option>
				))}
			</select>
			{warning && (
				<p id={`${id}-warning`} className="text-vscode-descriptionForeground text-sm m-0">
					{warning}
				</p>
			)}
		</div>
	)
}

export function AgentsSettings({ values, setCachedStateField, listApiConfigMeta = [], ...props }: AgentsSettingsProps) {
	const { t } = useAppTranslation()
	const advancedRef = useRef<HTMLDetailsElement>(null)
	const [newTypeName, setNewTypeName] = useState("")
	const [newTypeDescription, setNewTypeDescription] = useState("")
	const [showNewTypeError, setShowNewTypeError] = useState(false)
	const issues = getManagedAgentSettingsIssues(values)
	const advancedHasError = issues.some(
		({ settingId }) => settingId !== "agents-concurrency" && settingId !== "agents-delegation-policy",
	)
	useEffect(() => {
		if (advancedHasError && advancedRef.current) advancedRef.current.open = true
	}, [advancedHasError])
	const errorFor = (settingId: string) => {
		const issue = issues.find((candidate) => candidate.settingId === settingId)
		return issue ? t(issue.translationKey) : undefined
	}
	const types = values.subagentAgentTypes ?? {}
	const updateType = (name: string, update: Partial<SubagentAgentTypeDefinition>) => {
		setCachedStateField("subagentAgentTypes", { ...types, [name]: { ...types[name], ...update } })
	}
	const addType = () => {
		const name = newTypeName.trim()
		const definition = subagentAgentTypeDefinitionSchema.safeParse({ description: newTypeDescription })
		if (
			!subagentSpawnAgentTypeSchema.safeParse(name).success ||
			!definition.success ||
			Object.hasOwn(types, name) ||
			Object.keys(types).length >= 24
		) {
			setShowNewTypeError(true)
			return
		}
		setCachedStateField("subagentAgentTypes", { ...types, [name]: definition.data })
		setNewTypeName("")
		setNewTypeDescription("")
		setShowNewTypeError(false)
	}
	const childTokenLimits = MANAGED_AGENT_SETTING_LIMITS.inputTokens
	const timeoutLimits = MANAGED_AGENT_SETTING_LIMITS.timeoutMs

	return (
		<div {...props}>
			<SectionHeader description={t("agents:description")}>{t("agents:title")}</SectionHeader>
			<Section>
				<p className="text-vscode-descriptionForeground text-sm m-0">{t("agents:timing")}</p>
				<NumberSetting
					settingId="agents-concurrency"
					label={t("agents:concurrency.label")}
					description={t("agents:concurrency.description", {
						...MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents,
						default: DEFAULT_MANAGED_AGENT_SETTINGS.maxConcurrentSubagents,
					})}
					value={values.maxConcurrentSubagents}
					{...MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents}
					error={errorFor("agents-concurrency")}
					onChange={(rawValue) =>
						setCachedStateField("maxConcurrentSubagents", parseManagedAgentNumericInput(rawValue))
					}
				/>
				<p data-testid="agents-task-capacity" className="text-vscode-descriptionForeground text-sm m-0">
					{t("agents:concurrency.taskCapacity", {
						capacity: values.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
					})}
				</p>
				<SearchableSetting
					settingId="agents-delegation-policy"
					section="agents"
					label={t("agents:delegation.label")}>
					<div className="flex flex-col gap-2">
						<label className="font-medium" htmlFor="agents-delegation-policy">
							{t("agents:delegation.label")}
						</label>
						<select
							id="agents-delegation-policy"
							data-testid="agents-delegation-policy"
							className={`${inputClassName} w-full`}
							value={values.subagentDelegationPolicy}
							aria-invalid={!!errorFor("agents-delegation-policy")}
							aria-describedby="agents-delegation-policy-description"
							onChange={(event) =>
								setCachedStateField(
									"subagentDelegationPolicy",
									event.target.value === "proactive" ? "proactive" : "explicit-only",
								)
							}>
							<option value="explicit-only">{t("agents:delegation.explicitOnly")}</option>
							<option value="proactive">{t("agents:delegation.proactive")}</option>
						</select>
						<p
							id="agents-delegation-policy-description"
							className="text-vscode-descriptionForeground text-sm m-0">
							{t("agents:delegation.description")}
						</p>
						{errorFor("agents-delegation-policy") && (
							<p role="alert">{errorFor("agents-delegation-policy")}</p>
						)}
					</div>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-default-profile"
					section="agents"
					label={t("agents:defaultProfile.label")}>
					<ProfileSelect
						id="agents-default-profile"
						label={t("agents:defaultProfile.label")}
						value={values.subagentDefaultApiConfigId}
						inheritLabel={t("agents:defaultProfile.inherit")}
						profiles={listApiConfigMeta}
						onChange={(profileId) => setCachedStateField("subagentDefaultApiConfigId", profileId)}
					/>
					<p className="text-vscode-descriptionForeground text-sm mt-2 mb-0">
						{t("agents:defaultProfile.description")}
					</p>
				</SearchableSetting>
				<details ref={advancedRef} data-agents-advanced>
					<summary className="font-medium cursor-pointer">{t("agents:advanced.title")}</summary>
					<div className="flex flex-col gap-6 mt-4">
						<NumberSetting
							settingId="agents-depth"
							label={t("agents:depth.label")}
							description={t("agents:depth.description", {
								...MANAGED_AGENT_SETTING_LIMITS.maxDepth,
								default: DEFAULT_MANAGED_AGENT_SETTINGS.subagentMaxDepth,
							})}
							value={values.subagentMaxDepth}
							{...MANAGED_AGENT_SETTING_LIMITS.maxDepth}
							error={errorFor("agents-depth")}
							onChange={(rawValue) =>
								setCachedStateField("subagentMaxDepth", parseManagedAgentNumericInput(rawValue))
							}
						/>
						<fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
							<legend className="font-medium mb-2">{t("agents:timeouts.title")}</legend>
							{MANAGED_AGENT_ROLES.map((role) => (
								<NumberSetting
									key={role}
									settingId={`agents-timeout-${role}`}
									label={t("agents:timeouts.label", { role: t(`agents:roles.${role}`) })}
									description={t("agents:timeouts.description", {
										min: timeoutLimits.min / 1_000,
										max: timeoutLimits.max / 1_000,
										explore: DEFAULT_MANAGED_AGENT_SETTINGS.subagentRoleTimeoutsMs.explore / 1_000,
										review: DEFAULT_MANAGED_AGENT_SETTINGS.subagentRoleTimeoutsMs.review / 1_000,
										worker: DEFAULT_MANAGED_AGENT_SETTINGS.subagentRoleTimeoutsMs.worker / 1_000,
									})}
									value={values.subagentRoleTimeoutsMs[role] / 1_000}
									min={timeoutLimits.min / 1_000}
									max={timeoutLimits.max / 1_000}
									step={0.001}
									error={errorFor(`agents-timeout-${role}`)}
									onChange={(rawValue) =>
										setCachedStateField("subagentRoleTimeoutsMs", {
											...values.subagentRoleTimeoutsMs,
											[role]: parseManagedAgentTimeoutSeconds(rawValue),
										})
									}
								/>
							))}
						</fieldset>
						{(["input", "output"] as const).map((direction) => {
							const field = direction === "input" ? "subagentMaxInputTokens" : "subagentMaxOutputTokens"
							return (
								<NumberSetting
									key={direction}
									settingId={`agents-${direction}-tokens`}
									label={t(`agents:${direction}Tokens.label`)}
									description={t(`agents:${direction}Tokens.description`, {
										...childTokenLimits,
										default: DEFAULT_MANAGED_AGENT_SETTINGS[field],
									})}
									value={values[field]}
									{...childTokenLimits}
									error={errorFor(`agents-${direction}-tokens`)}
									onChange={(rawValue) =>
										setCachedStateField(field, parseManagedAgentNumericInput(rawValue))
									}
								/>
							)
						})}
						<NumberSetting
							settingId="agents-root-tokens"
							label={t("agents:rootTokens.label")}
							description={t("agents:rootTokens.description", MANAGED_AGENT_SETTING_LIMITS.rootTokens)}
							value={values.subagentRootTokenBudget}
							{...MANAGED_AGENT_SETTING_LIMITS.rootTokens}
							placeholder={t("agents:rootTokens.placeholder")}
							error={errorFor("agents-root-tokens")}
							onChange={(rawValue, badInput) =>
								setCachedStateField(
									"subagentRootTokenBudget",
									parseOptionalManagedAgentNumericInput(rawValue, badInput),
								)
							}
						/>
						<NumberSetting
							settingId="agents-root-cost"
							label={t("agents:rootCost.label")}
							description={t("agents:rootCost.description")}
							value={values.subagentRootCostBudget}
							min={0}
							step="any"
							placeholder={t("agents:rootCost.placeholder")}
							error={errorFor("agents-root-cost")}
							onChange={(rawValue, badInput) =>
								setCachedStateField(
									"subagentRootCostBudget",
									parseOptionalManagedAgentNumericInput(rawValue, badInput),
								)
							}
						/>
						<p className="text-vscode-descriptionForeground text-sm m-0">{t("agents:budgetTiming")}</p>
						<fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
							<legend className="font-medium mb-2">{t("agents:roleProfiles.title")}</legend>
							<p className="text-vscode-descriptionForeground text-sm m-0">
								{t("agents:roleProfiles.description")}
							</p>
							{MANAGED_AGENT_ROLES.map((role) => (
								<SearchableSetting
									key={role}
									settingId={`agents-profile-${role}`}
									section="agents"
									label={t("agents:roleProfiles.label", { role: t(`agents:roles.${role}`) })}>
									<ProfileSelect
										id={`agents-profile-${role}`}
										label={t("agents:roleProfiles.label", { role: t(`agents:roles.${role}`) })}
										value={values.subagentApiConfigByRole?.[role]}
										inheritLabel={t("agents:roleProfiles.inherit")}
										profiles={listApiConfigMeta}
										onChange={(profileId) => {
											const next = { ...values.subagentApiConfigByRole }
											if (profileId) next[role] = profileId
											else delete next[role]
											setCachedStateField("subagentApiConfigByRole", next)
										}}
									/>
								</SearchableSetting>
							))}
						</fieldset>
						<SearchableSetting settingId="agents-types" section="agents" label={t("agents:types.title")}>
							<div className="flex flex-col gap-4">
								<h4 className="font-medium m-0">{t("agents:types.title")}</h4>
								<p className="text-vscode-descriptionForeground text-sm m-0">
									{t("agents:types.description")}
								</p>
								{errorFor("agents-types") && (
									<p
										id="agents-types-error"
										role="alert"
										className="text-vscode-errorForeground text-sm m-0">
										{errorFor("agents-types")}
									</p>
								)}
								{Object.entries(types).map(([name, definition]) => (
									<fieldset
										key={name}
										className="border border-vscode-input-border rounded p-3 flex flex-col gap-3 min-w-0">
										<legend className="font-medium px-1">{name}</legend>
										<label htmlFor={`agents-type-${name}-description`}>
											{t("agents:types.descriptionLabel", { name })}
										</label>
										<textarea
											id={`agents-type-${name}-description`}
											className={`${inputClassName} w-full resize-y min-h-16`}
											value={definition.description}
											aria-invalid={!!errorFor("agents-types")}
											aria-describedby={
												errorFor("agents-types") ? "agents-types-error" : undefined
											}
											onChange={(event) => updateType(name, { description: event.target.value })}
										/>
										<label htmlFor={`agents-type-${name}-role`}>
											{t("agents:types.roleLabel", { name })}
										</label>
										<select
											id={`agents-type-${name}-role`}
											className={`${inputClassName} w-full`}
											value={definition.role ?? "default"}
											onChange={(event) => {
												const role = event.target.value
												if (
													role === "default" ||
													role === "explore" ||
													role === "review" ||
													role === "worker"
												) {
													updateType(name, { role })
												}
											}}>
											{(["default", ...MANAGED_AGENT_ROLES] as const).map((role) => (
												<option key={role} value={role}>
													{t(`agents:roles.${role}`)}
												</option>
											))}
										</select>
										<ProfileSelect
											id={`agents-type-${name}-profile`}
											label={t("agents:types.profileLabel", { name })}
											value={definition.apiConfigId}
											inheritLabel={t("agents:types.inherit")}
											profiles={listApiConfigMeta}
											onChange={(profileId) => updateType(name, { apiConfigId: profileId })}
										/>
										{definition.model && (
											<p className="text-vscode-descriptionForeground text-sm m-0">
												{t("agents:types.modelOverride", { model: definition.model })}
											</p>
										)}
										{definition.reasoningEffort && (
											<p className="text-vscode-descriptionForeground text-sm m-0">
												{t("agents:types.reasoningOverride", {
													effort: definition.reasoningEffort,
												})}
											</p>
										)}
										{definition.developerInstructions && (
											<p className="text-vscode-descriptionForeground text-sm m-0">
												{t("agents:types.instructionsOverride")}
											</p>
										)}
										<Button
											type="button"
											variant="secondary"
											onClick={() => {
												const next = { ...types }
												delete next[name]
												setCachedStateField("subagentAgentTypes", next)
											}}>
											{t("agents:types.remove", { name })}
										</Button>
									</fieldset>
								))}
								{Object.keys(types).length === 0 && (
									<p className="text-vscode-descriptionForeground text-sm m-0">
										{t("agents:types.empty")}
									</p>
								)}
								<label htmlFor="agents-new-type-name">{t("agents:types.name")}</label>
								<input
									id="agents-new-type-name"
									className={`${inputClassName} w-full`}
									value={newTypeName}
									aria-describedby="agents-new-type-name-hint"
									onChange={(event) => setNewTypeName(event.target.value)}
								/>
								<p
									id="agents-new-type-name-hint"
									className="text-vscode-descriptionForeground text-sm m-0">
									{t("agents:types.nameHint")}
								</p>
								<label htmlFor="agents-new-type-description">{t("agents:types.newDescription")}</label>
								<textarea
									id="agents-new-type-description"
									className={`${inputClassName} w-full resize-y min-h-16`}
									value={newTypeDescription}
									onChange={(event) => setNewTypeDescription(event.target.value)}
								/>
								{showNewTypeError && (
									<p role="alert" className="text-vscode-errorForeground text-sm m-0">
										{t("agents:validation.newType")}
									</p>
								)}
								<Button
									type="button"
									variant="secondary"
									onClick={addType}
									disabled={Object.keys(types).length >= 24}>
									{t("agents:types.add")}
								</Button>
							</div>
						</SearchableSetting>
					</div>
				</details>
			</Section>
		</div>
	)
}
