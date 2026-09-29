import { useCallback, useEffect, useState } from "react"
import { Activity, AlertTriangle, Clock3, RefreshCw } from "lucide-react"
import {
	incidentDashboardUpdateMessageSchema,
	type IncidentDashboardEvidenceStatus,
	type IncidentDashboardSnapshot,
} from "@alpha-code/types"
import { useTranslation } from "react-i18next"
import { vscode } from "../../utils/vscode"
import "./incidents.css"

const timestampFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function formatTimestamp(timestamp: number) {
	const date = new Date(timestamp)
	return Number.isFinite(date.getTime()) ? timestampFormatter.format(date) : undefined
}

export default function IncidentsView() {
	const { t } = useTranslation("incidents")
	const [snapshot, setSnapshot] = useState<IncidentDashboardSnapshot>()
	const [loading, setLoading] = useState(true)
	const [invalidSnapshot, setInvalidSnapshot] = useState(false)

	const requestSnapshot = useCallback(() => {
		setLoading(true)
		setInvalidSnapshot(false)
		vscode.postMessage({ type: "incidentDashboardReady" })
	}, [])
	const evidenceStatusLabel = (status?: IncidentDashboardEvidenceStatus) =>
		status ? t(`evidenceStatus.${status}`) : t("evidenceStatus.notChecked")

	useEffect(() => {
		const receive = (event: MessageEvent<unknown>) => {
			if (
				typeof event.data !== "object" ||
				event.data === null ||
				!("type" in event.data) ||
				event.data.type !== "incidentDashboardUpdate"
			)
				return

			const result = incidentDashboardUpdateMessageSchema.safeParse(event.data)
			if (!result.success) {
				setSnapshot(undefined)
				setInvalidSnapshot(true)
				setLoading(false)
				return
			}

			setSnapshot(result.data.snapshot)
			setInvalidSnapshot(false)
			setLoading(false)
		}

		window.addEventListener("message", receive)
		requestSnapshot()
		return () => window.removeEventListener("message", receive)
	}, [requestSnapshot])

	return (
		<main className="incident-dashboard">
			<div className="incident-dashboard-content">
				<header className="incident-dashboard-header">
					<div>
						<p className="incident-dashboard-eyebrow">{t("debugMode")}</p>
						<h1>{t("title")}</h1>
						<p className="incident-dashboard-description">{t("description")}</p>
					</div>
					<button className="incident-refresh-button" type="button" onClick={requestSnapshot}>
						<RefreshCw size={15} aria-hidden="true" />
						{t("refresh")}
					</button>
				</header>

				{loading ? (
					<p className="incident-dashboard-message" role="status">
						{t("loading")}
					</p>
				) : invalidSnapshot || !snapshot ? (
					<section className="incident-dashboard-message" role="alert">
						<p>{t("unavailable")}</p>
						<button className="incident-secondary-button" type="button" onClick={requestSnapshot}>
							{t("tryAgain")}
						</button>
					</section>
				) : (
					<div className="incident-dashboard-grid">
						<section className="incident-panel" aria-labelledby="incident-alerts-heading">
							<div className="incident-panel-heading">
								<div>
									<p className="incident-dashboard-eyebrow">{t("attention")}</p>
									<h2 id="incident-alerts-heading">{t("alerts")}</h2>
								</div>
								<span
									className="incident-count"
									aria-label={t("alertCount", { count: snapshot.alerts.length })}>
									{snapshot.alerts.length}
								</span>
							</div>
							{snapshot.alerts.length === 0 ? (
								<p className="incident-empty-state">{t("noAlerts")}</p>
							) : (
								<ul className="incident-alert-list">
									{snapshot.alerts.map((alert) => (
										<li
											className={`incident-alert incident-alert--${alert.severity}`}
											key={alert.id}>
											<div className="incident-alert-icon" aria-hidden="true">
												<AlertTriangle size={17} />
											</div>
											<div className="incident-alert-content">
												<p className="incident-alert-severity">
													{t(`severity.${alert.severity}`)}
												</p>
												<h3>{alert.title}</h3>
												<p className="incident-alert-summary">{alert.summary}</p>
												<div className="incident-alert-details">
													<p>
														<strong>{t("affectedTask")}:</strong>{" "}
														{snapshot.tasks.find((task) => task.taskId === alert.taskId)
															?.label ?? t("taskUnavailable")}
													</p>
													<p>
														<strong>{t("errorStatusLabel")}:</strong>{" "}
														{t(`errorStatus.${alert.errorStatus}`)}
													</p>
													<p>{evidenceStatusLabel(alert.evidenceStatus)}</p>
												</div>
												{alert.turnIdSha256 && (
													<p className="incident-alert-reference">
														{t("turnId")}{" "}
														<code title={alert.turnIdSha256}>
															{alert.turnIdSha256.slice(0, 12)}
														</code>
													</p>
												)}
												{alert.toolName && (
													<p className="incident-alert-reference">
														{t("affectedTool")}: <code>{alert.toolName}</code>
													</p>
												)}
												{alert.toolCallIdSha256 && (
													<p className="incident-alert-reference">
														{t("toolCallId")}{" "}
														<code title={alert.toolCallIdSha256}>
															{alert.toolCallIdSha256.slice(0, 12)}
														</code>
													</p>
												)}
												<time dateTime={new Date(alert.at).toISOString()}>
													{formatTimestamp(alert.at)}
												</time>
												<button
													className="incident-debug-button"
													aria-label={t("startDebuggingTaskFor", { title: alert.title })}
													type="button"
													onClick={() =>
														vscode.postMessage({
															type: "startDebuggingTask",
															alertId: alert.id,
														})
													}>
													<Activity size={15} aria-hidden="true" />
													{t("startDebuggingTask")}
												</button>
											</div>
										</li>
									))}
								</ul>
							)}
						</section>

						<section className="incident-panel" aria-labelledby="incident-activity-heading">
							<div className="incident-panel-heading">
								<div>
									<p className="incident-dashboard-eyebrow">{t("recent")}</p>
									<h2 id="incident-activity-heading">{t("activity")}</h2>
								</div>
							</div>
							{snapshot.tasks.length === 0 ? (
								<p className="incident-empty-state">{t("noActivity")}</p>
							) : (
								<ul className="incident-task-list">
									{snapshot.tasks.map((task) => (
										<li className="incident-task" key={task.taskId}>
											<div className="incident-task-heading">
												<h3>{task.label}</h3>
												<span
													className={`incident-task-state incident-task-state--${task.state}`}>
													{t(`state.${task.state}`)}
												</span>
											</div>
											<p className="incident-task-updated">
												<Clock3 size={13} aria-hidden="true" />
												{t("updated", {
													time: formatTimestamp(task.updatedAt) ?? t("unknownTime"),
												})}
											</p>
											<p className="incident-task-evidence">
												{evidenceStatusLabel(task.evidenceStatus)}
											</p>
											{task.timeline.length > 0 ? (
												<ol className="incident-timeline">
													{task.timeline.map((event) => (
														<li className="incident-timeline-item" key={event.id}>
															<span className="incident-timeline-kind">
																{t(`event.${event.kind}`)}
															</span>
															<span className="incident-timeline-label">
																{event.label}
															</span>
															<time dateTime={new Date(event.at).toISOString()}>
																{formatTimestamp(event.at)}
															</time>
														</li>
													))}
												</ol>
											) : (
												<p className="incident-empty-timeline">{t("noTaskActivity")}</p>
											)}
										</li>
									))}
								</ul>
							)}
						</section>
					</div>
				)}
				{snapshot && !loading && (
					<p className="incident-dashboard-updated" aria-live="polite">
						{t("snapshotUpdated", { time: formatTimestamp(snapshot.generatedAt) ?? t("unknownTime") })}
					</p>
				)}
			</div>
		</main>
	)
}
