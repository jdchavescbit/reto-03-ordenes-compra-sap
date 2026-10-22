import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"
import * as XLSX from "xlsx"
import { z } from "zod"
import { ExcepcionOrdenCompra, OrdenCompra, OrdenCompraSchema } from "../sap/adapter.ts"
import { MockSapAdapter, ProveedorMaestro, normalizarNit } from "../sap/mock.ts"

export interface ToolContext {
  directory: string
  sessionId: string
}

export interface CorreoFixture {
  id: string
  de: string
  para?: string
  asunto: string
  fecha: string
  cuerpo?: string
  adjuntos?: string[]
}

export interface SolicitudFixture {
  solicitud_id: string
  solicitante: string
  proveedor_nombre: string
  proveedor_nit?: string
  descripcion: string
  centro_costo: string
  subarea: string
  cantidad: number
  valor_unitario: number
  valor_total: number
  moneda: "COP" | "USD"
  indicador_iva?: string
  condiciones_pago?: string
  fecha_solicitud: string
}

export interface CotizacionNormalizada {
  cotizacion_ref: string | null
  fecha_cotizacion: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
}

export interface AprobacionNormalizada {
  de: string
  para: string
  cc: string[]
  asunto: string
  fecha: string
  aprobado: boolean
  texto: string
}

export interface FacturaNormalizada {
  numero: string
  fecha: string
  total: number
  texto: string
}

export interface PaqueteNormalizado {
  caso: string
  correo: {
    id: string
    de: string
    asunto: string
    fecha: string
  }
  solicitud: SolicitudFixture
  cotizacion: CotizacionNormalizada | null
  aprobacion: AprobacionNormalizada | null
  factura: FacturaNormalizada | null
  adjuntos_faltantes: string[]
}

export interface CentroCostoMaestro {
  centro_costo: string
  nombre: string
  subareas: string[]
  aprobadores: Array<{
    email: string
    nombre: string
    tope: number
  }>
}

export interface IndicadorIvaMaestro {
  codigo: string
  descripcion: string
  tasa: number
}

export interface CondicionPagoMaestro {
  codigo: string
  descripcion: string
  dias: number
}

export interface ResultadoValidacion {
  caso: string
  solicitud_id: string
  apta: boolean
  bloqueos: string[]
  confirmaciones: string[]
  derivados: Record<string, string>
  retroactiva: boolean
}

export type FuenteTrazabilidad =
  | "solicitud"
  | "cotizacion"
  | "maestro.proveedores"
  | "maestro.centros-costo"
  | "maestro.indicadores-iva"
  | "maestro.condiciones-pago"
  | "derivado"

export interface EntradaTrazabilidad {
  valor: unknown
  fuente: FuenteTrazabilidad
}

function normalizarTexto(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizarCasoId(casoRaw: string): string {
  const limpio = casoRaw.trim().toLowerCase()
  if (limpio.includes("..") || limpio.includes("/") || limpio.includes("\\")) {
    throw new Error(`Identificador de caso inválido: "${casoRaw}"`)
  }
  return limpio
}

function parsearMonto(textoMonto: string): number {
  const limpio = textoMonto.replace(/[^0-9]/g, "")
  const valor = Number(limpio)
  if (!Number.isFinite(valor) || limpio.length === 0) {
    throw new Error(`No se pudo interpretar el monto numérico: "${textoMonto}"`)
  }
  return valor
}

function sumarDiasFechaIso(fechaIso: string, dias: number): string | null {
  const partes = fechaIso.split("-").map(Number)
  if (partes.length !== 3 || partes.some((n) => !Number.isFinite(n))) {
    return null
  }
  const [anio, mes, dia] = partes
  const fecha = new Date(Date.UTC(anio ?? 2026, (mes ?? 1) - 1, dia ?? 1))
  fecha.setUTCDate(fecha.getUTCDate() + dias)
  return fecha.toISOString().slice(0, 10)
}

function parsearCotizacionTxt(texto: string): CotizacionNormalizada {
  const refMatch = texto.match(/COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i)
  const fechaMatch = texto.match(/Fecha:\s*(\d{4}-\d{2}-\d{2})/i)
  const proveedorMatch = texto.match(/Proveedor:\s*(.+)/i)
  const nitMatch = texto.match(/^NIT:\s*([0-9.-]+)/im)
  const totalMatch = texto.match(/TOTAL(?:\s*\([^)]*\))?:\s*([A-Z]{3})\s*([0-9.]+)/i)
  const validezMatch = texto.match(/Validez de la oferta:\s*(\d+)\s*d[íi]as/i)

  const fechaCotizacion = fechaMatch?.[1]?.trim() ?? null
  const diasValidez = validezMatch?.[1] ? Number(validezMatch[1]) : null
  const validezHasta =
    fechaCotizacion && diasValidez !== null && Number.isFinite(diasValidez)
      ? sumarDiasFechaIso(fechaCotizacion, diasValidez)
      : null

  return {
    cotizacion_ref: refMatch?.[1]?.trim() ?? null,
    fecha_cotizacion: fechaCotizacion,
    proveedor: proveedorMatch?.[1]?.trim() ?? "Desconocido",
    nit: nitMatch?.[1] ? normalizarNit(nitMatch[1]) : null,
    moneda: totalMatch?.[1]?.trim().toUpperCase() ?? "COP",
    total: totalMatch?.[2] ? parsearMonto(totalMatch[2]) : 0,
    validez_hasta: validezHasta,
    texto,
  }
}

function parsearFacturaTxt(texto: string): FacturaNormalizada {
  const numeroMatch = texto.match(/No\.\s*([A-Z0-9-]+)/i)
  const fechaMatch = texto.match(/Fecha de emisi[óo]n:\s*(\d{4}-\d{2}-\d{2})/i)
  const totalMatch = texto.match(/TOTAL:\s*(?:[A-Z]{3}\s*)?([0-9.]+)/i)

  return {
    numero: numeroMatch?.[1]?.trim() ?? "SIN-NUMERO",
    fecha: fechaMatch?.[1]?.trim() ?? "",
    total: totalMatch?.[1] ? parsearMonto(totalMatch[1]) : 0,
    texto,
  }
}

function cargarMaestros(directory: string): {
  proveedores: ProveedorMaestro[]
  centrosCosto: CentroCostoMaestro[]
  indicadoresIva: IndicadorIvaMaestro[]
  condicionesPago: CondicionPagoMaestro[]
} {
  const baseMaestros = join(directory, "fixtures", "reto-03", "maestros")
  const proveedores = JSON.parse(
    readFileSync(join(baseMaestros, "proveedores.json"), "utf-8"),
  ) as ProveedorMaestro[]
  const centrosCosto = JSON.parse(
    readFileSync(join(baseMaestros, "centros-costo.json"), "utf-8"),
  ) as CentroCostoMaestro[]
  const indicadoresIva = JSON.parse(
    readFileSync(join(baseMaestros, "indicadores-iva.json"), "utf-8"),
  ) as IndicadorIvaMaestro[]
  const condicionesPago = JSON.parse(
    readFileSync(join(baseMaestros, "condiciones-pago.json"), "utf-8"),
  ) as CondicionPagoMaestro[]

  return { proveedores, centrosCosto, indicadoresIva, condicionesPago }
}

function buscarProveedorEnMaestro(
  solicitud: SolicitudFixture,
  proveedores: ProveedorMaestro[],
): { proveedor: ProveedorMaestro | null; buscadoPor: "nit" | "nombre" } {
  if (solicitud.proveedor_nit && solicitud.proveedor_nit.trim().length > 0) {
    const nitBuscado = normalizarNit(solicitud.proveedor_nit)
    const porNit = proveedores.find((p) => normalizarNit(p.nit) === nitBuscado) ?? null
    return { proveedor: porNit, buscadoPor: "nit" }
  }
  const nombreBuscado = normalizarTexto(solicitud.proveedor_nombre)
  const porNombre =
    proveedores.find((p) => normalizarTexto(p.nombre) === nombreBuscado) ?? null
  return { proveedor: porNombre, buscadoPor: "nombre" }
}

function ejecutarLeerPaquete(directory: string, casoInput: string): PaqueteNormalizado {
  const caso = normalizarCasoId(casoInput)
  const carpetaCaso = join(directory, "fixtures", "reto-03", "solicitudes", caso)
  if (!existsSync(carpetaCaso)) {
    throw new Error(`No existe la carpeta del caso "${caso}" en fixtures/reto-03/solicitudes/.`)
  }

  const rutaCorreo = join(carpetaCaso, "correo.json")
  const rutaSolicitud = join(carpetaCaso, "solicitud.json")
  if (!existsSync(rutaCorreo)) {
    throw new Error(`El paquete "${caso}" está incompleto: falta correo.json.`)
  }
  if (!existsSync(rutaSolicitud)) {
    throw new Error(`El paquete "${caso}" está incompleto: falta solicitud.json.`)
  }

  let correoRaw: CorreoFixture
  let solicitudRaw: SolicitudFixture
  try {
    correoRaw = JSON.parse(readFileSync(rutaCorreo, "utf-8")) as CorreoFixture
  } catch (err) {
    throw new Error(
      `correo.json malformado en "${caso}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  try {
    solicitudRaw = JSON.parse(readFileSync(rutaSolicitud, "utf-8")) as SolicitudFixture
  } catch (err) {
    throw new Error(
      `solicitud.json malformado en "${caso}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (
    typeof solicitudRaw.cantidad !== "number" ||
    !Number.isFinite(solicitudRaw.cantidad) ||
    typeof solicitudRaw.valor_unitario !== "number" ||
    !Number.isFinite(solicitudRaw.valor_unitario) ||
    typeof solicitudRaw.valor_total !== "number" ||
    !Number.isFinite(solicitudRaw.valor_total)
  ) {
    throw new Error(
      `Monto o cantidad no numérica en solicitud.json de "${caso}". Solicite al usuario corregir el archivo Excel de solicitud.`,
    )
  }

  const adjuntosFaltantes: string[] = []

  const rutaCotizacion = join(carpetaCaso, "cotizacion.txt")
  let cotizacion: CotizacionNormalizada | null = null
  if (existsSync(rutaCotizacion)) {
    cotizacion = parsearCotizacionTxt(readFileSync(rutaCotizacion, "utf-8"))
  } else {
    adjuntosFaltantes.push("cotizacion.pdf")
  }

  const rutaAprobacion = join(carpetaCaso, "aprobacion.json")
  let aprobacion: AprobacionNormalizada | null = null
  if (existsSync(rutaAprobacion)) {
    const aprobRaw = JSON.parse(readFileSync(rutaAprobacion, "utf-8")) as {
      de: string
      para?: string
      cc?: string[]
      fecha: string
      asunto?: string
      cuerpo: string
    }
    aprobacion = {
      de: aprobRaw.de,
      para: aprobRaw.para ?? "",
      cc: aprobRaw.cc ?? [],
      asunto: aprobRaw.asunto ?? "",
      fecha: aprobRaw.fecha,
      aprobado: /\baprobado\b/i.test(aprobRaw.cuerpo),
      texto: aprobRaw.cuerpo,
    }
  } else {
    adjuntosFaltantes.push("aprobacion.eml")
  }

  const rutaFactura = join(carpetaCaso, "factura.txt")
  let factura: FacturaNormalizada | null = null
  if (existsSync(rutaFactura)) {
    factura = parsearFacturaTxt(readFileSync(rutaFactura, "utf-8"))
  }

  const solicitudNormalizada: SolicitudFixture = {
    ...solicitudRaw,
    proveedor_nit: solicitudRaw.proveedor_nit
      ? normalizarNit(solicitudRaw.proveedor_nit)
      : undefined,
  }

  return {
    caso,
    correo: {
      id: correoRaw.id,
      de: correoRaw.de,
      asunto: correoRaw.asunto,
      fecha: correoRaw.fecha,
    },
    solicitud: solicitudNormalizada,
    cotizacion,
    aprobacion,
    factura,
    adjuntos_faltantes: adjuntosFaltantes,
  }
}

function ejecutarValidar(directory: string, casoInput: string): ResultadoValidacion {
  const paquete = ejecutarLeerPaquete(directory, casoInput)
  const { solicitud, cotizacion, aprobacion, factura } = paquete
  const { proveedores, centrosCosto, indicadoresIva, condicionesPago } = cargarMaestros(directory)

  const bloqueos: string[] = []
  const confirmaciones: string[] = []
  const derivados: Record<string, string> = {}
  let retroactiva = false

  // RC1: Proveedor en maestro y activo
  const { proveedor, buscadoPor } = buscarProveedorEnMaestro(solicitud, proveedores)
  if (!proveedor) {
    const criterio =
      buscadoPor === "nit"
        ? `NIT ${solicitud.proveedor_nit}`
        : `nombre "${solicitud.proveedor_nombre}"`
    bloqueos.push(
      `[RC1] Proveedor "${solicitud.proveedor_nombre}" (${criterio}) no existe en el maestro de proveedores SAP. Acción sugerida: solicitar creación/alta del proveedor en SAP con RUT, cámara de comercio y certificación bancaria antes de generar la OC.`,
    )
  } else if (!proveedor.activo) {
    bloqueos.push(
      `[RC1] Proveedor "${proveedor.nombre}" (SAP ${proveedor.codigo_sap}, NIT ${proveedor.nit}) figura INACTIVO en el maestro de proveedores. Acción sugerida: solicitar reactivación del proveedor a Datos Maestros.`,
    )
  } else {
    derivados.codigo_sap = proveedor.codigo_sap
    if (!solicitud.proveedor_nit) {
      derivados.proveedor_nit = proveedor.nit
    }
  }

  // Centro de costo para RC2, RC3, RC4
  const centroMaestro =
    centrosCosto.find((c) => c.centro_costo === solicitud.centro_costo) ?? null

  if (!centroMaestro) {
    bloqueos.push(
      `[RC2/RC4] El centro de costo "${solicitud.centro_costo}" no existe en el maestro de centros de costo. Acción sugerida: verificar la imputación contable con el solicitante.`,
    )
  } else {
    // RC2: Aprobación existe, contiene "Aprobado" y viene de aprobador autorizado del centro_costo
    if (!aprobacion) {
      bloqueos.push(
        `[RC2] No se encontró correo de aprobación adjunto. Acción sugerida: solicitar el correo de aprobación de un líder autorizado para ${centroMaestro.centro_costo} (${centroMaestro.nombre}).`,
      )
    } else {
      if (!aprobacion.aprobado) {
        bloqueos.push(
          `[RC2] El correo de ${aprobacion.de} no contiene la palabra "Aprobado". Acción sugerida: solicitar aprobación explícita del líder.`,
        )
      }
      const aprobadorAutorizado = centroMaestro.aprobadores.find(
        (a) => a.email.toLowerCase() === aprobacion.de.toLowerCase(),
      )
      if (!aprobadorAutorizado) {
        const listaAutorizados = centroMaestro.aprobadores
          .map((a) => `${a.nombre} <${a.email}> (tope ${a.tope.toLocaleString("es-CO")})`)
          .join(", ")
        bloqueos.push(
          `[RC2] El aprobador "${aprobacion.de}" no tiene autoridad en el centro de costo ${centroMaestro.centro_costo} (${centroMaestro.nombre}). Aprobadores autorizados: ${listaAutorizados}. Acción sugerida: escalar la solicitud al aprobador correspondiente del centro ${centroMaestro.centro_costo}.`,
        )

        // RC3 adicional: verificar si el monto también excede el tope máximo del centro de costo
        const topeMaximoCentro = Math.max(...centroMaestro.aprobadores.map((a) => a.tope))
        if (solicitud.valor_total > topeMaximoCentro) {
          bloqueos.push(
            `[RC3] El valor total de la solicitud (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}) supera el tope máximo de aprobación configurado en ${centroMaestro.centro_costo} (${solicitud.moneda} ${topeMaximoCentro.toLocaleString("es-CO")}). Acción sugerida: requerir aprobación de Gerencia General / Comité de Compras o reimputar al centro de costo correcto.`,
          )
        }
      } else {
        // RC3: valor_total <= tope del aprobador para ese centro
        if (solicitud.valor_total > aprobadorAutorizado.tope) {
          bloqueos.push(
            `[RC3] El valor total (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}) excede el tope autorizado de ${aprobadorAutorizado.nombre} (${aprobadorAutorizado.email}) en ${centroMaestro.centro_costo}, que es ${solicitud.moneda} ${aprobadorAutorizado.tope.toLocaleString("es-CO")}. Acción sugerida: solicitar aprobación de un líder de nivel superior en ${centroMaestro.centro_costo}.`,
          )
        }
      }
    }

    // RC4: subarea pertenece al centro_costo
    if (!centroMaestro.subareas.includes(solicitud.subarea)) {
      bloqueos.push(
        `[RC4] La subárea "${solicitud.subarea}" no pertenece al centro de costo ${centroMaestro.centro_costo} (${centroMaestro.nombre}). Subáreas válidas: ${centroMaestro.subareas.join(", ")}. Acción sugerida: corregir la subárea o el centro de costo en la solicitud.`,
      )
    }
  }

  // RC5: Cotización presente y diferencia <= 2%
  if (!cotizacion) {
    confirmaciones.push(
      `[RC5] No se adjuntó cotización del proveedor (cotizacion.pdf ausente). Se requiere confirmación humana para crear la OC sin soporte de cotización.`,
    )
  } else if (solicitud.valor_total > 0) {
    const diferenciaAbs = Math.abs(cotizacion.total - solicitud.valor_total)
    const ratio = diferenciaAbs / solicitud.valor_total
    if (ratio > 0.02) {
      const porcentaje = (ratio * 100).toFixed(2)
      confirmaciones.push(
        `[RC5] Diferencia del ${porcentaje}% (> 2%) entre el total de la cotización (${cotizacion.moneda} ${cotizacion.total.toLocaleString("es-CO")}) y el valor de la solicitud (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}). Confirme si desea proceder con el monto aprobado en la solicitud (${solicitud.moneda} ${solicitud.valor_total.toLocaleString("es-CO")}).`,
      )
    }
  }

  // RC6: indicador_iva ausente -> se deriva del proveedor y pide confirmación
  if (!solicitud.indicador_iva || solicitud.indicador_iva.trim().length === 0) {
    if (proveedor) {
      const codigoIva = proveedor.indicador_iva_default
      const infoIva = indicadoresIva.find((i) => i.codigo === codigoIva)
      derivados.indicador_iva = codigoIva
      confirmaciones.push(
        `[RC6] Indicador de IVA no informado en la solicitud; se derivó "${codigoIva}" (${infoIva?.descripcion ?? "IVA por defecto"}) desde el maestro del proveedor "${proveedor.nombre}". Confirme si autoriza usar este indicador.`,
      )
    }
  }

  // RC7: condiciones_pago ausente -> se deriva del proveedor (solo se informa)
  if (!solicitud.condiciones_pago || solicitud.condiciones_pago.trim().length === 0) {
    if (proveedor) {
      const codigoCondicion = proveedor.condiciones_pago_default
      const infoCondicion = condicionesPago.find((c) => c.codigo === codigoCondicion)
      derivados.condiciones_pago = infoCondicion
        ? `${codigoCondicion} (${infoCondicion.descripcion})`
        : codigoCondicion
    }
  }

  // RC8: Factura con fecha < fecha_solicitud -> retroactiva = true + confirmación
  if (factura && factura.fecha && factura.fecha < solicitud.fecha_solicitud) {
    retroactiva = true
    confirmaciones.push(
      `[RC8] Orden de compra retroactiva detectada: la factura ${factura.numero} tiene fecha de emisión ${factura.fecha}, anterior a la fecha de la solicitud (${solicitud.fecha_solicitud}). Confirme la creación marcando retroactiva = true en el registro de control.`,
    )
  }

  // RC9: Fecha de aprobación >= fecha_solicitud
  if (aprobacion && aprobacion.fecha) {
    const fechaAprobIso = aprobacion.fecha.slice(0, 10)
    if (fechaAprobIso < solicitud.fecha_solicitud) {
      confirmaciones.push(
        `[RC9] La fecha del correo de aprobación (${fechaAprobIso}) es anterior a la fecha de la solicitud (${solicitud.fecha_solicitud}). Confirme si desea continuar.`,
      )
    }
  }

  // RC10: cantidad * valor_unitario == valor_total (± 1 unidad monetaria)
  const totalCalculado = solicitud.cantidad * solicitud.valor_unitario
  if (Math.abs(totalCalculado - solicitud.valor_total) > 1) {
    bloqueos.push(
      `[RC10] Inconsistencia aritmética en la solicitud: cantidad (${solicitud.cantidad}) × valor_unitario (${solicitud.valor_unitario.toLocaleString("es-CO")}) = ${totalCalculado.toLocaleString("es-CO")}, diferente de valor_total (${solicitud.valor_total.toLocaleString("es-CO")}). Acción sugerida: corregir el Excel de solicitud.`,
    )
  }

  return {
    caso: paquete.caso,
    solicitud_id: solicitud.solicitud_id,
    apta: bloqueos.length === 0,
    bloqueos,
    confirmaciones,
    derivados,
    retroactiva,
  }
}

function sanitizarTextoWinAnsi(texto: string): string {
  return texto
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "")
}

async function ejecutarGenerarEvidencia(
  directory: string,
  casoInput: string,
): Promise<{
  ruta_txt: string
  ruta_pdf: string
  ruta: string
  sha256: string
}> {
  const paquete = ejecutarLeerPaquete(directory, casoInput)
  const { caso, solicitud, aprobacion } = paquete
  if (!aprobacion) {
    throw new Error(`No existe correo de aprobación para el caso "${caso}".`)
  }

  const lineasContenido = [
    "======================================================================",
    "          EVIDENCIA DE APROBACIÓN DE ORDEN DE COMPRA - SAP            ",
    "======================================================================",
    `Solicitud ID : ${solicitud.solicitud_id}`,
    `Caso         : ${caso}`,
    `De           : ${aprobacion.de}`,
    `Para         : ${aprobacion.para}`,
    `CC           : ${aprobacion.cc.join(", ") || "N/A"}`,
    `Fecha        : ${aprobacion.fecha}`,
    `Asunto       : ${aprobacion.asunto}`,
    "----------------------------------------------------------------------",
    "CUERPO DEL MENSAJE:",
    "",
    aprobacion.texto,
    "",
    "----------------------------------------------------------------------",
  ]
  const cuerpoBase = lineasContenido.join("\n")
  const sha256 = createHash("sha256").update(cuerpoBase, "utf-8").digest("hex")

  const textoFinal = `${cuerpoBase}\nSHA-256      : ${sha256}\n======================================================================\n`

  const dirCasoOut = join(directory, "out", caso)
  mkdirSync(dirCasoOut, { recursive: true })

  const rutaTxtAbs = join(dirCasoOut, "aprobacion.txt")
  const rutaPdfAbs = join(dirCasoOut, "aprobacion.pdf")
  writeFileSync(rutaTxtAbs, textoFinal, "utf-8")

  // P1: Generar PDF con pdf-lib
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595.28, 841.89]) // A4
  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const { width, height } = page.getSize()
  let y = height - 50

  page.drawRectangle({
    x: 40,
    y: height - 95,
    width: width - 80,
    height: 55,
    color: rgb(0.07, 0.16, 0.29),
  })

  page.drawText("PERIFERIA IT GROUP - EVIDENCIA DE APROBACION SAP", {
    x: 55,
    y: height - 68,
    size: 13,
    font: fontBold,
    color: rgb(1, 1, 1),
  })

  page.drawText(`Solicitud: ${solicitud.solicitud_id}  |  Caso: ${caso}`, {
    x: 55,
    y: height - 85,
    size: 10,
    font: fontRegular,
    color: rgb(0.82, 0.88, 0.96),
  })

  y = height - 125
  const metadatos: Array<[string, string]> = [
    ["De:", aprobacion.de],
    ["Para:", aprobacion.para],
    ["CC:", aprobacion.cc.join(", ") || "N/A"],
    ["Fecha:", aprobacion.fecha],
    ["Asunto:", aprobacion.asunto],
    ["Estado:", aprobacion.aprobado ? "APROBADO" : "NO APROBADO"],
  ]

  for (const [etiqueta, valor] of metadatos) {
    page.drawText(sanitizarTextoWinAnsi(etiqueta), {
      x: 45,
      y,
      size: 10,
      font: fontBold,
      color: rgb(0.15, 0.2, 0.28),
    })
    page.drawText(sanitizarTextoWinAnsi(valor), {
      x: 115,
      y,
      size: 10,
      font: fontRegular,
      color: rgb(0.1, 0.1, 0.1),
    })
    y -= 18
  }

  y -= 10
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 1,
    color: rgb(0.75, 0.78, 0.82),
  })

  y -= 25
  page.drawText("CUERPO DEL CORREO DE APROBACION:", {
    x: 45,
    y,
    size: 10,
    font: fontBold,
    color: rgb(0.15, 0.2, 0.28),
  })

  y -= 20
  const parrafos = aprobacion.texto.split(/\r?\n/)
  for (const parrafo of parrafos) {
    const limpio = sanitizarTextoWinAnsi(parrafo)
    if (limpio.length === 0) {
      y -= 12
      continue
    }
    const maxChars = 78
    for (let i = 0; i < limpio.length; i += maxChars) {
      const segmento = limpio.slice(i, i + maxChars)
      page.drawText(segmento, {
        x: 45,
        y,
        size: 10,
        font: fontRegular,
        color: rgb(0.12, 0.12, 0.12),
      })
      y -= 15
    }
  }

  y -= 20
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 1,
    color: rgb(0.75, 0.78, 0.82),
  })

  y -= 22
  page.drawText("HUELLA DIGITAL DE INTEGRIDAD (SHA-256):", {
    x: 45,
    y,
    size: 9,
    font: fontBold,
    color: rgb(0.25, 0.3, 0.38),
  })
  y -= 15
  page.drawText(sha256, {
    x: 45,
    y,
    size: 8.5,
    font: fontRegular,
    color: rgb(0.2, 0.2, 0.2),
  })

  const pdfBytes = await pdfDoc.save()
  writeFileSync(rutaPdfAbs, pdfBytes)

  const rutaTxtRel = `out/${caso}/aprobacion.txt`
  const rutaPdfRel = `out/${caso}/aprobacion.pdf`
  return {
    ruta_txt: rutaTxtRel,
    ruta_pdf: rutaPdfRel,
    ruta: rutaPdfRel,
    sha256,
  }
}

function inferirUnidadSap(descripcion: string): "UN" | "H" | "MES" {
  const desc = descripcion.toLowerCase()
  if (/\bhoras?\b/.test(desc)) {
    return "H"
  }
  if (
    /\bmes(?:es)?\b/.test(desc) &&
    !/\bpuestos?\b|\blicencias?\b|\busuarios?\b|\bdiademas?\b|\bsillas?\b/.test(desc)
  ) {
    return "MES"
  }
  return "UN"
}

function extraerCodigoRegla(mensajeConfirmacion: string): string {
  const match = mensajeConfirmacion.match(/^\[(RC\d+)\]/)
  return match?.[1] ?? "EXCEPCION"
}

async function ejecutarConstruirPayload(
  directory: string,
  casoInput: string,
  confirmadoPor?: string,
): Promise<{
  payload: OrdenCompra
  ruta_trazabilidad: string
  trazabilidad: Record<string, EntradaTrazabilidad>
}> {
  const paquete = ejecutarLeerPaquete(directory, casoInput)
  const validacion = ejecutarValidar(directory, casoInput)
  const { proveedores } = cargarMaestros(directory)
  const { proveedor } = buscarProveedorEnMaestro(paquete.solicitud, proveedores)

  const evidencia = await ejecutarGenerarEvidencia(directory, paquete.caso)

  const codigoSap = proveedor?.codigo_sap ?? validacion.derivados.codigo_sap ?? "000000"
  const nitProveedor =
    paquete.solicitud.proveedor_nit ??
    proveedor?.nit ??
    paquete.cotizacion?.nit ??
    "000000000"
  const fuenteNit: FuenteTrazabilidad = paquete.solicitud.proveedor_nit
    ? "solicitud"
    : proveedor
      ? "maestro.proveedores"
      : "cotizacion"

  const condicionesPago =
    paquete.solicitud.condiciones_pago ?? proveedor?.condiciones_pago_default ?? "Z030"
  const fuenteCondicionesPago: FuenteTrazabilidad = paquete.solicitud.condiciones_pago
    ? "solicitud"
    : "derivado"

  const indicadorIva =
    paquete.solicitud.indicador_iva ?? proveedor?.indicador_iva_default ?? "C1"
  const fuenteIndicadorIva: FuenteTrazabilidad = paquete.solicitud.indicador_iva
    ? "solicitud"
    : "derivado"

  const descripcionCorta = paquete.solicitud.descripcion.slice(0, 40)
  const unidadInferida = inferirUnidadSap(paquete.solicitud.descripcion)

  const excepciones: ExcepcionOrdenCompra[] = validacion.confirmaciones.map((detalle) => ({
    codigo: extraerCodigoRegla(detalle),
    detalle,
    confirmado_por: confirmadoPor ?? null,
  }))

  const ordenSinValidar: OrdenCompra = {
    referencia: {
      solicitud_id: paquete.solicitud.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.cotizacion_ref ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: codigoSap,
      nit: nitProveedor,
      nombre: proveedor?.nombre ?? paquete.solicitud.proveedor_nombre,
    },
    moneda: paquete.solicitud.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: paquete.aprobacion?.de ?? "sin-aprobador@periferia-ficticia.com",
      fecha_aprobacion: paquete.aprobacion?.fecha ?? "",
      evidencia_sha256: evidencia.sha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion: descripcionCorta,
        cantidad: paquete.solicitud.cantidad,
        unidad: unidadInferida,
        precio_unitario: paquete.solicitud.valor_unitario,
        centro_costo: paquete.solicitud.centro_costo,
        subarea: paquete.solicitud.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones,
  }

  const payload = OrdenCompraSchema.parse(ordenSinValidar)

  const trazabilidad: Record<string, EntradaTrazabilidad> = {
    "referencia.solicitud_id": {
      valor: payload.referencia.solicitud_id,
      fuente: "solicitud",
    },
    "referencia.correo_id": {
      valor: payload.referencia.correo_id,
      fuente: "solicitud",
    },
    "referencia.cotizacion_ref": {
      valor: payload.referencia.cotizacion_ref,
      fuente: paquete.cotizacion ? "cotizacion" : "derivado",
    },
    sociedad: {
      valor: payload.sociedad,
      fuente: "derivado",
    },
    organizacion_compras: {
      valor: payload.organizacion_compras,
      fuente: "derivado",
    },
    "proveedor.codigo_sap": {
      valor: payload.proveedor.codigo_sap,
      fuente: "maestro.proveedores",
    },
    "proveedor.nit": {
      valor: payload.proveedor.nit,
      fuente: fuenteNit,
    },
    "proveedor.nombre": {
      valor: payload.proveedor.nombre,
      fuente: proveedor ? "maestro.proveedores" : "solicitud",
    },
    moneda: {
      valor: payload.moneda,
      fuente: "solicitud",
    },
    condiciones_pago: {
      valor: payload.condiciones_pago,
      fuente: fuenteCondicionesPago,
    },
    "aprobador.email": {
      valor: payload.aprobador.email,
      fuente: "maestro.centros-costo",
    },
    "aprobador.fecha_aprobacion": {
      valor: payload.aprobador.fecha_aprobacion,
      fuente: "solicitud",
    },
    "aprobador.evidencia_sha256": {
      valor: payload.aprobador.evidencia_sha256,
      fuente: "derivado",
    },
    "posiciones[0].numero": {
      valor: payload.posiciones[0]?.numero,
      fuente: "derivado",
    },
    "posiciones[0].descripcion": {
      valor: payload.posiciones[0]?.descripcion,
      fuente: "solicitud",
    },
    "posiciones[0].cantidad": {
      valor: payload.posiciones[0]?.cantidad,
      fuente: "solicitud",
    },
    "posiciones[0].unidad": {
      valor: payload.posiciones[0]?.unidad,
      fuente: "derivado",
    },
    "posiciones[0].precio_unitario": {
      valor: payload.posiciones[0]?.precio_unitario,
      fuente: "solicitud",
    },
    "posiciones[0].centro_costo": {
      valor: payload.posiciones[0]?.centro_costo,
      fuente: "solicitud",
    },
    "posiciones[0].subarea": {
      valor: payload.posiciones[0]?.subarea,
      fuente: "solicitud",
    },
    "posiciones[0].indicador_iva": {
      valor: payload.posiciones[0]?.indicador_iva,
      fuente: fuenteIndicadorIva,
    },
    excepciones: {
      valor: payload.excepciones,
      fuente: "derivado",
    },
  }

  const dirCasoOut = join(directory, "out", paquete.caso)
  mkdirSync(dirCasoOut, { recursive: true })
  const rutaTrazabilidadAbs = join(dirCasoOut, "trazabilidad.json")
  writeFileSync(rutaTrazabilidadAbs, JSON.stringify(trazabilidad, null, 2), "utf-8")

  const rutaTrazabilidadRel = `out/${paquete.caso}/trazabilidad.json`
  return {
    payload,
    ruta_trazabilidad: rutaTrazabilidadRel,
    trazabilidad,
  }
}

function escaparCampoCsv(valor: string): string {
  const limpio = valor.replace(/\r?\n/g, " ")
  if (limpio.includes(",") || limpio.includes('"') || limpio.includes(";")) {
    return `"${limpio.replace(/"/g, '""')}"`
  }
  return limpio
}

function registrarEnControlCsv(
  directory: string,
  fila: {
    solicitud_id: string
    resultado: string
    numero_oc: string
    retroactiva: boolean
    bloqueos: string[]
    confirmaciones: string[]
  },
): void {
  const rutaControl = join(directory, "out", "control.csv")
  mkdirSync(dirname(rutaControl), { recursive: true })
  const encabezado = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n"
  if (!existsSync(rutaControl)) {
    writeFileSync(rutaControl, encabezado, "utf-8")
  }
  const campos = [
    escaparCampoCsv(fila.solicitud_id),
    escaparCampoCsv(fila.resultado),
    escaparCampoCsv(fila.numero_oc),
    String(fila.retroactiva),
    escaparCampoCsv(fila.bloqueos.map(extraerCodigoRegla).join("|") || "NINGUNO"),
    escaparCampoCsv(fila.confirmaciones.map(extraerCodigoRegla).join("|") || "NINGUNA"),
    new Date().toISOString(),
  ]
  appendFileSync(rutaControl, campos.join(",") + "\n", "utf-8")
}

// ============================================================================
// Herramientas exportadas según contrato de sección 6.2 (cada export -> oc_<export>)
// ============================================================================

export const leer_paquete = {
  description:
    "Lee y normaliza el paquete de compra de un caso (correo, solicitud, cotización, aprobación y factura si existe).",
  args: {
    caso: z
      .string()
      .min(1)
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const data = ejecutarLeerPaquete(ctx.directory, args.caso)
      return JSON.stringify({ ok: true, data })
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}

export const validar = {
  description:
    "Valida una solicitud de orden de compra contra los maestros SAP y aplica las 10 reglas de control RC1 a RC10.",
  args: {
    caso: z
      .string()
      .min(1)
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
    paquete: z
      .unknown()
      .optional()
      .describe("Paquete normalizado opcional devuelto previamente por oc_leer_paquete"),
  },
  async execute(
    args: { caso: string; paquete?: unknown },
    ctx: ToolContext,
  ): Promise<string> {
    try {
      const data = ejecutarValidar(ctx.directory, args.caso)
      return JSON.stringify({ ok: true, data })
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}

export const construir_payload = {
  description:
    "Construye el payload SAP validado con zod para la Orden de Compra y guarda la matriz de trazabilidad campo por campo en out/<caso>/trazabilidad.json.",
  args: {
    caso: z
      .string()
      .min(1)
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
    paquete: z
      .unknown()
      .optional()
      .describe("Paquete normalizado opcional devuelto por oc_leer_paquete"),
    derivados: z
      .record(z.string())
      .optional()
      .describe("Campos derivados opcionales obtenidos en oc_validar"),
    confirmado_por: z
      .string()
      .optional()
      .describe("Identificador o rol del usuario que confirmó las excepciones (si aplica)"),
  },
  async execute(
    args: {
      caso: string
      paquete?: unknown
      derivados?: Record<string, string>
      confirmado_por?: string
    },
    ctx: ToolContext,
  ): Promise<string> {
    try {
      const data = await ejecutarConstruirPayload(
        ctx.directory,
        args.caso,
        args.confirmado_por,
      )
      return JSON.stringify({ ok: true, data })
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}

export const generar_evidencia = {
  description:
    "Genera la evidencia de aprobación del líder en formato TXT (P0) y PDF (P1) dentro de out/<caso>/ con su hash de integridad SHA-256.",
  args: {
    caso: z
      .string()
      .min(1)
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
  },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      const data = await ejecutarGenerarEvidencia(ctx.directory, args.caso)
      return JSON.stringify({ ok: true, data })
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}

export const crear = {
  description:
    "Crea la Orden de Compra en el adaptador SAP simulado únicamente si apta=true y no hay confirmaciones pendientes (o confirmado=true), registrando la auditoría en out/control.csv.",
  args: {
    caso: z
      .string()
      .min(1)
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/ (ej. sol-001)"),
    payload: z
      .unknown()
      .optional()
      .describe("Payload OrdenCompra opcional construido previamente por oc_construir_payload"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true únicamente cuando la analista humana confirmó explícitamente las excepciones"),
    confirmado_por: z
      .string()
      .optional()
      .describe("Correo o identificador de la analista que confirmó las excepciones"),
  },
  async execute(
    args: {
      caso: string
      payload?: unknown
      confirmado?: boolean
      confirmado_por?: string
    },
    ctx: ToolContext,
  ): Promise<string> {
    try {
      const validacion = ejecutarValidar(ctx.directory, args.caso)

      if (!validacion.apta) {
        registrarEnControlCsv(ctx.directory, {
          solicitud_id: validacion.solicitud_id,
          resultado: "BLOQUEADA",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos,
          confirmaciones: validacion.confirmaciones,
        })
        return JSON.stringify({
          ok: false,
          error: "No se puede crear la OC: existen bloqueos de control.",
          data: {
            solicitud_id: validacion.solicitud_id,
            resultado: "BLOQUEADA",
            bloqueos: validacion.bloqueos,
            retroactiva: validacion.retroactiva,
          },
        })
      }

      if (validacion.confirmaciones.length > 0 && !args.confirmado) {
        registrarEnControlCsv(ctx.directory, {
          solicitud_id: validacion.solicitud_id,
          resultado: "PENDIENTE_CONFIRMACION",
          numero_oc: "",
          retroactiva: validacion.retroactiva,
          bloqueos: validacion.bloqueos,
          confirmaciones: validacion.confirmaciones,
        })
        return JSON.stringify({
          ok: false,
          error: "La solicitud requiere confirmación humana explícita antes de crear la OC.",
          data: {
            solicitud_id: validacion.solicitud_id,
            resultado: "PENDIENTE_CONFIRMACION",
            confirmaciones: validacion.confirmaciones,
            retroactiva: validacion.retroactiva,
          },
        })
      }

      const confirmadoPorFinal =
        args.confirmado_por ??
        (args.confirmado && validacion.confirmaciones.length > 0
          ? "analista.compras@periferia-ficticia.com"
          : undefined)

      const evidencia = await ejecutarGenerarEvidencia(ctx.directory, args.caso)
      const construido = await ejecutarConstruirPayload(
        ctx.directory,
        args.caso,
        confirmadoPorFinal,
      )

      const sap = new MockSapAdapter(ctx.directory)
      const previa = await sap.buscarOrdenPorReferencia(
        construido.payload.referencia.solicitud_id,
      )
      const idempotente = previa !== null
      const creada = await sap.crearOrden(construido.payload)

      registrarEnControlCsv(ctx.directory, {
        solicitud_id: validacion.solicitud_id,
        resultado: idempotente ? "CREADA_IDEMPOTENTE" : "CREADA",
        numero_oc: creada.numero_oc,
        retroactiva: validacion.retroactiva,
        bloqueos: validacion.bloqueos,
        confirmaciones: validacion.confirmaciones,
      })

      return JSON.stringify({
        ok: true,
        data: {
          solicitud_id: validacion.solicitud_id,
          numero_oc: creada.numero_oc,
          fecha: creada.fecha,
          idempotente,
          retroactiva: validacion.retroactiva,
          ruta_evidencia_txt: evidencia.ruta_txt,
          ruta_evidencia_pdf: evidencia.ruta_pdf,
          ruta_trazabilidad: construido.ruta_trazabilidad,
          payload: construido.payload,
        },
      })
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}

export const leer_excel = {
  description:
    "Lee un archivo de solicitud en formato Excel (.xlsx), CSV (.csv) o JSON normalizado dentro del proyecto y devuelve sus filas.",
  args: {
    ruta: z
      .string()
      .min(1)
      .describe("Ruta relativa al archivo .xlsx, .csv o .json dentro del proyecto"),
  },
  async execute(args: { ruta: string }, ctx: ToolContext): Promise<string> {
    try {
      const rutaAbs = resolve(ctx.directory, args.ruta)
      if (!rutaAbs.startsWith(resolve(ctx.directory))) {
        return JSON.stringify({
          ok: false,
          error: "Acceso denegado: la ruta debe estar dentro del directorio del proyecto.",
        })
      }
      if (!existsSync(rutaAbs)) {
        return JSON.stringify({
          ok: false,
          error: `No se encontró el archivo en la ruta "${args.ruta}".`,
        })
      }

      if (rutaAbs.endsWith(".json")) {
        const contenido = JSON.parse(readFileSync(rutaAbs, "utf-8")) as unknown
        const filas = Array.isArray(contenido) ? contenido : [contenido]
        return JSON.stringify({ ok: true, data: { ruta: args.ruta, filas } })
      }

      const workbook = XLSX.readFile(rutaAbs)
      const nombreHoja = workbook.SheetNames[0]
      if (!nombreHoja) {
        return JSON.stringify({ ok: true, data: { ruta: args.ruta, filas: [] } })
      }
      const hoja = workbook.Sheets[nombreHoja]
      const filas = hoja ? XLSX.utils.sheet_to_json(hoja) : []
      return JSON.stringify({
        ok: true,
        data: {
          ruta: args.ruta,
          hoja: nombreHoja,
          filas,
        },
      })
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}

export const ocTools = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
  oc_leer_excel: leer_excel,
}
