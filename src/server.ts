import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { OrderingAgentRuntime } from "./agent.ts"
import { createLlmAdapter } from "./llm/providers.ts"

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)))
const PORT = Number(process.env.PORT || 3000)
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS_PER_TURN || 25)
const MAX_TOKENS = Number(process.env.MAX_TOKENS_PER_SESSION || 100000)

const llmAdapter = createLlmAdapter()
export const agentRuntime = new OrderingAgentRuntime({
  directory: ROOT_DIR,
  adapter: llmAdapter,
  maxIterationsPerTurn: MAX_ITERATIONS,
  maxTokensPerSession: MAX_TOKENS,
})

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  })
}

function loadCasesSummary() {
  const solicitudesDir = join(ROOT_DIR, "fixtures", "reto-03", "solicitudes")
  if (!existsSync(solicitudesDir)) return []

  const folders = readdirSync(solicitudesDir)
    .filter((f) => statSync(join(solicitudesDir, f)).isDirectory())
    .sort()

  return folders.map((id) => {
    const solPath = join(solicitudesDir, id, "solicitud.json")
    const factPath = join(solicitudesDir, id, "factura.txt")
    let sol: Record<string, unknown> = {}
    if (existsSync(solPath)) {
      try {
        sol = JSON.parse(readFileSync(solPath, "utf-8")) as Record<string, unknown>
      } catch {
        sol = {}
      }
    }
    return {
      id,
      solicitud_id: String(sol.solicitud_id || id),
      solicitante: String(sol.solicitante || ""),
      proveedor: String(sol.proveedor_nombre || ""),
      proveedor_nit: sol.proveedor_nit ? String(sol.proveedor_nit) : null,
      descripcion: String(sol.descripcion || ""),
      centro_costo: String(sol.centro_costo || ""),
      subarea: String(sol.subarea || ""),
      monto: Number(sol.valor_total || 0),
      moneda: String(sol.moneda || "COP"),
      tiene_factura: existsSync(factPath),
    }
  })
}

function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ""
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

function loadControlAndOrders() {
  const controlPath = join(ROOT_DIR, "out", "control.csv")
  const ordenesPath = join(ROOT_DIR, "out", "sap", "ordenes.jsonl")

  let rawCsv = ""
  const controlRows: Array<Record<string, string>> = []
  if (existsSync(controlPath)) {
    rawCsv = readFileSync(controlPath, "utf-8")
    const lines = rawCsv
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    if (lines.length > 1) {
      const headers = parseCsvLine(lines[0] || "")
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i] || "")
        const row: Record<string, string> = {}
        headers.forEach((h, idx) => {
          row[h] = cols[idx] ?? ""
        })
        controlRows.push(row)
      }
    }
  }

  const ordenes: Array<Record<string, unknown>> = []
  if (existsSync(ordenesPath)) {
    const lines = readFileSync(ordenesPath, "utf-8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    for (const line of lines) {
      try {
        ordenes.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // Ignore malformed line
      }
    }
  }

  return { rawCsv, controlRows, ordenes }
}

function serveStaticFile(baseDir: string, relativePath: string): Response {
  const safeRel = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "")
  const fullPath = resolve(baseDir, safeRel)
  if (!fullPath.startsWith(resolve(baseDir))) {
    return jsonResponse({ ok: false, error: "Ruta no permitida" }, 403)
  }
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    return jsonResponse({ ok: false, error: "Archivo no encontrado" }, 404)
  }
  const ext = extname(fullPath).toLowerCase()
  const contentType = MIME_TYPES[ext] || "application/octet-stream"
  const bytes = readFileSync(fullPath)
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    },
  })
}

export async function handleHttpRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    })
  }

  // 1. GET /api/health (Sección 6.4 PRD — nunca expone claves)
  if (req.method === "GET" && pathname === "/api/health") {
    return jsonResponse({
      ok: true,
      provider: llmAdapter.provider,
      model: llmAdapter.model,
      maxIterations: MAX_ITERATIONS,
      maxTokens: MAX_TOKENS,
    })
  }

  // 2. GET /api/cases (Casos de prueba para el panel de la UI)
  if (req.method === "GET" && pathname === "/api/cases") {
    return jsonResponse({
      ok: true,
      cases: loadCasesSummary(),
    })
  }

  // 3. GET /api/control (Estado en vivo de out/control.csv y out/sap/ordenes.jsonl)
  if (req.method === "GET" && pathname === "/api/control") {
    return jsonResponse({
      ok: true,
      ...loadControlAndOrders(),
    })
  }

  // 4. POST /api/chat (Sección 6.4 PRD)
  if (req.method === "POST" && pathname === "/api/chat") {
    let body: { sessionId?: string; message?: string } = {}
    try {
      body = (await req.json()) as { sessionId?: string; message?: string }
    } catch {
      return jsonResponse({ ok: false, error: "Cuerpo JSON inválido en la petición." }, 400)
    }

    const sessionId = (body.sessionId || "default-session").trim()
    const message = (body.message || "").trim()

    if (!message) {
      return jsonResponse({ ok: false, error: "El campo 'message' es obligatorio." }, 400)
    }

    const turnResult = await agentRuntime.runTurn(sessionId, message)
    return jsonResponse(turnResult, 200)
  }

  // 5. GET /api/sessions/:id y POST /api/sessions/:id/reset (Sección 6.4 PRD)
  if (pathname.startsWith("/api/sessions/")) {
    const parts = pathname.replace("/api/sessions/", "").split("/").filter(Boolean)
    const sessionId = decodeURIComponent(parts[0] || "default-session")
    const action = parts[1]

    if (req.method === "POST" && action === "reset") {
      const session = agentRuntime.resetSession(sessionId)
      return jsonResponse({
        ok: true,
        session: {
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: session.history,
          toolCalls: session.allToolCalls,
          needsConfirmation: session.needsConfirmation,
          pendingCase: session.pendingCase,
          tokenUsage: session.tokenUsage,
        },
      })
    }

    if (req.method === "GET" && !action) {
      const session = agentRuntime.getOrCreateSession(sessionId)
      return jsonResponse({
        ok: true,
        session: {
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messages: session.history,
          toolCalls: session.allToolCalls,
          needsConfirmation: session.needsConfirmation,
          pendingCase: session.pendingCase,
          tokenUsage: session.tokenUsage,
        },
      })
    }
  }

  // 6. Archivos generados en out/ (evidencia PDF/TXT, trazabilidad JSON, control CSV)
  if (req.method === "GET" && pathname.startsWith("/out/")) {
    const relOut = decodeURIComponent(pathname.slice("/out/".length))
    return serveStaticFile(join(ROOT_DIR, "out"), relOut)
  }

  // 7. Archivos estáticos del Front Web (web/)
  if (req.method === "GET") {
    const webDir = join(ROOT_DIR, "web")
    if (pathname === "/" || pathname === "/index.html") {
      return serveStaticFile(webDir, "index.html")
    }
    const relWeb = decodeURIComponent(pathname.slice(1))
    return serveStaticFile(webDir, relWeb)
  }

  return jsonResponse({ ok: false, error: `Ruta no encontrada: ${req.method} ${pathname}` }, 404)
}

if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    fetch: handleHttpRequest,
  })

  console.log("═══════════════════════════════════════════════════════════════════")
  console.log(" 🚀 Agente Conversacional — Órdenes de Compra SAP (Reto 03)")
  console.log(` 🌐 Interfaz Web & API: http://localhost:${server.port}`)
  console.log(` 🤖 Proveedor LLM:      ${llmAdapter.provider} (${llmAdapter.model})`)
  console.log(` 🛡️  Tope Iteraciones:   ${MAX_ITERATIONS} por turno | Tokens: ${MAX_TOKENS}`)
  console.log("═══════════════════════════════════════════════════════════════════")
}
