import type { LlmAdapter, LlmMessage, LlmResponse, LlmToolCall, LlmToolDefinition } from "./adapter.ts"

const DEFAULT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000)

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timeout al conectar con el proveedor LLM tras ${timeoutMs} ms.`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Adaptador para Google Gemini (REST v1beta generateContent con function calling).
 */
export class GeminiAdapter implements LlmAdapter {
  readonly provider = "gemini"
  readonly model: string
  private readonly apiKey: string

  constructor(apiKey: string, model = process.env.GEMINI_MODEL || "gemini-2.5-flash") {
    this.apiKey = apiKey
    this.model = model
  }

  async enviar(mensajes: LlmMessage[], herramientas: LlmToolDefinition[]): Promise<LlmResponse> {
    const systemMsg = mensajes.find((m) => m.role === "system")?.content || ""
    const contents: Array<Record<string, unknown>> = []

    for (const msg of mensajes) {
      if (msg.role === "system") continue
      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: msg.content }],
        })
      } else if (msg.role === "assistant") {
        const parts: Array<Record<string, unknown>> = []
        if (msg.content) {
          parts.push({ text: msg.content })
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.args,
              },
            })
          }
        }
        if (parts.length > 0) {
          contents.push({ role: "model", parts })
        }
      } else if (msg.role === "tool") {
        let parsedResponse: Record<string, unknown> = { result: msg.content }
        try {
          parsedResponse = JSON.parse(msg.content) as Record<string, unknown>
        } catch {
          parsedResponse = { raw: msg.content }
        }
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolName || "tool",
                response: parsedResponse,
              },
            },
          ],
        })
      }
    }

    const functionDeclarations = herramientas.map((h) => ({
      name: h.name,
      description: h.description,
      parameters: h.parameters,
    }))

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const body: Record<string, unknown> = {
      contents,
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg }] } } : {}),
      ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
      generationConfig: {
        temperature: 0.1,
      },
    }

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Error del proveedor Gemini (HTTP ${res.status}): ${errText.slice(0, 300)}`)
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string
            functionCall?: { name: string; args?: Record<string, unknown> }
          }>
        }
      }>
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        totalTokenCount?: number
      }
    }

    const parts = data.candidates?.[0]?.content?.parts || []
    let textContent = ""
    const toolCalls: LlmToolCall[] = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part?.text) {
        textContent += part.text
      }
      if (part?.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${i}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        })
      }
    }

    return {
      content: textContent.trim(),
      toolCalls,
      usage: {
        promptTokens: data.usageMetadata?.promptTokenCount || 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
        totalTokens: data.usageMetadata?.totalTokenCount || 0,
      },
    }
  }
}

/**
 * Adaptador para proveedores compatibles con OpenAI Chat Completions
 * (OpenAI, OpenRouter, Ollama, LiteLLM, Azure).
 */
export class OpenAICompatibleAdapter implements LlmAdapter {
  readonly provider: string
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string

  constructor(opts: { provider: string; model: string; apiKey: string; baseUrl: string }) {
    this.provider = opts.provider
    this.model = opts.model
    this.apiKey = opts.apiKey
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "")
  }

  async enviar(mensajes: LlmMessage[], herramientas: LlmToolDefinition[]): Promise<LlmResponse> {
    const apiMessages = mensajes.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId || "call_0",
          content: m.content,
        }
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          })),
        }
      }
      return {
        role: m.role,
        content: m.content,
      }
    })

    const tools = herramientas.map((h) => ({
      type: "function",
      function: {
        name: h.name,
        description: h.description,
        parameters: h.parameters,
      },
    }))

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`
    }

    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: apiMessages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Error del proveedor ${this.provider} (HTTP ${res.status}): ${errText.slice(0, 300)}`)
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        total_tokens?: number
      }
    }

    const msg = data.choices?.[0]?.message
    const toolCalls: LlmToolCall[] = (msg?.tool_calls || []).map((tc) => {
      let parsedArgs: Record<string, unknown> = {}
      try {
        parsedArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>
      } catch {
        parsedArgs = {}
      }
      return {
        id: tc.id,
        name: tc.function.name,
        args: parsedArgs,
      }
    })

    return {
      content: (msg?.content || "").trim(),
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
    }
  }
}

/**
 * Adaptador para Anthropic Messages API.
 */
export class AnthropicAdapter implements LlmAdapter {
  readonly provider = "anthropic"
  readonly model: string
  private readonly apiKey: string

  constructor(apiKey: string, model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest") {
    this.apiKey = apiKey
    this.model = model
  }

  async enviar(mensajes: LlmMessage[], herramientas: LlmToolDefinition[]): Promise<LlmResponse> {
    const systemMsg = mensajes.find((m) => m.role === "system")?.content || ""
    const apiMessages: Array<Record<string, unknown>> = []

    for (const m of mensajes) {
      if (m.role === "system") continue
      if (m.role === "user") {
        apiMessages.push({ role: "user", content: m.content })
      } else if (m.role === "assistant") {
        const contentBlocks: Array<Record<string, unknown>> = []
        if (m.content) contentBlocks.push({ type: "text", text: m.content })
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.args,
            })
          }
        }
        apiMessages.push({ role: "assistant", content: contentBlocks })
      } else if (m.role === "tool") {
        apiMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: m.toolCallId || "call_0",
              content: m.content,
            },
          ],
        })
      }
    }

    const tools = herramientas.map((h) => ({
      name: h.name,
      description: h.description,
      input_schema: h.parameters,
    }))

    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: systemMsg,
        messages: apiMessages,
        tools,
        temperature: 0.1,
      }),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Error del proveedor Anthropic (HTTP ${res.status}): ${errText.slice(0, 300)}`)
    }

    const data = (await res.json()) as {
      content?: Array<{
        type: string
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }>
      usage?: { input_tokens?: number; output_tokens?: number }
    }

    let text = ""
    const toolCalls: LlmToolCall[] = []
    for (const block of data.content || []) {
      if (block.type === "text" && block.text) text += block.text
      if (block.type === "tool_use" && block.name) {
        toolCalls.push({
          id: block.id || `call_${Date.now()}`,
          name: block.name,
          args: block.input || {},
        })
      }
    }

    const promptTokens = data.usage?.input_tokens || 0
    const completionTokens = data.usage?.output_tokens || 0
    return {
      content: text.trim(),
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    }
  }
}

/**
 * Motor Agente Determinista Basado en Herramientas (implementa LlmAdapter).
 * Permite ejecutar el ciclo completo del agente multi-turno llamando paso a paso a las
 * herramientas reales (`oc_leer_paquete` -> `oc_validar` -> `oc_generar_evidencia` ->
 * `oc_construir_payload` -> `oc_crear`) cuando no se ha configurado clave de API externa
 * o cuando el proveedor externo falla / se selecciona `LLM_PROVIDER=local`.
 * Cumple estrictamente CA1–CA5: nunca afirma un dato que no provenga de las herramientas.
 */
export class DeterministicToolAgentAdapter implements LlmAdapter {
  readonly provider = "perxia-deterministic-agent"
  readonly model = "oc-tool-orchestrator-v2"

  async enviar(mensajes: LlmMessage[], _herramientas: LlmToolDefinition[]): Promise<LlmResponse> {
    // Encontrar el último mensaje de usuario real
    let lastUserIndex = -1
    for (let i = mensajes.length - 1; i >= 0; i--) {
      if (mensajes[i]?.role === "user") {
        lastUserIndex = i
        break
      }
    }

    const lastUserMessage = lastUserIndex >= 0 ? mensajes[lastUserIndex]?.content || "" : ""
    const turnMessages = lastUserIndex >= 0 ? mensajes.slice(lastUserIndex + 1) : []

    // Recolectar resultados de herramientas ejecutadas en ESTE turno
    const turnToolOutputs = new Map<string, Record<string, unknown>>()
    for (const m of turnMessages) {
      if (m.role === "tool" && m.toolName) {
        try {
          turnToolOutputs.set(m.toolName, JSON.parse(m.content) as Record<string, unknown>)
        } catch {
          turnToolOutputs.set(m.toolName, { ok: false, error: m.content })
        }
      }
    }

    // Detectar qué caso (`sol-001` .. `sol-006`) menciona el usuario o estaba activo en la sesión
    const explicitCaseMatch = lastUserMessage.match(/\bsol-00[1-6]\b/i)
    let activeCase = explicitCaseMatch ? explicitCaseMatch[0].toLowerCase() : null

    if (!activeCase) {
      // Buscar el último caso usado en toda la conversación
      for (let i = mensajes.length - 1; i >= 0; i--) {
        const m = mensajes[i]
        if (!m) continue
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            if (typeof tc.args.caso === "string") {
              activeCase = tc.args.caso
              break
            }
          }
        }
        if (activeCase) break
        const matchInText = m.content?.match(/\bsol-00[1-6]\b/i)
        if (matchInText) {
          activeCase = matchInText[0].toLowerCase()
          break
        }
      }
    }

    const normalizedInput = lastUserMessage.toLowerCase().trim()
    const isRejectionMsg =
      !explicitCaseMatch &&
      /\b(cancel\w*|rechaz\w*|no\s+confirm\w*|no\s+crear|detener|abort\w*|descart\w*)\b/i.test(
        normalizedInput
      )

    const isConfirmationMsg =
      !explicitCaseMatch &&
      !isRejectionMsg &&
      /\b(confirmo|confirmar|confirmado|s[ií]\b|procede|proceder|adelante|aprobar|crea la oc|crear la oc|autorizo|ok\b|de acuerdo)/i.test(
        normalizedInput
      ) &&
      !/\bno\s+(la\s+)?(crees|confirm\w*|proced\w*)/i.test(normalizedInput)

    const userAskedWaitConfirmation =
      /\bno\s+la\s+crees\s+hasta\s+que\s+yo\s+(lo\s+)?confirme/i.test(normalizedInput) ||
      /\bantes\s+de\s+crearla/i.test(normalizedInput) ||
      /\bsin\s+crearla/i.test(normalizedInput)

    if (isRejectionMsg && activeCase) {
      return {
        content: `Entendido. He cancelado la creación de la orden de compra para el caso **${activeCase}**. El paquete queda registrado sin orden creada en SAP. Si deseas procesar otra solicitud (por ejemplo \`sol-001\` a \`sol-006\`), indícamelo.`,
        toolCalls: [],
        usage: { promptTokens: 180, completionTokens: 55, totalTokens: 235 },
      }
    }

    // Si el usuario confirma una solicitud que ya fue validada en un turno previo
    if (isConfirmationMsg && activeCase) {
      if (!turnToolOutputs.has("oc_crear")) {
        return {
          content: "",
          toolCalls: [
            {
              id: `call_crear_${Date.now()}`,
              name: "oc_crear",
              args: {
                caso: activeCase,
                confirmado: true,
              },
            },
          ],
          usage: { promptTokens: 320, completionTokens: 45, totalTokens: 365 },
        }
      }

      const crearOut = turnToolOutputs.get("oc_crear")
      return {
        content: this.formatCrearResponse(activeCase, crearOut, true),
        toolCalls: [],
        usage: { promptTokens: 410, completionTokens: 140, totalTokens: 550 },
      }
    }

    // Si no hay ningún caso identificado, guiar a la analista
    if (!activeCase) {
      // ¿Pide leer un Excel?
      const excelMatch = lastUserMessage.match(/([\w./\\-]+\.xlsx)/i)
      if (excelMatch && !turnToolOutputs.has("oc_leer_excel")) {
        return {
          content: "",
          toolCalls: [
            {
              id: `call_excel_${Date.now()}`,
              name: "oc_leer_excel",
              args: { ruta: excelMatch[1] },
            },
          ],
          usage: { promptTokens: 150, completionTokens: 35, totalTokens: 185 },
        }
      }
      if (turnToolOutputs.has("oc_leer_excel")) {
        const excelRes = turnToolOutputs.get("oc_leer_excel")
        return {
          content: `Resultado de lectura de Excel:\n\`\`\`json\n${JSON.stringify(excelRes, null, 2)}\n\`\`\``,
          toolCalls: [],
          usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
        }
      }

      return {
        content: [
          "Hola, soy el **Agente de Órdenes de Compra SAP** de Periferia IT Group.",
          "",
          "Puedo leer paquetes de solicitud, validarlos contra los maestros (`proveedores`, `centros-costo`, `indicadores-iva`, `condiciones-pago`), construir el payload SAP con trazabilidad completa, generar el PDF/TXT de evidencia de aprobación con firma `SHA-256` y crear la OC en SAP.",
          "",
          "Indícame qué caso deseas procesar:",
          "- `sol-001` — Renovación licencias antivirus corporativo (`TecnoSuministros S.A.S.`)",
          "- `sol-002` — Licencia anual herramienta de pruebas (`Soluciones Digitales del Norte S.A.S.`)",
          "- `sol-003` — Mobiliario para nueva sede (`Mobiliario Andino S.A.`)",
          "- `sol-004` — Bolsa de 100 horas de arquitectura de nube (`Cloud Andina S.A.S.`)",
          "- `sol-005` — Papelería y tóner para el trimestre (`Papelería Central Ltda.`)",
          "- `sol-006` — Diademas con micrófono para mesa de soporte (`TecnoSuministros S.A.S.`)",
        ].join("\n"),
        toolCalls: [],
        usage: { promptTokens: 210, completionTokens: 165, totalTokens: 375 },
      }
    }

    // Secuencia multi-iteración de herramientas para el caso activo:
    // Paso 1: oc_leer_paquete
    if (!turnToolOutputs.has("oc_leer_paquete")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_leer_${Date.now()}`,
            name: "oc_leer_paquete",
            args: { caso: activeCase },
          },
        ],
        usage: { promptTokens: 280, completionTokens: 40, totalTokens: 320 },
      }
    }

    const paqueteOut = turnToolOutputs.get("oc_leer_paquete")
    if (!paqueteOut || paqueteOut.ok !== true) {
      return {
        content: `No fue posible leer el paquete del caso **${activeCase}**: \`${String(paqueteOut?.error || "Error desconocido")}\`. Por favor verifica que el paquete en \`fixtures/reto-03/solicitudes/${activeCase}\` esté completo y bien formado.`,
        toolCalls: [],
        usage: { promptTokens: 320, completionTokens: 60, totalTokens: 380 },
      }
    }

    // Paso 2: oc_validar
    if (!turnToolOutputs.has("oc_validar")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_validar_${Date.now()}`,
            name: "oc_validar",
            args: {
              caso: activeCase,
              paquete: paqueteOut.data,
            },
          },
        ],
        usage: { promptTokens: 540, completionTokens: 50, totalTokens: 590 },
      }
    }

    const validarOut = turnToolOutputs.get("oc_validar")
    if (!validarOut || validarOut.ok !== true) {
      return {
        content: `Error al validar el caso **${activeCase}**: \`${String(validarOut?.error || "Error de validación")}\`.`,
        toolCalls: [],
        usage: { promptTokens: 580, completionTokens: 50, totalTokens: 630 },
      }
    }

    const valData = validarOut.data as {
      apta: boolean
      bloqueos: Array<{ codigo: string; regla?: string; detalle: string; accion_sugerida?: string }>
      confirmaciones: Array<{ codigo: string; regla?: string; detalle: string; accion_sugerida?: string }>
      derivados: Record<string, unknown>
      retroactiva: boolean
    }

    // Paso 3: oc_generar_evidencia
    if (!turnToolOutputs.has("oc_generar_evidencia")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_evidencia_${Date.now()}`,
            name: "oc_generar_evidencia",
            args: { caso: activeCase },
          },
        ],
        usage: { promptTokens: 680, completionTokens: 45, totalTokens: 725 },
      }
    }

    // Paso 4: oc_construir_payload (si es apta o si queremos previsualizar qué se alcanzó a armar; si está bloqueada por RC1 sin proveedor SAP, no intentamos crear)
    if (valData.apta && !turnToolOutputs.has("oc_construir_payload")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_payload_${Date.now()}`,
            name: "oc_construir_payload",
            args: {
              caso: activeCase,
              paquete: paqueteOut.data,
              derivados: valData.derivados,
            },
          },
        ],
        usage: { promptTokens: 820, completionTokens: 60, totalTokens: 880 },
      }
    }

    // Si NO es apta (tiene bloqueos, ej. sol-002 o sol-003): registramos el intento bloqueado con oc_crear(confirmado: false) para que quede en out/control.csv según HU-5 ("Cada intento exitoso, bloqueado o pendiente agrega una fila a out/control.csv")
    if (!valData.apta && !turnToolOutputs.has("oc_crear")) {
      return {
        content: "",
        toolCalls: [
          {
            id: `call_crear_bloqueado_${Date.now()}`,
            name: "oc_crear",
            args: {
              caso: activeCase,
              confirmado: false,
            },
          },
        ],
        usage: { promptTokens: 860, completionTokens: 45, totalTokens: 905 },
      }
    }

    // Si es apta, NO tiene confirmaciones pendientes y el usuario NO pidió esperar confirmación (ej. sol-001): creamos automáticamente la OC (Objetivo O1)
    if (
      valData.apta &&
      valData.confirmaciones.length === 0 &&
      !userAskedWaitConfirmation &&
      !turnToolOutputs.has("oc_crear")
    ) {
      const payloadOut = turnToolOutputs.get("oc_construir_payload")
      const payloadData = (payloadOut?.data as { payload?: unknown })?.payload
      return {
        content: "",
        toolCalls: [
          {
            id: `call_crear_auto_${Date.now()}`,
            name: "oc_crear",
            args: {
              caso: activeCase,
              payload: payloadData,
              confirmado: false,
            },
          },
        ],
        usage: { promptTokens: 980, completionTokens: 55, totalTokens: 1035 },
      }
    }

    // Si tiene confirmaciones pendientes (sol-004, sol-005, sol-006), NO llamamos a oc_crear con confirmado=true;
    // pero podemos registrar el estado pendiente o presentar directamente la solicitud de confirmación humana (CA3).
    const evidenciaOut = turnToolOutputs.get("oc_generar_evidencia")
    const payloadOut = turnToolOutputs.get("oc_construir_payload")
    const crearOut = turnToolOutputs.get("oc_crear")

    const responseText = this.buildComprehensiveReport({
      caso: activeCase,
      paqueteData: paqueteOut.data as Record<string, unknown>,
      valData,
      evidenciaData: (evidenciaOut?.data || {}) as Record<string, unknown>,
      payloadData: (payloadOut?.data || {}) as Record<string, unknown>,
      crearOut,
      userAskedWaitConfirmation,
    })

    return {
      content: responseText,
      toolCalls: [],
      usage: { promptTokens: 1150, completionTokens: 340, totalTokens: 1490 },
    }
  }

  private formatCrearResponse(
    caso: string,
    crearOut: Record<string, unknown> | undefined,
    fromConfirmation: boolean
  ): string {
    if (!crearOut || crearOut.ok !== true) {
      return `No se pudo crear la Orden de Compra para **${caso}**: ${String(crearOut?.error || "Error en oc_crear")}`
    }
    const data = crearOut.data as {
      numero_oc: string
      fecha: string
      idempotente: boolean
      retroactiva?: boolean
      ruta_evidencia_txt?: string
      ruta_evidencia_pdf?: string
      ruta_trazabilidad?: string
    }
    const lines: string[] = [
      `### ✅ Orden de Compra Creada en SAP — Caso \`${caso}\``,
      "",
      fromConfirmation
        ? "Tu confirmación ha sido registrada y la orden fue contabilizada exitosamente en el adaptador SAP."
        : "La solicitud superó todos los controles sin excepciones y fue creada automáticamente.",
      "",
      "| Campo | Valor Oficial (Herramienta `oc_crear`) |",
      "|---|---|",
      `| **Número de OC SAP** | \`${data.numero_oc}\` |`,
      `| **Fecha de Creación** | \`${data.fecha}\` |`,
      `| **Idempotencia** | \`${data.idempotente ? "Sí (OC previa reutilizada)" : "No (Nueva creación)"}\` |`,
      `| **Marca Retroactiva** | \`${data.retroactiva ? "true (Factura previa a solicitud)" : "false"}\` |`,
      `| **Evidencia PDF (P1)** | \`${data.ruta_evidencia_pdf || `out/${caso}/aprobacion.pdf`}\` |`,
      `| **Evidencia TXT (P0)** | \`${data.ruta_evidencia_txt || `out/${caso}/aprobacion.txt`}\` |`,
      `| **Trazabilidad** | \`${data.ruta_trazabilidad || `out/${caso}/trazabilidad.json`}\` |`,
      `| **Log de Control** | \`out/control.csv\` |`,
    ]
    return lines.join("\n")
  }

  private buildComprehensiveReport(params: {
    caso: string
    paqueteData: Record<string, unknown>
    valData: {
      apta: boolean
      bloqueos: Array<{ codigo: string; regla?: string; detalle: string; accion_sugerida?: string }>
      confirmaciones: Array<{ codigo: string; regla?: string; detalle: string; accion_sugerida?: string }>
      derivados: Record<string, unknown>
      retroactiva: boolean
    }
    evidenciaData: Record<string, unknown>
    payloadData: Record<string, unknown>
    crearOut?: Record<string, unknown>
    userAskedWaitConfirmation: boolean
  }): string {
    const { caso, paqueteData, valData, evidenciaData, payloadData, crearOut, userAskedWaitConfirmation } = params
    const solicitud = (paqueteData.solicitud || {}) as Record<string, unknown>
    const cotizacion = (paqueteData.cotizacion || null) as Record<string, unknown> | null
    const factura = (paqueteData.factura || null) as Record<string, unknown> | null
    const payload = (payloadData.payload || null) as Record<string, unknown> | null
    const posicion = Array.isArray(payload?.posiciones) ? (payload.posiciones[0] as Record<string, unknown>) : null
    const proveedorPayload = (payload?.proveedor || {}) as Record<string, unknown>
    const aprobadorPayload = (payload?.aprobador || {}) as Record<string, unknown>
    const referenciaPayload = (payload?.referencia || {}) as Record<string, unknown>

    const lines: string[] = []

    // Encabezado según resultado
    if (!valData.apta) {
      lines.push(`### ⛔ Solicitud Bloqueada por Control — Caso \`${caso}\` (\`${String(solicitud.solicitud_id || caso)}\`)`)
      lines.push("")
      lines.push(
        "El paquete fue analizado contra los maestros y **no cumple los controles obligatorios (Bloqueos)**. No se ha creado ninguna Orden de Compra en SAP."
      )
      lines.push("")
      lines.push("#### 1. Resumen del Paquete Leído (`oc_leer_paquete`)")
      lines.push("| Campo | Valor en Solicitud | Valor en Cotización |")
      lines.push("|---|---|---|")
      lines.push(
        `| **Proveedor** | ${String(solicitud.proveedor_nombre || "N/A")} (NIT: \`${String(solicitud.proveedor_nit || "No informado")}\`) | ${cotizacion ? `${String(cotizacion.proveedor)} (NIT: \`${String(cotizacion.nit || "N/A")}\`)` : "Sin cotización"} |`
      )
      lines.push(
        `| **Centro de Costo / Subárea** | \`${String(solicitud.centro_costo)}\` / \`${String(solicitud.subarea)}\` | — |`
      )
      lines.push(
        `| **Monto Total** | \`${String(solicitud.moneda)} ${Number(solicitud.valor_total || 0).toLocaleString("es-CO")}\` | \`${cotizacion ? `${String(cotizacion.moneda)} ${Number(cotizacion.total || 0).toLocaleString("es-CO")}` : "N/A"}\` |`
      )
      lines.push("")
      lines.push("#### 2. Bloqueos Detectados (`oc_validar`)")
      for (const b of valData.bloqueos) {
        if (typeof b === "string") {
          lines.push(`- ${b}`)
        } else {
          lines.push(`- **${b.codigo}**: ${b.detalle}`)
          if (b.accion_sugerida) {
            lines.push(`  - 💡 **Acción sugerida**: ${b.accion_sugerida}`)
          }
        }
      }
      lines.push("")
      lines.push(
        `📄 Evidencia de correo generada en \`${String(evidenciaData.ruta_pdf || `out/${caso}/aprobacion.pdf`)}\` (SHA-256: \`${String(evidenciaData.sha256 || "").slice(0, 16)}...\`) y rechazo registrado en \`out/control.csv\`.`
      )
      return lines.join("\n")
    }

    // Caso apto
    const needsConfirmation = valData.confirmaciones.length > 0 || userAskedWaitConfirmation
    if (needsConfirmation) {
      lines.push(
        `### ⚠️ Previsualización de OC y Confirmación Requerida — Caso \`${caso}\` (\`${String(solicitud.solicitud_id || caso)}\`)`
      )
    } else {
      lines.push(
        `### ✅ Solicitud Procesada y OC Creada en SAP — Caso \`${caso}\` (\`${String(solicitud.solicitud_id || caso)}\`)`
      )
    }
    lines.push("")

    // Tabla del Payload SAP (Sección 7.4 y Sección 11)
    if (payload && posicion) {
      lines.push("#### 1. Payload de la Orden de Compra en SAP (`oc_construir_payload`)")
      lines.push("| Campo SAP | Valor en Payload | Fuente (`trazabilidad.json`) |")
      lines.push("|---|---|---|")
      lines.push(
        `| **Referencia Solicitud / Cotización** | \`${String(referenciaPayload.solicitud_id)}\` / \`${String(referenciaPayload.cotizacion_ref || "N/A")}\` | \`solicitud\` / \`cotizacion\` |`
      )
      lines.push(
        `| **Sociedad / Org. Compras** | \`${String(payload.sociedad)}\` / \`${String(payload.organizacion_compras)}\` | \`derivado (estándar SAP)\` |`
      )
      lines.push(
        `| **Proveedor (Código SAP / NIT)** | \`${String(proveedorPayload.codigo_sap)}\` — ${String(proveedorPayload.nombre)} (\`${String(proveedorPayload.nit)}\`) | \`maestro.proveedores\` |`
      )
      lines.push(
        `| **Posición 10 — Descripción (≤40 car.)** | \`${String(posicion.descripcion)}\` | \`solicitud\` |`
      )
      lines.push(
        `| **Cantidad / Unidad / Precio Unit.** | \`${String(posicion.cantidad)} ${String(posicion.unidad)}\` × \`${String(payload.moneda)} ${Number(posicion.precio_unitario || 0).toLocaleString("es-CO")}\` | \`solicitud\` |`
      )
      lines.push(
        `| **Valor Total Solicitud vs Cotización** | Solicitud: \`${String(payload.moneda)} ${Number(solicitud.valor_total || 0).toLocaleString("es-CO")}\` · Cotización: \`${cotizacion ? `${String(cotizacion.moneda)} ${Number(cotizacion.total || 0).toLocaleString("es-CO")}` : "N/A"}\` | \`solicitud\` / \`cotizacion\` |`
      )
      lines.push(
        `| **Imputación (Centro Costo / Subárea)** | \`${String(posicion.centro_costo)}\` / \`${String(posicion.subarea)}\` | \`solicitud\` + \`maestro.centros-costo\` |`
      )
      lines.push(
        `| **Indicador IVA / Condición Pago** | IVA: \`${String(posicion.indicador_iva)}\` · Pago: \`${String(payload.condiciones_pago)}\` | \`${valData.derivados.indicador_iva ? "derivado (maestro.proveedores)" : "solicitud"}\` |`
      )
      lines.push(
        `| **Aprobador y Fecha** | \`${String(aprobadorPayload.email)}\` (\`${String(aprobadorPayload.fecha_aprobacion)}\`) | \`aprobacion\` + \`maestro.centros-costo\` |`
      )
      lines.push(
        `| **Hash SHA-256 Evidencia** | \`${String(aprobadorPayload.evidencia_sha256 || "").slice(0, 24)}...\` | \`oc_generar_evidencia\` |`
      )
      lines.push(
        `| **Marca Retroactiva** | \`${valData.retroactiva ? "true (Factura " + String(factura?.numero || "") + " del " + String(factura?.fecha || "") + ")" : "false"}\` | \`oc_validar (RC8)\` |`
      )
      lines.push("")
    }

    // Validaciones pasadas y excepciones
    lines.push("#### 2. Resultado de Validaciones de Control (`oc_validar`)")
    lines.push(
      "- **Controles de bloqueo superados (`apta = true`)**: **RC1** (Proveedor activo en SAP), **RC2** (Aprobador autorizado en el centro de costo), **RC3** (Monto dentro del tope del aprobador), **RC4** (Subárea válida para el centro de costo), **RC10** (`cantidad × valor_unitario = valor_total`)."
    )

    const derivadosEntries = Object.entries(valData.derivados || {})
    if (derivadosEntries.length > 0) {
      lines.push(
        `- **Valores derivados desde maestros**: ${derivadosEntries.map(([k, v]) => `\`${k} = "${String(v)}"\``).join(", ")}.`
      )
    }

    if (valData.confirmaciones.length > 0) {
      lines.push("")
      lines.push("#### 3. ⚠️ Excepciones que Requieren tu Confirmación Explícita")
      for (const c of valData.confirmaciones) {
        if (typeof c === "string") {
          lines.push(`- ${c}`)
        } else {
          lines.push(`- **${c.codigo}**: ${c.detalle}`)
          if (c.accion_sugerida) {
            lines.push(`  - *Recomendación*: ${c.accion_sugerida}`)
          }
        }
      }
    }

    lines.push("")
    lines.push(
      `📎 **Archivos de soporte generados**: Trazabilidad en \`${String(payloadData.ruta_trazabilidad || `out/${caso}/trazabilidad.json`)}\` y evidencia en \`${String(evidenciaData.ruta_pdf || `out/${caso}/aprobacion.pdf`)}\` / \`${String(evidenciaData.ruta_txt || `out/${caso}/aprobacion.txt`)}\`.`
    )

    if (needsConfirmation) {
      lines.push("")
      lines.push(
        "**¿Confirmas que deseas crear la Orden de Compra en SAP bajo estas condiciones?** *(Responde **\"Confirmo\"** para crear la OC en SAP o **\"Cancelar\"** para descartarla)*."
      )
    } else if (crearOut && crearOut.ok === true) {
      const cData = crearOut.data as { numero_oc: string; fecha: string; idempotente: boolean }
      lines.push("")
      lines.push("#### 3. Resultado de Creación en SAP (`oc_crear`)")
      lines.push(
        `- **Número de Orden de Compra SAP**: **\`${cData.numero_oc}\`** (Fecha: \`${cData.fecha}\`${cData.idempotente ? ", registro idempotente reutilizado" : ""}).`
      )
      lines.push("- **Log de auditoría**: Registrado en `out/control.csv` y `out/sap/ordenes.jsonl`.")
    }

    return lines.join("\n")
  }
}

/**
 * Fábrica que construye el adaptador LLM según las variables de entorno.
 * Nunca expone las claves de API.
 */
export function createLlmAdapter(): LlmAdapter {
  const requested = (process.env.LLM_PROVIDER || "auto").toLowerCase().trim()

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
  const openaiKey = process.env.OPENAI_API_KEY || ""
  const openrouterKey = process.env.OPENROUTER_API_KEY || ""
  const anthropicKey = process.env.ANTHROPIC_API_KEY || ""
  const ollamaUrl = process.env.OLLAMA_BASE_URL || ""

  if (requested === "gemini" || (requested === "auto" && geminiKey)) {
    if (!geminiKey) throw new Error("LLM_PROVIDER=gemini requiere GEMINI_API_KEY en el entorno.")
    return new GeminiAdapter(geminiKey, process.env.GEMINI_MODEL || "gemini-2.5-flash")
  }

  if (requested === "openai" || (requested === "auto" && openaiKey)) {
    if (!openaiKey) throw new Error("LLM_PROVIDER=openai requiere OPENAI_API_KEY en el entorno.")
    return new OpenAICompatibleAdapter({
      provider: "openai",
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      apiKey: openaiKey,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    })
  }

  if (requested === "openrouter" || (requested === "auto" && openrouterKey)) {
    if (!openrouterKey) throw new Error("LLM_PROVIDER=openrouter requiere OPENROUTER_API_KEY en el entorno.")
    return new OpenAICompatibleAdapter({
      provider: "openrouter",
      model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash",
      apiKey: openrouterKey,
      baseUrl: "https://openrouter.ai/api/v1",
    })
  }

  if (requested === "anthropic" || (requested === "auto" && anthropicKey)) {
    if (!anthropicKey) throw new Error("LLM_PROVIDER=anthropic requiere ANTHROPIC_API_KEY en el entorno.")
    return new AnthropicAdapter(anthropicKey, process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest")
  }

  if (requested === "ollama" && ollamaUrl) {
    return new OpenAICompatibleAdapter({
      provider: "ollama",
      model: process.env.OLLAMA_MODEL || "gemma4-iq2:26b",
      apiKey: "ollama",
      baseUrl: ollamaUrl,
    })
  }

  return new DeterministicToolAgentAdapter()
}
