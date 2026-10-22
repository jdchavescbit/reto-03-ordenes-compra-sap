import { z } from "zod"

export const PosicionOrdenCompraSchema = z.object({
  numero: z.number().int().positive().describe("Número de posición SAP (10, 20, 30...)"),
  descripcion: z
    .string()
    .min(1)
    .max(40)
    .describe("Texto breve de posición en SAP (máximo 40 caracteres)"),
  cantidad: z.number().positive().describe("Cantidad solicitada"),
  unidad: z.enum(["UN", "H", "MES"]).describe("Unidad de medida SAP"),
  precio_unitario: z.number().nonnegative().describe("Precio unitario en la moneda de la orden"),
  centro_costo: z.string().min(1).describe("Código del centro de costo imputado"),
  subarea: z.string().min(1).describe("Subárea asociada al centro de costo"),
  indicador_iva: z.string().min(1).describe("Código del indicador de impuestos SAP (ej. C1)"),
})

export const ExcepcionOrdenCompraSchema = z.object({
  codigo: z.string().min(1).describe("Código de la regla o excepción (ej. RC5, RC6, RC8, RC9)"),
  detalle: z.string().min(1).describe("Descripción detallada de la excepción confirmada"),
  confirmado_por: z.string().nullable().describe("Identificador o rol de quien confirmó la excepción"),
})

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string().min(1),
    correo_id: z.string().min(1),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string().min(1),
    nit: z.string().min(1),
    nombre: z.string().min(1),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: z.string().email(),
    fecha_aprobacion: z.string().min(1),
    evidencia_sha256: z.string().min(1),
  }),
  posiciones: z.array(PosicionOrdenCompraSchema).min(1),
  excepciones: z.array(ExcepcionOrdenCompraSchema),
})

export type PosicionOrdenCompra = z.infer<typeof PosicionOrdenCompraSchema>
export type ExcepcionOrdenCompra = z.infer<typeof ExcepcionOrdenCompraSchema>
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
