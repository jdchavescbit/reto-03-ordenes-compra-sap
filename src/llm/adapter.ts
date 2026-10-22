import { z, type ZodTypeAny } from "zod"

export interface LlmToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  toolCalls?: LlmToolCall[]
  toolCallId?: string
  toolName?: string
}

export interface LlmToolDefinition {
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, { type: string; description?: string; optional?: boolean }>
    required: string[]
  }
}

export interface LlmTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmResponse {
  content: string
  toolCalls: LlmToolCall[]
  usage: LlmTokenUsage
}

/**
 * Interfaz obligatoria del adaptador LLM (Sección 6.1 del PRD).
 * Cambiar de proveedor no toca el ciclo del agente.
 */
export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  enviar(mensajes: LlmMessage[], herramientas: LlmToolDefinition[]): Promise<LlmResponse>
}

/**
 * Convierte un mapa de esquemas Zod (`args` de una herramienta) a JSON Schema estándar
 * compatible con OpenAI, Gemini y Anthropic.
 */
export function zodArgsToJsonSchema(argsRecord: Record<string, ZodTypeAny>): LlmToolDefinition["parameters"] {
  const properties: Record<string, { type: string; description?: string }> = {}
  const required: string[] = []

  for (const [key, schema] of Object.entries(argsRecord)) {
    const isOptional = schema.isOptional()
    if (!isOptional) {
      required.push(key)
    }

    const description = schema.description
    const unwrapped = unwrapZodType(schema)
    const jsonType = mapZodTypeNameToJsonType(unwrapped)

    properties[key] = {
      type: jsonType,
      ...(description ? { description } : {}),
    }
  }

  return {
    type: "object",
    properties,
    required,
  }
}

function unwrapZodType(schema: ZodTypeAny): ZodTypeAny {
  const def = schema._def as { typeName?: string; innerType?: ZodTypeAny }
  if (
    (def.typeName === "ZodOptional" || def.typeName === "ZodDefault" || def.typeName === "ZodNullable") &&
    def.innerType
  ) {
    return unwrapZodType(def.innerType)
  }
  return schema
}

function mapZodTypeNameToJsonType(schema: ZodTypeAny): string {
  const def = schema._def as { typeName?: string }
  switch (def.typeName) {
    case "ZodString":
      return "string"
    case "ZodNumber":
      return "number"
    case "ZodBoolean":
      return "boolean"
    case "ZodArray":
      return "array"
    case "ZodObject":
    case "ZodRecord":
    case "ZodAny":
    case "ZodUnknown":
      return "object"
    default:
      return "string"
  }
}
