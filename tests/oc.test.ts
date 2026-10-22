import { describe, expect, test, beforeAll } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as XLSX from "xlsx"
import * as ocTools from "../src/tools/oc.ts"
import * as moduloTools from "../modulo/tools/oc.ts"
import { handleHttpRequest } from "../src/server.ts"

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)))
const ctx = { directory: ROOT_DIR, sessionId: "test-session" }

describe("Reto 03 — Agente Órdenes de Compra SAP (Suite Integral)", () => {
  beforeAll(() => {
    const outDir = join(ROOT_DIR, "out")
    if (existsSync(outDir)) {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test("Bonus 9.4: modulo/ comparte exactamente las mismas herramientas, prompt y skill que la aplicación", () => {
    expect(moduloTools.leer_paquete).toBe(ocTools.leer_paquete)
    expect(moduloTools.validar).toBe(ocTools.validar)
    expect(moduloTools.construir_payload).toBe(ocTools.construir_payload)
    expect(moduloTools.generar_evidencia).toBe(ocTools.generar_evidencia)
    expect(moduloTools.crear).toBe(ocTools.crear)

    const appPrompt = readFileSync(join(ROOT_DIR, "agent", "prompt.md"), "utf-8").trim()
    const modAgent = readFileSync(join(ROOT_DIR, "modulo", "agent.md"), "utf-8")
    expect(modAgent).toContain("mode: primary")
    expect(modAgent).toContain("edit: deny")
    expect(modAgent).toContain("bash: deny")
    expect(modAgent).toContain(appPrompt)

    const appSkill = readFileSync(join(ROOT_DIR, "src", "knowledge", "ordenes-compra.md"), "utf-8").trim()
    const modSkill = readFileSync(join(ROOT_DIR, "modulo", "skill", "ordenes-compra", "SKILL.md"), "utf-8")
    expect(modSkill).toContain("name: ordenes-compra")
    expect(modSkill).toContain(appSkill)
  })

  test("O1 (sol-001): Flujo normal crea OC 4500000001 sin intervención humana y es idempotente al repetir", async () => {
    const pkgRes = JSON.parse(await ocTools.leer_paquete.execute({ caso: "sol-001" }, ctx))
    expect(pkgRes.ok).toBe(true)
    expect(pkgRes.data.solicitud.solicitud_id).toBe("SOL-2026-001")
    expect(pkgRes.data.cotizacion.total).toBe(11400000)

    const valRes = JSON.parse(await ocTools.validar.execute({ caso: "sol-001", paquete: pkgRes.data }, ctx))
    expect(valRes.ok).toBe(true)
    expect(valRes.data.apta).toBe(true)
    expect(valRes.data.bloqueos).toHaveLength(0)
    expect(valRes.data.confirmaciones).toHaveLength(0)
    expect(valRes.data.retroactiva).toBe(false)

    const evRes = JSON.parse(await ocTools.generar_evidencia.execute({ caso: "sol-001" }, ctx))
    expect(evRes.ok).toBe(true)
    expect(evRes.data.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(join(ROOT_DIR, "out", "sol-001", "aprobacion.txt"))).toBe(true)
    expect(existsSync(join(ROOT_DIR, "out", "sol-001", "aprobacion.pdf"))).toBe(true)

    const payRes = JSON.parse(
      await ocTools.construir_payload.execute(
        { caso: "sol-001", paquete: pkgRes.data, derivados: valRes.data.derivados },
        ctx
      )
    )
    expect(payRes.ok).toBe(true)
    expect(payRes.data.payload.posiciones[0].descripcion.length).toBeLessThanOrEqual(40)
    expect(existsSync(join(ROOT_DIR, "out", "sol-001", "trazabilidad.json"))).toBe(true)

    const create1 = JSON.parse(
      await ocTools.crear.execute({ caso: "sol-001", payload: payRes.data.payload }, ctx)
    )
    expect(create1.ok).toBe(true)
    expect(create1.data.numero_oc).toBe("4500000001")
    expect(create1.data.idempotente).toBe(false)

    // Segunda ejecución de sol-001 → idempotente
    const create2 = JSON.parse(
      await ocTools.crear.execute({ caso: "sol-001", payload: payRes.data.payload }, ctx)
    )
    expect(create2.ok).toBe(true)
    expect(create2.data.numero_oc).toBe("4500000001")
    expect(create2.data.idempotente).toBe(true)
  })

  test("O2 (sol-002 y sol-003): Bloquea proveedor inexistente (RC1) y aprobador sin autoridad (RC2/RC3)", async () => {
    const val2 = JSON.parse(await ocTools.validar.execute({ caso: "sol-002" }, ctx))
    expect(val2.ok).toBe(true)
    expect(val2.data.apta).toBe(false)
    expect(val2.data.bloqueos.some((b: unknown) => JSON.stringify(b).includes("RC1"))).toBe(true)

    const create2 = JSON.parse(await ocTools.crear.execute({ caso: "sol-002", confirmado: true }, ctx))
    expect(create2.ok).toBe(false)

    const val3 = JSON.parse(await ocTools.validar.execute({ caso: "sol-003" }, ctx))
    expect(val3.ok).toBe(true)
    expect(val3.data.apta).toBe(false)
    expect(val3.data.bloqueos.some((b: unknown) => JSON.stringify(b).includes("RC2"))).toBe(true)

    const create3 = JSON.parse(await ocTools.crear.execute({ caso: "sol-003", confirmado: true }, ctx))
    expect(create3.ok).toBe(false)
  })

  test("O3 (sol-004 y sol-006): Pide confirmación en diferencia >2% (RC5) e IVA derivado (RC6)", async () => {
    const val4 = JSON.parse(await ocTools.validar.execute({ caso: "sol-004" }, ctx))
    expect(val4.data.apta).toBe(true)
    expect(val4.data.confirmaciones.some((c: unknown) => JSON.stringify(c).includes("RC5"))).toBe(true)

    // Sin confirmar no crea
    const unconfirmed4 = JSON.parse(await ocTools.crear.execute({ caso: "sol-004", confirmado: false }, ctx))
    expect(unconfirmed4.ok).toBe(false)

    // Con confirmado = true sí crea
    const confirmed4 = JSON.parse(await ocTools.crear.execute({ caso: "sol-004", confirmado: true }, ctx))
    expect(confirmed4.ok).toBe(true)
    expect(confirmed4.data.numero_oc).toBe("4500000002")

    // sol-006: deriva NIT, IVA (RC6) y condiciones de pago (RC7)
    const val6 = JSON.parse(await ocTools.validar.execute({ caso: "sol-006" }, ctx))
    expect(val6.data.apta).toBe(true)
    expect(val6.data.confirmaciones.some((c: unknown) => JSON.stringify(c).includes("RC6"))).toBe(true)
    expect(val6.data.derivados.indicador_iva).toContain("C1")
    expect(val6.data.derivados.condiciones_pago).toContain("Z030")
  })

  test("O4 (sol-005): Detecta OC retroactiva (RC8) y la registra con retroactiva = true en out/control.csv", async () => {
    const val5 = JSON.parse(await ocTools.validar.execute({ caso: "sol-005" }, ctx))
    expect(val5.data.apta).toBe(true)
    expect(val5.data.retroactiva).toBe(true)
    expect(val5.data.confirmaciones.some((c: unknown) => JSON.stringify(c).includes("RC8"))).toBe(true)

    const confirmed5 = JSON.parse(await ocTools.crear.execute({ caso: "sol-005", confirmado: true }, ctx))
    expect(confirmed5.ok).toBe(true)
    expect(confirmed5.data.retroactiva).toBe(true)

    const csvContent = readFileSync(join(ROOT_DIR, "out", "control.csv"), "utf-8")
    expect(csvContent).toContain("SOL-2026-005")
    expect(csvContent).toContain("true")
  })

  test("P1 opcional (oc_leer_excel): Lee un archivo .xlsx real sin lanzar excepción", async () => {
    const tmpDir = join(ROOT_DIR, "out", "tmp-excel")
    mkdirSync(tmpDir, { recursive: true })
    const xlsxPath = join(tmpDir, "solicitud-test.xlsx")

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet([
      {
        solicitud_id: "SOL-2026-099",
        proveedor_nombre: "TecnoSuministros S.A.S.",
        valor_total: 11400000,
      },
    ])
    XLSX.utils.book_append_sheet(wb, ws, "Solicitud")
    XLSX.writeFile(wb, xlsxPath)

    const res = JSON.parse(await ocTools.leer_excel.execute({ ruta: "out/tmp-excel/solicitud-test.xlsx" }, ctx))
    expect(res.ok).toBe(true)
    expect(res.data.filas).toHaveLength(1)
    expect(res.data.filas[0].solicitud_id).toBe("SOL-2026-099")
  })

  test("API HTTP y Ciclo Conversacional (Sección 6.4 y Sección 11): Turno de previsualización + Turno de confirmación", async () => {
    const healthRes = await handleHttpRequest(new Request("http://localhost:3000/api/health"))
    const healthJson = (await healthRes.json()) as { ok: boolean; provider: string }
    expect(healthJson.ok).toBe(true)
    expect(typeof healthJson.provider).toBe("string")

    // Sesión nueva con el prompt exacto de la Sección 11 del PRD sobre sol-006
    const turn1Res = await handleHttpRequest(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "demo-sec11",
          message:
            'Procesa la solicitud "sol-006". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.',
        }),
      })
    )
    const turn1 = (await turn1Res.json()) as {
      ok: boolean
      reply: string
      toolCalls: Array<{ name: string }>
      needsConfirmation: boolean
    }
    expect(turn1.ok).toBe(true)
    expect(turn1.needsConfirmation).toBe(true)
    expect(turn1.toolCalls.some((t) => t.name === "oc_leer_paquete")).toBe(true)
    expect(turn1.toolCalls.some((t) => t.name === "oc_validar")).toBe(true)
    expect(turn1.toolCalls.some((t) => t.name === "oc_construir_payload")).toBe(true)
    expect(turn1.toolCalls.some((t) => t.name === "oc_crear")).toBe(false)

    // Turno 2: Confirmación de la analista
    const turn2Res = await handleHttpRequest(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "demo-sec11",
          message: "Confirmo",
        }),
      })
    )
    const turn2 = (await turn2Res.json()) as {
      ok: boolean
      reply: string
      toolCalls: Array<{ name: string }>
      needsConfirmation: boolean
    }
    expect(turn2.ok).toBe(true)
    expect(turn2.needsConfirmation).toBe(false)
    expect(turn2.toolCalls.some((t) => t.name === "oc_crear")).toBe(true)
    expect(turn2.reply).toContain("450000000")

    // Turno de rechazo explícito ("No confirmo. Cancela...") en una nueva sesión sobre sol-004
    await handleHttpRequest(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "demo-reject",
          message: 'Procesa la solicitud "sol-004".',
        }),
      })
    )
    const rejectRes = await handleHttpRequest(
      new Request("http://localhost:3000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "demo-reject",
          message: "No confirmo. Cancela la creación de esta orden de compra y devuélvela al solicitante.",
        }),
      })
    )
    const rejectJson = (await rejectRes.json()) as {
      ok: boolean
      reply: string
      toolCalls: Array<{ name: string }>
      needsConfirmation: boolean
    }
    expect(rejectJson.ok).toBe(true)
    expect(rejectJson.needsConfirmation).toBe(false)
    expect(rejectJson.toolCalls).toHaveLength(0)
    expect(rejectJson.reply.toLowerCase()).toContain("cancelado")
  })
})
