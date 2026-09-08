import { lazy, Suspense } from "react"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App"
import "@vscode/codicons/dist/codicon.css"

const Tickets = lazy(() => import("./components/tickets/TicketsView"))

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{document.getElementById("root")?.dataset.view === "tickets" ? (
			<Suspense fallback={null}>
				<Tickets />
			</Suspense>
		) : (
			<App />
		)}
	</StrictMode>,
)
