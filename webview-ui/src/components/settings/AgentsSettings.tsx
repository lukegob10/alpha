import { useState, type HTMLAttributes } from "react"
import {
	DEFAULT_MAX_CONCURRENT_TASKS,
	reasoningEffortsExtended,
	reasoningEffortExtendedSchema,
	subagentAgentTypeDefinitionSchema,
	subagentSpawnAgentTypeSchema,
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
import { getManagedAgentSettingsIssues, parseManagedAgentNumericInput } from "./agents-settings-validation"

const inputClassName =
	"max-w-full rounded bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border px-2 py-1 focus-visible:outline focus-visible:outline-vscode-focusBorder"

interface AgentsSettingsProps extends HTMLAttributes<HTMLDivElement> {
	values: SettingsCachedState
	setCachedStateField: SetSettingsCachedStateField
}

export function AgentsSettings({ values, setCachedStateField, ...props }: AgentsSettingsProps) {
	const { t } = useAppTranslation()
	const [newTypeName, setNewTypeName] = useState("")
	const [newTypeDescription, setNewTypeDescription] = useState("")
	const [showNewTypeError, setShowNewTypeError] = useState(false)
	const issues = getManagedAgentSettingsIssues(values)
	const errorFor = (id: string) => {
		const issue = issues.find((candidate) => candidate.settingId === id)
		return issue ? t(issue.translationKey) : undefined
	}
	const types = values.subagentAgentTypes ?? {}
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
	return (
		<div {...props}>
			<SectionHeader description={t("agents:description")}>{t("agents:title")}</SectionHeader>
			<Section>
				<p className="text-vscode-descriptionForeground text-sm m-0">{t("agents:timing")}</p>
				<SearchableSetting settingId="agents-enabled" section="agents" label={t("agents:enabled.label")}>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={values.subagentsEnabled}
							onChange={(event) => setCachedStateField("subagentsEnabled", event.target.checked)}
						/>
						{t("agents:enabled.label")}
					</label>
					<p className="text-vscode-descriptionForeground text-sm">{t("agents:enabled.description")}</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-concurrency"
					section="agents"
					label={t("agents:concurrency.label")}>
					<label htmlFor="agents-concurrency">{t("agents:concurrency.label")}</label>
					<input
						id="agents-concurrency"
						data-testid="agents-concurrency"
						className={inputClassName}
						type="number"
						step={1}
						{...MANAGED_AGENT_SETTING_LIMITS.maxConcurrentSubagents}
						value={Number.isFinite(values.maxConcurrentSubagents) ? values.maxConcurrentSubagents : ""}
						aria-invalid={!!errorFor("agents-concurrency")}
						aria-describedby="agents-concurrency-description agents-concurrency-error"
						onChange={(event) =>
							setCachedStateField(
								"maxConcurrentSubagents",
								parseManagedAgentNumericInput(event.target.value),
							)
						}
					/>
					<p id="agents-concurrency-description" className="text-vscode-descriptionForeground text-sm">
						{t("agents:concurrency.description", {
							default: DEFAULT_MANAGED_AGENT_SETTINGS.maxConcurrentSubagents,
						})}
					</p>
					<p id="agents-concurrency-error" role={errorFor("agents-concurrency") ? "alert" : undefined}>
						{errorFor("agents-concurrency")}
					</p>
					<p data-testid="agents-task-capacity" className="text-vscode-descriptionForeground text-sm">
						{t("agents:concurrency.taskCapacity", {
							capacity: values.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
						})}
					</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-default-model"
					section="agents"
					label={t("agents:defaultModel.label")}>
					<label htmlFor="agents-default-model">{t("agents:defaultModel.label")}</label>
					<input
						id="agents-default-model"
						data-testid="agents-default-model"
						className={inputClassName}
						value={values.subagentDefaultModel}
						placeholder={t("agents:inherit")}
						aria-invalid={!!errorFor("agents-default-model")}
						onChange={(event) => setCachedStateField("subagentDefaultModel", event.target.value)}
					/>
					<p className="text-vscode-descriptionForeground text-sm">{t("agents:defaultModel.description")}</p>
					{errorFor("agents-default-model") && <p role="alert">{errorFor("agents-default-model")}</p>}
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-default-reasoning"
					section="agents"
					label={t("agents:defaultReasoning.label")}>
					<label htmlFor="agents-default-reasoning">{t("agents:defaultReasoning.label")}</label>
					<select
						id="agents-default-reasoning"
						data-testid="agents-default-reasoning"
						className={inputClassName}
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
					<p className="text-vscode-descriptionForeground text-sm">
						{t("agents:defaultReasoning.description")}
					</p>
				</SearchableSetting>
				<SearchableSetting
					settingId="agents-interrupt-message"
					section="agents"
					label={t("agents:interruptMessage.label")}>
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={values.subagentInterruptMessage}
							onChange={(event) => setCachedStateField("subagentInterruptMessage", event.target.checked)}
						/>
						{t("agents:interruptMessage.label")}
					</label>
					<p className="text-vscode-descriptionForeground text-sm">
						{t("agents:interruptMessage.description")}
					</p>
				</SearchableSetting>
				<SearchableSetting settingId="agents-types" section="agents" label={t("agents:types.title")}>
					<h4 className="font-medium">{t("agents:types.title")}</h4>
					<p className="text-vscode-descriptionForeground text-sm">{t("agents:types.description")}</p>
					{errorFor("agents-types") && (
						<p id="agents-types-error" role="alert">
							{errorFor("agents-types")}
						</p>
					)}
					{Object.entries(types).map(([name, definition]) => (
						<fieldset
							key={name}
							className="border border-vscode-input-border rounded p-3 flex flex-col gap-3 min-w-0">
							<legend>{name}</legend>
							<label htmlFor={name + "-description"}>
								{t("agents:types.descriptionLabel", { name })}
							</label>
							<textarea
								id={name + "-description"}
								className={inputClassName}
								value={definition.description}
								aria-invalid={!!errorFor("agents-types")}
								aria-describedby={errorFor("agents-types") ? "agents-types-error" : undefined}
								onChange={(event) => updateType(name, { description: event.target.value })}
							/>
							<label htmlFor={name + "-model"}>{t("agents:types.modelLabel", { name })}</label>
							<input
								id={name + "-model"}
								className={inputClassName}
								value={definition.model ?? ""}
								placeholder={t("agents:inherit")}
								onChange={(event) => updateType(name, { model: event.target.value || undefined })}
							/>
							<label htmlFor={name + "-reasoning"}>{t("agents:types.reasoningLabel", { name })}</label>
							<select
								id={name + "-reasoning"}
								className={inputClassName}
								value={definition.reasoningEffort ?? ""}
								onChange={(event) => {
									const effort = reasoningEffortExtendedSchema.safeParse(event.target.value)
									updateType(name, { reasoningEffort: effort.success ? effort.data : undefined })
								}}>
								{effortOptions}
							</select>
							<label htmlFor={name + "-instructions"}>
								{t("agents:types.instructionsLabel", { name })}
							</label>
							<textarea
								id={name + "-instructions"}
								className={inputClassName}
								value={definition.developerInstructions ?? ""}
								onChange={(event) => updateType(name, { developerInstructions: event.target.value })}
							/>
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
					{Object.keys(types).length === 0 && <p>{t("agents:types.empty")}</p>}
					<label htmlFor="agents-new-type-name">{t("agents:types.name")}</label>
					<input
						id="agents-new-type-name"
						className={inputClassName}
						value={newTypeName}
						aria-describedby="agents-new-type-name-hint"
						onChange={(event) => setNewTypeName(event.target.value)}
					/>
					<p id="agents-new-type-name-hint" className="text-vscode-descriptionForeground text-sm">
						{t("agents:types.nameHint")}
					</p>
					<label htmlFor="agents-new-type-description">{t("agents:types.newDescription")}</label>
					<textarea
						id="agents-new-type-description"
						className={inputClassName}
						value={newTypeDescription}
						onChange={(event) => setNewTypeDescription(event.target.value)}
					/>
					{showNewTypeError && <p role="alert">{t("agents:validation.newType")}</p>}
					<Button type="button" variant="secondary" onClick={addType}>
						{t("agents:types.add")}
					</Button>
				</SearchableSetting>
			</Section>
		</div>
	)
}
