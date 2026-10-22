import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { z, type ZodTypeAny } from "zod"
import {
  zodArgsToJsonSchema,
  type LlmAdapter,
  type LlmMessage,
  type LlmToolDefinition,
} from "./llm/adapter.ts"
import * as ocTools from "./tools/oc.ts"

export interface ToolModuleItem {
  description: string
  args: Record<string, ZodTypeAny>
  execute(
    args: Record<string, unknown>,
    ctx: { directory: string; sessionId: string }
  ): Promise<string>
}

export interface ExecutedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result: Record<string, unknown>
  rawResult: string
  ok: boolean
  durationMs: number
  timestamp: string
}

export interface ChatTurnEntry {
  id: string
  role: "user" | "assistant"
  content: string
  timestamp: string
  toolCalls?: ExecutedToolCall[]
  needsConfirmation?: boolean
}

export interface AgentSession {
  id: string
  createdAt: string
  updatedAt: string
  llmMessages: LlmMessage[]
  history: ChatTurnEntry[]
  allToolCalls: ExecutedToolCall[]
  needsConfirmation: boolean
  pendingCase: string | null
  tokenUsage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface RunAgentTurnResult {
  ok: boolean
  sessionId: string
  reply: string
  toolCalls: ExecutedToolCall[]
  needsConfirmation: boolean
  pendingCase: string | null
  iterationCount: number
  tokenUsage: AgentSession["tokenUsage"]
  error?: string
}

export class OrderingAgentRuntime {
  private readonly directory: string
  private readonly adapter: LlmAdapter
  private readonly maxIterationsPerTurn: number
  private readonly maxTokensPerSession: number
  private readonly sessions = new Map<string, AgentSession>()
  private readonly toolsMap = new Map<string, ToolModuleItem>()
  private readonly toolDefinitions: LlmToolDefinition[] = []

  constructor(opts: {
    directory: string
    adapter: LlmAdapter
    maxIterationsPerTurn?: number
    maxTokensPerSession?: number
  }) {
    this.directory = opts.directory
    this.adapter = opts.adapter
    this.maxIterationsPerTurn =
      opts.maxIterationsPerTurn ?? Number(process.env.MAX_ITERATIONS_PER_TURN || 25)
    this.maxTokensPerSession =
      opts.maxTokensPerSession ?? Number(process.env.MAX_TOKENS_PER_SESSION || 100000)

    this.registerTools("oc", ocTools as unknown as Record<string, ToolModuleItem>)
  }

  private registerTools(prefix: string, mod: Record<string, ToolModuleItem>): void {
    for (const [exportName, toolObj] of Object.entries(mod)) {
      if (
        toolObj &&
        typeof toolObj === "object" &&
        typeof toolObj.description === "string" &&
        typeof toolObj.execute === "function" &&
        toolObj.args
      ) {
        const fullName = `${prefix}_${exportName}`
        this.toolsMap.set(fullName, toolObj)
        this.toolDefinitions.push({
          name: fullName,
          description: toolObj.description,
          parameters: zodArgsToJsonSchema(toolObj.args),
        })
      }
    }
  }

  private loadSystemPrompt(): string {
    const promptPath = join(this.directory, "agent", "prompt.md")
    const knowledgePath = join(this.directory, "src", "knowledge", "ordenes-compra.md")

    const promptText = existsSync(promptPath)
      ? readFileSync(promptPath, "utf-8")
      : "Eres el Agente de Órdenes de Compra SAP de Periferia IT Group."
    const knowledgeText = existsSync(knowledgePath)
      ? readFileSync(knowledgePath, "utf-8")
      : ""

    return knowledgeText
      ? `${promptText}\n\n---\n\n## Base de Conocimiento del Proceso\n\n${knowledgeText}`
      : promptText
  }

  public getOrCreateSession(sessionId: string): AgentSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const now = new Date().toISOString()
    const session: AgentSession = {
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      llmMessages: [
        {
          role: "system",
          content: this.loadSystemPrompt(),
        },
      ],
      history: [],
      allToolCalls: [],
      needsConfirmation: false,
      pendingCase: null,
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    }
    this.sessions.set(sessionId, session)
    return session
  }

  public resetSession(sessionId: string): AgentSession {
    this.sessions.delete(sessionId)
    return this.getOrCreateSession(sessionId)
  }

  public getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  private logToolCallToJsonl(sessionId: string, entry: ExecutedToolCall): void {
    try {
      const outDir = join(this.directory, "out")
      mkdirSync(outDir, { recursive: true })
      const logPath = join(outDir, "log.jsonl")
      const line = JSON.stringify({
        ts: entry.timestamp,
        sessionId,
        tool: entry.name,
        args: entry.args,
        ok: entry.ok,
        durationMs: entry.durationMs,
        resultSummary: entry.ok
          ? "ok"
          : String((entry.result as { error?: string })?.error || "error"),
      })
      appendFileSync(logPath, line + "\n", "utf-8")
    } catch {
      // No interrumpir la sesión si falla el log secundario
    }
  }

  public async runTurn(sessionId: string, userMessage: string): Promise<RunAgentTurnResult> {
    const session = this.getOrCreateSession(sessionId)
    const now = new Date().toISOString()

    // Verificar tope de tokens por sesión (Sección 8: Costo)
    if (session.tokenUsage.totalTokens >= this.maxTokensPerSession) {
      const limitMsg = `Se alcanzó el tope máximo de tokens configurado para esta sesión (${this.maxTokensPerSession.toLocaleString()} tokens). Por favor inicia una nueva sesión para continuar.`
      return {
        ok: false,
        sessionId,
        reply: limitMsg,
        toolCalls: [],
        needsConfirmation: session.needsConfirmation,
        pendingCase: session.pendingCase,
        iterationCount: 0,
        tokenUsage: session.tokenUsage,
        error: limitMsg,
      }
    }

    session.history.push({
      id: `msg_${Date.now()}_u`,
      role: "user",
      content: userMessage,
      timestamp: now,
    })

    session.llmMessages.push({
      role: "user",
      content: userMessage,
    })

    const turnToolCalls: ExecutedToolCall[] = []
    let iteration = 0
    let finalReply = ""

    try {
      while (iteration < this.maxIterationsPerTurn) {
        iteration++

        const llmRes = await this.adapter.enviar(session.llmMessages, this.toolDefinitions)

        session.tokenUsage.promptTokens += llmRes.usage.promptTokens
        session.tokenUsage.completionTokens += llmRes.usage.completionTokens
        session.tokenUsage.totalTokens += llmRes.usage.totalTokens

        if (!llmRes.toolCalls || llmRes.toolCalls.length === 0) {
          finalReply =
            llmRes.content ||
            "He completado la revisión con las herramientas disponibles."
          session.llmMessages.push({
            role: "assistant",
            content: finalReply,
          })
          break
        }

        // Registrar el mensaje assistant con sus toolCalls
        session.llmMessages.push({
          role: "assistant",
          content: llmRes.content || "",
          toolCalls: llmRes.toolCalls,
        })

        // Ejecutar cada herramienta invocada tras validar con Zod (Sección 6.2)
        for (const call of llmRes.toolCalls) {
          const startedAt = Date.now()
          const toolDef = this.toolsMap.get(call.name)
          let rawResult: string

          if (!toolDef) {
            rawResult = JSON.stringify({
              ok: false,
              error: `La herramienta '${call.name}' no existe. Herramientas disponibles: ${Array.from(this.toolsMap.keys()).join(", ")}`,
            })
          } else {
            const schema = z.object(toolDef.args)
            const parsed = schema.safeParse(call.args || {})
            if (!parsed.success) {
              rawResult = JSON.stringify({
                ok: false,
                error: `Argumentos inválidos para ${call.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
              })
            } else {
              try {
                rawResult = await toolDef.execute(parsed.data, {
                  directory: this.directory,
                  sessionId,
                })
              } catch (execErr) {
                rawResult = JSON.stringify({
                  ok: false,
                  error:
                    execErr instanceof Error
                      ? execErr.message
                      : "Error inesperado ejecutando herramienta",
                })
              }
            }
          }

          let parsedResult: Record<string, unknown> = { ok: false, error: "JSON inválido" }
          try {
            parsedResult = JSON.parse(rawResult) as Record<string, unknown>
          } catch {
            parsedResult = { ok: false, error: rawResult }
          }

          const executedCall: ExecutedToolCall = {
            id: call.id,
            name: call.name,
            args: call.args,
            result: parsedResult,
            rawResult,
            ok: parsedResult.ok === true,
            durationMs: Date.now() - startedAt,
            timestamp: new Date().toISOString(),
          }

          turnToolCalls.push(executedCall)
          session.allToolCalls.push(executedCall)
          this.logToolCallToJsonl(sessionId, executedCall)

          if (typeof call.args.caso === "string") {
            session.pendingCase = call.args.caso
          }

          session.llmMessages.push({
            role: "tool",
            toolCallId: call.id,
            toolName: call.name,
            content: rawResult,
          })
        }
      }

      // Regla CA1: Si se alcanzó el tope de iteraciones sin respuesta final
      if (!finalReply && iteration >= this.maxIterationsPerTurn) {
        finalReply = `⚠️ Se alcanzó el tope máximo de ${this.maxIterationsPerTurn} iteraciones en este turno (Regla CA1). Hasta este punto se ejecutaron ${turnToolCalls.length} llamadas a herramientas (${turnToolCalls.map((t) => t.name).join(", ")}). Por favor envía un mensaje adicional para continuar o confirmar la operación.`
        session.llmMessages.push({
          role: "assistant",
          content: finalReply,
        })
      }

      // Evaluar estado de confirmación humana (Regla CA3)
      const needsConfirmation = this.computeNeedsConfirmation(
        userMessage,
        turnToolCalls,
        finalReply,
        session.needsConfirmation
      )
      session.needsConfirmation = needsConfirmation
      session.updatedAt = new Date().toISOString()

      session.history.push({
        id: `msg_${Date.now()}_a`,
        role: "assistant",
        content: finalReply,
        timestamp: session.updatedAt,
        toolCalls: turnToolCalls,
        needsConfirmation,
      })

      return {
        ok: true,
        sessionId,
        reply: finalReply,
        toolCalls: turnToolCalls,
        needsConfirmation,
        pendingCase: session.pendingCase,
        iterationCount: iteration,
        tokenUsage: session.tokenUsage,
      }
    } catch (err) {
      // Regla CA5: Un error de herramienta o del proveedor LLM se muestra en lenguaje claro; la sesión no muere.
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Error inesperado al comunicarse con el modelo de lenguaje."
      const friendlyReply = `⚠️ **Aviso del sistema**: Ocurrió un inconveniente al procesar el turno (${errorMessage}). La sesión sigue activa y puedes reintentar tu consulta.`

      session.updatedAt = new Date().toISOString()
      session.history.push({
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: friendlyReply,
        timestamp: session.updatedAt,
        toolCalls: turnToolCalls,
        needsConfirmation: session.needsConfirmation,
      })

      return {
        ok: false,
        sessionId,
        reply: friendlyReply,
        toolCalls: turnToolCalls,
        needsConfirmation: session.needsConfirmation,
        pendingCase: session.pendingCase,
        iterationCount: iteration,
        tokenUsage: session.tokenUsage,
        error: errorMessage,
      }
    }
  }

  private computeNeedsConfirmation(
    userMessage: string,
    turnToolCalls: ExecutedToolCall[],
    finalReply: string,
    previousNeedsConfirmation: boolean
  ): boolean {
    // Si en este turno se ejecutó oc_crear con ok: true, ya se creó la OC y no queda pendiente confirmación
    const createdSuccessfully = turnToolCalls.some(
      (tc) => tc.name === "oc_crear" && tc.ok
    )
    if (createdSuccessfully) {
      return false
    }

    // Si el usuario canceló/rechazó explícitamente
    if (/\b(cancel\w*|rechaz\w*|no\s+confirm\w*|no\s+crear|abort\w*|descart\w*)\b/i.test(userMessage)) {
      return false
    }

    // Si en este turno se ejecutó oc_validar, miramos si es apta y tiene confirmaciones o si el usuario pidió esperar confirmación
    const validarCall = [...turnToolCalls].reverse().find((tc) => tc.name === "oc_validar" && tc.ok)
    if (validarCall) {
      const data = (validarCall.result.data || {}) as {
        apta?: boolean
        confirmaciones?: unknown[]
      }
      if (data.apta === false) {
        return false
      }
      if (data.apta === true && Array.isArray(data.confirmaciones) && data.confirmaciones.length > 0) {
        return true
      }
      if (
        data.apta === true &&
        /\bno\s+la\s+crees\s+hasta\s+que\s+yo\s+(lo\s+)?confirme/i.test(userMessage)
      ) {
        return true
      }
    }

    // Si la respuesta del asistente cierra con pregunta explícita de confirmación
    if (/\b¿confirmas\b|\bconfirma si deseas\b|\brequiere tu confirmaci[oó]n\b/i.test(finalReply)) {
      return true
    }

    return previousNeedsConfirmation && turnToolCalls.length === 0
  }
}
