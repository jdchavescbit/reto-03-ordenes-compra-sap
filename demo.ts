import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  construir_payload,
  crear,
  generar_evidencia,
  leer_paquete,
  validar,
  type PaqueteNormalizado,
  type ResultadoValidacion,
} from "./src/tools/oc.ts"

interface ToolResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

interface CrearData {
  solicitud_id: string
  numero_oc?: string
  fecha?: string
  idempotente?: boolean
  retroactiva: boolean
  resultado?: string
  ruta_evidencia_txt?: string
  ruta_evidencia_pdf?: string
  ruta_trazabilidad?: string
  bloqueos?: string[]
  confirmaciones?: string[]
}

const directory = import.meta.dir
const ctx = { directory, sessionId: "demo-sin-modelo" }

function parsearRespuesta<T>(jsonStr: string): ToolResponse<T> {
  return JSON.parse(jsonStr) as ToolResponse<T>
}

async function ejecutarDemo(): Promise<void> {
  // Sección 8: Limpiar out/ al inicio para garantizar determinismo
  const outDir = join(directory, "out")
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })

  console.log("================================================================================")
  console.log("  RETO TÉCNICO 03 — AGENTE ÓRDENES DE COMPRA SAP · DEMO SIN MODELO (demo.ts)    ")
  console.log("================================================================================\n")

  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]
  const resumenTabla: Array<{
    Caso: string
    Solicitud: string
    Apta: string
    Retroactiva: string
    Bloqueos: number
    Confirmaciones: number
    Resultado: string
    NumeroOC: string
  }> = []

  for (const caso of casos) {
    console.log(`--------------------------------------------------------------------------------`)
    console.log(`PROCESANDO CASO: ${caso.toUpperCase()}`)
    console.log(`--------------------------------------------------------------------------------`)

    const resPaquete = parsearRespuesta<PaqueteNormalizado>(
      await leer_paquete.execute({ caso }, ctx),
    )
    if (!resPaquete.ok || !resPaquete.data) {
      console.log(`  [ERROR LECTURA]: ${resPaquete.error}`)
      continue
    }
    const paquete = resPaquete.data
    console.log(
      `  1. Paquete leído: ${paquete.solicitud.solicitud_id} | Proveedor: ${paquete.solicitud.proveedor_nombre} | Total: ${paquete.solicitud.moneda} ${paquete.solicitud.valor_total.toLocaleString("es-CO")}`,
    )
    if (paquete.adjuntos_faltantes.length > 0) {
      console.log(`     Adjuntos faltantes: ${paquete.adjuntos_faltantes.join(", ")}`)
    }

    const resValidar = parsearRespuesta<ResultadoValidacion>(
      await validar.execute({ caso, paquete }, ctx),
    )
    if (!resValidar.ok || !resValidar.data) {
      console.log(`  [ERROR VALIDACIÓN]: ${resValidar.error}`)
      continue
    }
    const val = resValidar.data
    console.log(`  2. Validación RC1–RC10:`)
    console.log(`     - Apta        : ${val.apta}`)
    console.log(`     - Retroactiva : ${val.retroactiva}`)
    console.log(
      `     - Derivados   : ${Object.keys(val.derivados).length > 0 ? JSON.stringify(val.derivados) : "ninguno"}`,
    )

    if (val.bloqueos.length > 0) {
      console.log(`     - Bloqueos (${val.bloqueos.length}):`)
      for (const b of val.bloqueos) {
        console.log(`         * ${b}`)
      }
    } else {
      console.log(`     - Bloqueos    : 0`)
    }

    if (val.confirmaciones.length > 0) {
      console.log(`     - Confirmaciones requeridas (${val.confirmaciones.length}):`)
      for (const c of val.confirmaciones) {
        console.log(`         * ${c}`)
      }
    } else {
      console.log(`     - Confirmaciones: 0`)
    }

    // Generar evidencia y construir payload preliminar para todos los casos
    const resEvidencia = parsearRespuesta<{
      ruta_txt: string
      ruta_pdf: string
      sha256: string
    }>(await generar_evidencia.execute({ caso }, ctx))
    if (resEvidencia.ok && resEvidencia.data) {
      console.log(
        `  3. Evidencia generada: ${resEvidencia.data.ruta_pdf} (SHA-256: ${resEvidencia.data.sha256.slice(0, 16)}...)`,
      )
    }

    const resPayload = parsearRespuesta<{ ruta_trazabilidad: string }>(
      await construir_payload.execute(
        { caso, paquete, derivados: val.derivados },
        ctx,
      ),
    )
    if (resPayload.ok && resPayload.data) {
      console.log(`  4. Trazabilidad guardada: ${resPayload.data.ruta_trazabilidad}`)
    }

    // Paso 5: Intentar crear OC sin confirmación primero
    const resCrearInicial = parsearRespuesta<CrearData>(
      await crear.execute({ caso, confirmado: false }, ctx),
    )

    if (resCrearInicial.ok && resCrearInicial.data) {
      console.log(
        `  5. OC Creada automáticamente: #${resCrearInicial.data.numero_oc} (idempotente=${resCrearInicial.data.idempotente})`,
      )

      // Demostración obligatoria de idempotencia en sol-001 (ejecutar dos veces)
      if (caso === "sol-001") {
        const resReintento = parsearRespuesta<CrearData>(
          await crear.execute({ caso, confirmado: false }, ctx),
        )
        if (resReintento.ok && resReintento.data) {
          console.log(
            `  6. [PRUEBA IDEMPOTENCIA sol-001] 2da ejecución devolvió misma OC #${resReintento.data.numero_oc} con idempotente=${resReintento.data.idempotente}`,
          )
        }
      }

      resumenTabla.push({
        Caso: caso,
        Solicitud: paquete.solicitud.solicitud_id,
        Apta: "SI",
        Retroactiva: val.retroactiva ? "SI" : "NO",
        Bloqueos: val.bloqueos.length,
        Confirmaciones: val.confirmaciones.length,
        Resultado: "CREADA",
        NumeroOC: resCrearInicial.data.numero_oc ?? "-",
      })
    } else if (!val.apta) {
      console.log(`  5. Creación rechazada (BLOQUEADA): ${resCrearInicial.error}`)
      resumenTabla.push({
        Caso: caso,
        Solicitud: paquete.solicitud.solicitud_id,
        Apta: "NO",
        Retroactiva: val.retroactiva ? "SI" : "NO",
        Bloqueos: val.bloqueos.length,
        Confirmaciones: val.confirmaciones.length,
        Resultado: "BLOQUEADA",
        NumeroOC: "-",
      })
    } else {
      console.log(
        `  5. Intento sin confirmación detenido (${resCrearInicial.data?.resultado}): ${resCrearInicial.error}`,
      )
      // Confirmación humana explícita para casos aptos con excepciones (sol-004, sol-005, sol-006)
      const resCrearConfirmado = parsearRespuesta<CrearData>(
        await crear.execute(
          {
            caso,
            confirmado: true,
            confirmado_por: "camila.analista@periferia-ficticia.com",
          },
          ctx,
        ),
      )
      if (resCrearConfirmado.ok && resCrearConfirmado.data) {
        console.log(
          `  6. [CONFIRMACIÓN HUMANA EXPLÍCITA] OC Creada tras confirmación: #${resCrearConfirmado.data.numero_oc} (retroactiva=${resCrearConfirmado.data.retroactiva})`,
        )
        resumenTabla.push({
          Caso: caso,
          Solicitud: paquete.solicitud.solicitud_id,
          Apta: "SI",
          Retroactiva: val.retroactiva ? "SI" : "NO",
          Bloqueos: val.bloqueos.length,
          Confirmaciones: val.confirmaciones.length,
          Resultado: "CREADA (CONFIRMADA)",
          NumeroOC: resCrearConfirmado.data.numero_oc ?? "-",
        })
      }
    }
    console.log("")
  }

  console.log("================================================================================")
  console.log("  RESUMEN CONSOLIDADO DE LOS 6 CASOS                                            ")
  console.log("================================================================================")
  console.table(resumenTabla)

  const rutaControl = join(directory, "out", "control.csv")
  if (existsSync(rutaControl)) {
    console.log("\nContenido generado en out/control.csv:")
    console.log(readFileSync(rutaControl, "utf-8"))
  }
}

await ejecutarDemo()
