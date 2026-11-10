import { useState, type HTMLAttributes } from "react"
import {
	DEFAULT_MAX_CONCURRENT_TASKS,
	MAX_MAX_CONCURRENT_TASKS,
	MIN_MAX_CONCURRENT_TASKS,
	reasoningEffortsExtended,
	reasoningEffortExtendedSchema,
	subagentAgentTypeDefinitionSchema,
	subagentSpawnAgentTypeSchema,
	type SubagentAgentTypeDefinition,
} from "@alpha-code/types"
import { Button } from "@/components/ui/button"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import {
	DEFAULT_MANAGED_AGENT_SETTINGS,
	MANAGED_AGENT_SETTING_LIMITS,
	type SettingsCachedState,
	type SetSettingsCachedStateField,
} from "./managed-agent-settings"
import { getManagedAgentSettingsIssues, parseManagedAgentNumericInput } from "./agents-settings-validation"

const inputClassName =
	"min-h-8 min-w-0 max-w-full self-start rounded bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 focus-visible:outline focus-visible:outline-vscode-focusBorder"
const fieldClassName = "flex min-w-0 flex-col gap-1"

interface AgentsSettingsProps extends HTMLAttributes<HTMLDivElement> {
	values: SettingsCachedState
	setCachedStateField: SetSettingsCachedStateField
	embedded?: boolean
}

export function AgentsSettings({ values, setCachedStateField, embedded = false, ...props }: AgentsSettingsProps) {
	const { t } = useAppTranslation()
	const [newTypeName, setNewTypeName] = useState("")
	const [newTypeDescription, setNewTypeDescription] = useState("")
	const [showNewTypeError, setShowNewTypeError] = useState(false)
	const [advancedOpen, setAdvancedOpen] = useState(false)
	const issues = getManagedAgentSettingsIssues(values)
	const hasAdvancedError = issues.some(
		({ settingId }) =>
			settingId === "agents-default-model" ||
			settingId === "agents-default-reasoning" ||
			settingId === "agents-types",
	)
	const totalCapacity = values.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS
	const availableChildCapacity =
		Number.isInteger(totalCapacity) && Number.isInteger(values.maxConcurrentSubagents)
			? Math.max(0, Math.min(values.maxConcurrentSubagents, totalCapacity - 1))
			: undefined
	const errorFor = (id: string) => {
		const issue = issues.find((candidate) => candidate.settingId === id)
		return issue ? t(issue.translationKey) : undefined
	}
	const types = values.subagentAgentTypes ?? {}
	const connectionFor = (definition: SubagentAgentTypeDefinition) => {
		if (!definition.apiConfigId) return t("agents:types.routeInherited")
		const profile = values.listApiConfigMeta?.find(({ id }) => id === definition.apiConfigId)
		if (!profile || profile.availability) {
			return t("agents:types.routeUnavailable", { id: definition.apiConfigId })
		}
		return t("agents:types.routeProfile", {
			profile: profile.apiProvider ? `${profile.name} (${profile.apiProvider})` : profile.name,
		})
	}
	const updateType = (name: string, update: Partial<SubagentAgentTypeDefinition>) =>
		setCachedStateField("subagentAgentTypes", { ...types, [name]: { ...types[name], ...update } })
	const addType = () => {
		const name = newTypeName.trim()
		const definition = subagentAgentTypeDefinitionSchema.safeParse({
			description: newTypeDescription,
			developerInstructions: "",
		})
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
	const effortOptions = (
		<>
			<option value="">{t("agents:inherit")}</option>
			{reasoningEffortsExtended.map((effort) => (
				<option key={effort} value={effort}>
					{effort}
				</option>
			))}
		</>
	)
	const agentsHelp = (
		<SettingsHelp label={t("agents:title")}>
			<p className="m-0">{t("agents:description")}</p>
			<p className="m-0">{t("agents:timing")}</p>
		</SettingsHelp>
	)
	return (
		<div {...props}>
			{!embedded && (
				<SectionHeader>
					<span className="inline-flex items-center gap-1">
						{t("agents:title")}
						{agentsHelp}
					</span>
				</SectionHeader>
			)}
			<Section>
				{embedded && (
					<div className="flex items-center gap-1">
						<h4 className="m-0 text-base font-semibold">{t("agents:title")}</h4>
						{agentsHelp}
					</div>
				)}
				<SearchableSetting
					settingId="agents-enabled"
					section="agents"
					label={t("agents:enabled.label")}
					className={fieldClassName}>
					<div className="flex items-center gap-1">
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={values.subagentsEnabled}
								onChange={(event) => setCachedStateField("subagentsEnabled", event.target.checked)}
							/>
							{t("agents:enabled.label")}
						</label>
						<SettingsHelp label={t("agents:enabled.label")}>{t("agents:enabled.description")}</SettingsHelp>
					</div>
				</SearchableSetting>
				<div className="grid min-w-0 gap-4 sm:grid-cols-2">
					<SearchableSetting
						settingId="agents-concurrency"
						section="agents"
						label={t("agents:concurrency.label")}
						className={fieldClassName}>
						<div className="flex items-center gap-1">
							<label htmlFor="agents-concurrency">{t("agents:concurrency.label")}</label>
							<SettingsHelp label={t("agents:concurrency.label")}>
								{t("agents:concurrency.description", {
									default: DEFAULT_MANAGED_AGENT_SETTINGS.maxConcurrentSubagents,
								})}
							</SettingsHelp>
						</div>
						<input
							id="agents-concurrency"
							data-testid="agents-concurrency"
							className={cn(inputClassName, "w-24")}
							type="number"
							step={1}
							{...MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents}
							value={Number.isFinite(values.maxConcurrentSubagents) ? values.maxConcurrentSubagents : ""}
							aria-invalid={!!errorFor("agents-concurrency")}
							aria-describedby={errorFor("agents-concurrency") ? "agents-concurrency-error" : undefined}
							onChange={(event) =>
								setCachedStateField(
									"maxConcurrentSubagents",
									parseManagedAgentNumericInput(event.target.value),
								)
							}
						/>
						<p
							id="agents-concurrency-error"
							className="m-0"
							hidden={!errorFor("agents-concurrency")}
							role={errorFor("agents-concurrency") ? "alert" : undefined}>
							{errorFor("agents-concurrency")}
						</p>
					</SearchableSetting>
					<SearchableSetting
						settingId="agents-total-capacity"
						section="agents"
						label={t("agents:totalCapacity.label")}
						className={fieldClassName}>
						<div className="flex items-center gap-1">
							<label htmlFor="agents-total-capacity">{t("agents:totalCapacity.label")}</label>
							<SettingsHelp label={t("agents:totalCapacity.label")}>
								<p className="m-0">{t("agents:totalCapacity.description")}</p>
								{availableChildCapacity !== undefined && (
									<p data-testid="agents-task-capacity" className="m-0">
										{t("agents:totalCapacity.available", { count: availableChildCapacity })}
									</p>
								)}
							</SettingsHelp>
						</div>
						<input
							id="agents-total-capacity"
							data-testid="agents-total-capacity"
							className={cn(inputClassName, "w-24")}
							type="number"
							step={1}
							min={MIN_MAX_CONCURRENT_TASKS}
							max={MAX_MAX_CONCURRENT_TASKS}
							value={Number.isFinite(totalCapacity) ? totalCapacity : ""}
							aria-invalid={!!errorFor("agents-total-capacity")}
							aria-describedby={
								errorFor("agents-total-capacity") ? "agents-total-capacity-error" : undefined
							}
							onChange={(event) =>
								setCachedStateField(
									"maxConcurrentTasks",
									parseManagedAgentNumericInput(event.target.value),
								)
							}
						/>
						<p
							id="agents-total-capacity-error"
							className="m-0"
							hidden={!errorFor("agents-total-capacity")}
							role={errorFor("agents-total-capacity") ? "alert" : undefined}>
							{errorFor("agents-total-capacity")}
						</p>
					</SearchableSetting>
				</div>
				<details
					data-agents-advanced
					open={advancedOpen || hasAdvancedError}
					onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
					<summary className="cursor-pointer font-medium">{t("agents:advanced.title")}</summary>
					<div className="flex min-w-0 flex-col gap-4 pt-4">
						<SearchableSetting
							settingId="agents-default-model"
							section="agents"
							label={t("agents:defaultModel.label")}
							className={fieldClassName}>
							<div className="flex items-center gap-1">
								<label htmlFor="agents-default-model">{t("agents:defaultModel.label")}</label>
								<SettingsHelp label={t("agents:defaultModel.label")}>
									<p className="m-0">{t("agents:advanced.description")}</p>
									<p className="m-0">{t("agents:defaultModel.description")}</p>
								</SettingsHelp>
							</div>
							<input
								id="agents-default-model"
								data-testid="agents-default-model"
								className={cn(inputClassName, "w-full max-w-sm")}
								value={values.subagentDefaultModel}
								placeholder={t("agents:inherit")}
								aria-invalid={!!errorFor("agents-default-model")}
								onChange={(event) => setCachedStateField("subagentDefaultModel", event.target.value)}
							/>
							{errorFor("agents-default-model") && (
								<p className="m-0" role="alert">
									{errorFor("agents-default-model")}
								</p>
							)}
						</SearchableSetting>
						<SearchableSetting
							settingId="agents-default-reasoning"
							section="agents"
							label={t("agents:defaultReasoning.label")}
							className={fieldClassName}>
							<div className="flex items-center gap-1">
								<label htmlFor="agents-default-reasoning">{t("agents:defaultReasoning.label")}</label>
								<SettingsHelp label={t("agents:defaultReasoning.label")}>
									{t("agents:defaultReasoning.description")}
								</SettingsHelp>
							</div>
							<select
								id="agents-default-reasoning"
								data-testid="agents-default-reasoning"
								className={cn(inputClassName, "w-48")}
								value={values.subagentDefaultReasoningEffort ?? ""}
								onChange={(event) => {
									const effort = reasoningEffortExtendedSchema.safeParse(event.target.value)
									setCachedStateField(
										"subagentDefaultReasoningEffort",
										effort.success ? effort.data : undefined,
									)
								}}>
								{effortOptions}
							</select>
						</SearchableSetting>
						<SearchableSetting
							settingId="agents-types"
							section="agents"
							label={t("agents:types.title")}
							className="flex min-w-0 flex-col gap-4">
							<div className="flex items-center gap-1">
								<h4 className="font-medium m-0">{t("agents:types.title")}</h4>
								<SettingsHelp label={t("agents:types.title")}>
									{t("agents:types.description")}
								</SettingsHelp>
							</div>
							{errorFor("agents-types") && (
								<p id="agents-types-error" className="m-0" role="alert">
									{errorFor("agents-types")}
								</p>
							)}
							{Object.entries(types).map(([name, definition]) => (
								<fieldset
									key={name}
									className="border border-vscode-input-border rounded p-3 flex flex-col gap-4 min-w-0">
									<legend>
										<span className="inline-flex items-center gap-1">
											{name}
											<SettingsHelp label={t("agents:types.detailsLabel", { name })}>
												<dl className="m-0 grid min-w-0 gap-1">
													<dt className="font-medium">
														{t("agents:types.routeLabel", { name })}
													</dt>
													<dd className="m-0 break-words" data-testid={name + "-connection"}>
														{connectionFor(definition)}
													</dd>
													<dt className="font-medium">
														{t("agents:types.roleLabel", { name })}
													</dt>
													<dd className="m-0" data-testid={name + "-role"}>
														{definition.role ?? t("agents:types.roleInherited")}
													</dd>
													<dt className="font-medium">
														{t("agents:types.sourceLabel", { name })}
													</dt>
													<dd className="m-0">{t("agents:types.sourceSettings")}</dd>
												</dl>
											</SettingsHelp>
										</span>
									</legend>
									<div className={fieldClassName}>
										<label htmlFor={name + "-description"}>
											{t("agents:types.descriptionLabel", { name })}
										</label>
										<textarea
											id={name + "-description"}
											className={cn(inputClassName, "w-full resize-y")}
											value={definition.description}
											aria-invalid={!!errorFor("agents-types")}
											aria-describedby={
												errorFor("agents-types") ? "agents-types-error" : undefined
											}
											onChange={(event) => updateType(name, { description: event.target.value })}
										/>
									</div>
									<div className={fieldClassName}>
										<label htmlFor={name + "-model"}>
											{t("agents:types.modelLabel", { name })}
										</label>
										<input
											id={name + "-model"}
											className={cn(inputClassName, "w-full max-w-sm")}
											value={definition.model ?? ""}
											placeholder={t("agents:inherit")}
											onChange={(event) =>
												updateType(name, { model: event.target.value || undefined })
											}
										/>
									</div>
									<div className={fieldClassName}>
										<label htmlFor={name + "-reasoning"}>
											{t("agents:types.reasoningLabel", { name })}
										</label>
										<select
											id={name + "-reasoning"}
											className={cn(inputClassName, "w-48")}
											value={definition.reasoningEffort ?? ""}
											onChange={(event) => {
												const effort = reasoningEffortExtendedSchema.safeParse(
													event.target.value,
												)
												updateType(name, {
													reasoningEffort: effort.success ? effort.data : undefined,
												})
											}}>
											{effortOptions}
										</select>
									</div>
									<div className={fieldClassName}>
										<label htmlFor={name + "-instructions"}>
											{t("agents:types.instructionsLabel", { name })}
										</label>
										<textarea
											id={name + "-instructions"}
											className={cn(inputClassName, "w-full resize-y")}
											value={definition.developerInstructions ?? ""}
											onChange={(event) =>
												updateType(name, { developerInstructions: event.target.value })
											}
										/>
									</div>
									<Button
										type="button"
										variant="secondary"
										size="sm"
										className="self-start"
										onClick={() => {
											const next = { ...types }
											delete next[name]
											setCachedStateField("subagentAgentTypes", next)
										}}>
										{t("agents:types.remove", { name })}
									</Button>
								</fieldset>
							))}
							{Object.keys(types).length === 0 && <p className="m-0">{t("agents:types.empty")}</p>}
							<div className={fieldClassName}>
								<div className="flex items-center gap-1">
									<label htmlFor="agents-new-type-name">{t("agents:types.name")}</label>
									<SettingsHelp label={t("agents:types.name")}>
										{t("agents:types.nameHint")}
									</SettingsHelp>
								</div>
								<input
									id="agents-new-type-name"
									className={cn(inputClassName, "w-full max-w-xs")}
									value={newTypeName}
									onChange={(event) => setNewTypeName(event.target.value)}
								/>
							</div>
							<div className={fieldClassName}>
								<label htmlFor="agents-new-type-description">{t("agents:types.newDescription")}</label>
								<textarea
									id="agents-new-type-description"
									className={cn(inputClassName, "w-full resize-y")}
									value={newTypeDescription}
									onChange={(event) => setNewTypeDescription(event.target.value)}
								/>
							</div>
							{showNewTypeError && (
								<p className="m-0" role="alert">
									{t("agents:validation.newType")}
								</p>
							)}
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="self-start"
								onClick={addType}>
								{t("agents:types.add")}
							</Button>
						</SearchableSetting>
					</div>
				</details>
			</Section>
		</div>
	)
}
