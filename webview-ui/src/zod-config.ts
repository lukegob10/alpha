import { z } from "zod"

// Load before shared schemas: VS Code's CSP also reports caught dynamic-code probes as violations.
z.config({ jitless: true })
