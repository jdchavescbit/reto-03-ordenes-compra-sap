import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { OrdenCompra, OrdenCompraSchema, SapAdapter } from "./adapter.ts"

export interface ProveedorMaestro {
  codigo_sap: string
  nit: string
  nombre: string
  condiciones_pago_default: string
  indicador_iva_default: string
  activo: boolean
}

export interface RegistroOrdenSap {
  numero_oc: string
  fecha: string
  orden: OrdenCompra
}

export function normalizarNit(nitRaw: string): string {
  const limpio = nitRaw.replace(/[^0-9-]/g, "")
  const sinDigitoVerificacion = limpio.includes("-") ? (limpio.split("-")[0] ?? limpio) : limpio
  return sinDigitoVerificacion.replace(/\D/g, "")
}

export class MockSapAdapter implements SapAdapter {
  private readonly directory: string
  private readonly ordenesPath: string
  private readonly proveedoresPath: string

  constructor(directory: string) {
    this.directory = directory
    this.ordenesPath = join(this.directory, "out", "sap", "ordenes.jsonl")
    this.proveedoresPath = join(this.directory, "fixtures", "reto-03", "maestros", "proveedores.json")
  }

  private leerProveedores(): ProveedorMaestro[] {
    if (!existsSync(this.proveedoresPath)) {
      return []
    }
    const contenido = readFileSync(this.proveedoresPath, "utf-8")
    return JSON.parse(contenido) as ProveedorMaestro[]
  }

  private leerOrdenesRegistradas(): RegistroOrdenSap[] {
    if (!existsSync(this.ordenesPath)) {
      return []
    }
    const contenido = readFileSync(this.ordenesPath, "utf-8").trim()
    if (!contenido) {
      return []
    }
    return contenido
      .split("\n")
      .filter((linea) => linea.trim().length > 0)
      .map((linea) => JSON.parse(linea) as RegistroOrdenSap)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const nitNormalizado = normalizarNit(nit)
    const proveedores = this.leerProveedores()
    const encontrado = proveedores.find((p) => normalizarNit(p.nit) === nitNormalizado)
    if (!encontrado) {
      return null
    }
    return {
      codigo_sap: encontrado.codigo_sap,
      activo: encontrado.activo,
    }
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha?: string } | null> {
    const ordenes = this.leerOrdenesRegistradas()
    const existente = ordenes.find((item) => item.orden.referencia.solicitud_id === solicitud_id)
    if (!existente) {
      return null
    }
    return {
      numero_oc: existente.numero_oc,
      fecha: existente.fecha,
    }
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const ordenValidada = OrdenCompraSchema.parse(orden)
    const ordenes = this.leerOrdenesRegistradas()
    const existente = ordenes.find(
      (item) => item.orden.referencia.solicitud_id === ordenValidada.referencia.solicitud_id,
    )
    if (existente) {
      return {
        numero_oc: existente.numero_oc,
        fecha: existente.fecha,
      }
    }

    const numeroSecuencial = String(4500000001 + ordenes.length)
    const fechaCreacion = new Date().toISOString()
    const registro: RegistroOrdenSap = {
      numero_oc: numeroSecuencial,
      fecha: fechaCreacion,
      orden: ordenValidada,
    }

    mkdirSync(dirname(this.ordenesPath), { recursive: true })
    appendFileSync(this.ordenesPath, JSON.stringify(registro) + "\n", "utf-8")

    return {
      numero_oc: numeroSecuencial,
      fecha: fechaCreacion,
    }
  }
}
