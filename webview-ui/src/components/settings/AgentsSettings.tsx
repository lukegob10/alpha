import { AlertTriangle, Bot, Compass, Hammer, ShieldCheck } from "lucide-react"

import type { ProviderSettingsEntry } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import type { ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui"

import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import type { SetCachedStateField } from "./types"

interface AgentsSettingsProps {
	profiles: ProviderSettingsEntry[]
	defaultProfileId?: string
	profileByRole?: { explore?: string; review?: string; worker?: string }
	setCachedStateField: SetCachedStateField<keyof ExtensionStateContextType>
}

type Role = "explore" | "review" | "worker"

function profileLabel(profile: ProviderSettingsEntry): string {
	const provider = profile.apiProvider ?? "Unconfigured"
	const model = profile.modelId ?? "provider default"
	return `${profile.name} · ${provider} · ${model}`
}

export function AgentsSettings({
	profiles,
	defaultProfileId,
	profileByRole,
	setCachedStateField,
}: AgentsSettingsProps) {
	const { t } = useAppTranslation()
	const profileIds = new Set(profiles.map((profile) => profile.id))
	const defaultIsStale = Boolean(defaultProfileId && !profileIds.has(defaultProfileId))

	const setRoleProfile = (role: Role, profileId: string) => {
		const next = { ...profileByRole, [role]: profileId || undefined }
		setCachedStateField("subagentApiConfigByRole", next.explore || next.review || next.worker ? next : undefined)
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
				</div>
			</Section>
		</div>
	)
}
