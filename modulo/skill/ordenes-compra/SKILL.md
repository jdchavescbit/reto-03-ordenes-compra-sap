---
name: ordenes-compra
description: Conocimiento del proceso, maestros SAP, reglas de control RC1-RC10 y política de órdenes de compra retroactivas de Periferia IT Group.
---
# Base de Conocimiento — Proceso de Órdenes de Compra SAP (Periferia IT Group)

## 1. Descripción del Proceso y Paquete Documental

Cada solicitud de compra recibida por el área de Administración llega como un paquete documental adjunto a un correo electrónico en `fixtures/reto-03/solicitudes/<caso>/`:

| Pieza del paquete | Archivo | Contenido normalizado | Obligatoriedad |
|---|---|---|---|
| **Correo de remisión** | `correo.json` | `{ id, de, asunto, fecha, cuerpo, adjuntos[] }` | Obligatorio |
| **Solicitud de compra** | `solicitud.json` / `solicitud.xlsx` | `{ solicitud_id, solicitante, proveedor_nombre, proveedor_nit?, descripcion, centro_costo, subarea, cantidad, valor_unitario, valor_total, moneda, indicador_iva?, condiciones_pago?, fecha_solicitud }` | Obligatorio |
| **Cotización del proveedor** | `cotizacion.txt` | Proveedor, NIT, detalle de ítems, subtotal, IVA, total, moneda y validez (`validez_hasta`). | Esperado (si falta, activa confirmación `RC5`) |
| **Correo de aprobación** | `aprobacion.json` | `{ de, para, fecha, asunto, cuerpo }`. Debe contener aprobación explícita ("Aprobado") del líder autorizado. | Obligatorio (`RC2`) |
| **Factura del proveedor** | `factura.txt` | `{ numero, fecha, total }`. Presente únicamente cuando la factura ingresó antes o al momento de tramitar la solicitud. | Opcional (evalúa `RC8`) |

---

## 2. Matriz de Reglas de Control Interno (RC1–RC10)

Las excepciones se clasifican en tres categorías:
- **Bloqueo (`apta = false`)**: Impide de forma absoluta crear la OC en SAP. Se registra el intento como `BLOQUEADA` en `out/control.csv` y se informa al usuario la causa y la gestión correctiva.
- **Confirmación (`apta = true`, `confirmaciones[]` no vacío)**: Detiene la creación automática y exige confirmación explícita (`confirmado = true`) de la analista administrativa en el turno siguiente.
- **Derivado (`derivados{}`)**: Valor ausente en la solicitud que se completa automáticamente desde el maestro correspondiente y se informa de forma transparente.

| Código | Regla de validación | Clasificación | Acción recomendada ante excepción |
|---|---|---|---|
| **RC1** | El proveedor debe existir en `proveedores.json` (búsqueda primaria por `nit`; si no viene NIT en la solicitud, por `nombre` normalizado) y tener estado `activo === true`. | **Bloqueo** | Solicitar al área de Compras la creación o reactivación del proveedor en el maestro de acreedores SAP (transacción `BP` / `XK01`) con su RUT y certificación bancaria antes de reprocesar la solicitud. |
| **RC2** | Debe existir `aprobacion.json`, su cuerpo debe contener la palabra `"Aprobado"` (insensible a mayúsculas/minúsculas) y el remitente (`de`) debe estar listado como aprobador autorizado del `centro_costo` de la solicitud. | **Bloqueo** | Solicitar al solicitante que gestione el correo de aprobación explícito ("Aprobado") emitido desde la cuenta corporativa de un aprobador autorizado para ese centro de costo. |
| **RC3** | El `valor_total` de la solicitud debe ser menor o igual al `tope` de aprobación asignado al aprobador (`de`) dentro del `centro_costo` correspondiente (`valor_total <= tope`). | **Bloqueo** | Escalar la solicitud al aprobador de nivel superior del centro de costo que cuente con cupo/tope suficiente (por ejemplo, en `CC-1010` escalar de `mlopez@periferia-ficticia.com` con tope de $50.000.000 COP a `dgarcia@periferia-ficticia.com` con tope de $200.000.000 COP). |
| **RC4** | La `subarea` indicada en la solicitud debe pertenecer al listado oficial `subareas[]` del `centro_costo` en `centros-costo.json`. | **Bloqueo** | Devolver la solicitud al solicitante para que corrija la imputación contable (centro de costo o subárea válida). |
| **RC5** | Si existe cotización, la desviación relativa `abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total` debe ser `<= 0.02` (2 %). Si supera el 2 % o no se adjuntó cotización (`cotizacion === null`), requiere confirmación mostrando ambos valores. | **Confirmación** | Presentar a la analista tanto el `valor_total` de la solicitud como el `total` de la cotización (y el porcentaje de diferencia) para que confirme si autoriza crear la OC por el valor solicitado o si prefiere devolver el trámite. |
| **RC6** | Si `indicador_iva` está ausente o vacío en la solicitud, se toma del maestro de proveedores (`indicador_iva_default`) y se requiere confirmación humana antes de crear la OC. | **Confirmación + Derivado** | Informar el código e impuesto derivado desde la ficha del proveedor (ej. `C1` — IVA 19 %) y solicitar confirmación explícita a la analista antes de contabilizar la OC. |
| **RC7** | Si `condiciones_pago` está ausente o vacío en la solicitud, se toma del maestro de proveedores (`condiciones_pago_default`). | **Derivado** | Completar el campo automáticamente en el payload SAP e informar el código derivado (ej. `Z030` — 30 días fecha factura) en el resumen de trazabilidad. No bloquea ni detiene el flujo por sí solo. |
| **RC8** | Si existe `factura` en el paquete y `factura.fecha < solicitud.fecha_solicitud`, se marca la orden como compra retroactiva (`retroactiva = true`), se solicita confirmación y se deja trazabilidad en `out/control.csv`. | **Confirmación** | Advertir a la analista que la factura tiene fecha anterior a la solicitud (`retroactiva = true`), mostrar ambas fechas y el número de factura, y pedir confirmación expresa antes de emitir la OC. |
| **RC9** | La fecha del correo de aprobación (`aprobacion.fecha`) debe ser mayor o igual a la fecha de la solicitud (`solicitud.fecha_solicitud`). Si es anterior, requiere confirmación. | **Confirmación** | Mostrar ambas fechas (`fecha_aprobacion` vs. `fecha_solicitud`) y pedir confirmación a la analista para validar que la aprobación corresponde efectivamente a este requerimiento. |
| **RC10** | Consistencia aritmética: `abs(cantidad * valor_unitario - valor_total) <= 1` (tolerancia de ±1 unidad monetaria). Si la diferencia es mayor, se bloquea. | **Bloqueo** | Rechazar la solicitud y pedir al solicitante corregir el archivo de solicitud para que `cantidad × valor_unitario` coincida exactamente con `valor_total`. |

---

## 3. Maestros de Referencia SAP (Periferia IT Group)

### 3.1 Parámetros Organizativos Fijos SAP
- **Sociedad (`BUKRS`)**: `"1000"` (Periferia IT Group Colombia)
- **Organización de Compras (`EKORG`)**: `"1000"` (Compras Nacionales)
- **Longitud máxima texto breve posición (`TXZ01`)**: `40` caracteres
- **Numeración de posiciones (`EBELP`)**: Secuencial en múltiplos de 10 (`10`, `20`, `30`...)
- **Rango de numeración de OC (`EBELN`)**: Secuencial desde `4500000001`

### 3.2 Maestro de Proveedores (`proveedores.json`)

| Código SAP | NIT | Razón Social | Cond. Pago Default | IVA Default | Estado |
|---|---|---|---|---|---|
| `100234` | `900555111` | TecnoSuministros S.A.S. | `Z030` | `C1` | Activo (`true`) |
| `100310` | `901222333` | Cloud Andina S.A.S. | `Z000` | `C1` | Activo (`true`) |
| `100118` | `800444555` | Papelería Central Ltda. | `Z015` | `C1` | Activo (`true`) |
| `100150` | `830111222` | Mobiliario Andino S.A. | `Z030` | `C1` | Activo (`true`) |
| `100402` | `901777888` | Consultores Ágiles S.A.S. | `Z030` | `C1` | **Inactivo (`false`)** |

### 3.3 Maestro de Centros de Costo y Matriz de Aprobación (`centros-costo.json`)

| Centro de Costo | Nombre Área | Subáreas Válidas | Aprobador Autorizado | Email | Tope de Aprobación (COP) |
|---|---|---|---|---|---|
| `CC-1010` | Tecnología | `Infraestructura`, `Soporte`, `Desarrollo` | Mariana López Cárdenas | `mlopez@periferia-ficticia.com` | $50.000.000 |
| `CC-1010` | Tecnología | `Infraestructura`, `Soporte`, `Desarrollo` | Diego García Rincón | `dgarcia@periferia-ficticia.com` | $200.000.000 |
| `CC-2020` | Administración | `Compras`, `Servicios Generales` | Rocío Torres Ibáñez | `rtorres@periferia-ficticia.com` | $30.000.000 |
| `CC-3030` | Comercial | `Preventa`, `Marketing` | Felipe Vargas Ocampo | `fvargas@periferia-ficticia.com` | $80.000.000 |

### 3.4 Maestro de Indicadores de IVA (`indicadores-iva.json`)

| Código SAP | Descripción | Tasa |
|---|---|---|
| `C0` | Excluido / no gravado | 0 % (`0`) |
| `C1` | IVA 19% | 19 % (`0.19`) |
| `C2` | IVA 5% | 5 % (`0.05`) |

### 3.5 Maestro de Condiciones de Pago (`condiciones-pago.json`)

| Código SAP | Descripción | Plazo (días) |
|---|---|---|
| `Z000` | Pago inmediato | `0` |
| `Z015` | 15 días fecha factura | `15` |
| `Z030` | 30 días fecha factura | `30` |
| `Z060` | 60 días fecha factura | `60` |

---

## 4. Política sobre Órdenes de Compra Retroactivas (`retroactiva = true`)

1. **Definición**: Una Orden de Compra es **retroactiva** cuando el proveedor ya emitió la factura (`factura.fecha`) en una fecha anterior a la elaboración de la solicitud interna (`solicitud.fecha_solicitud`).
2. **Riesgo operativo y financiero**:
   - Compromete recursos de la compañía sin validación presupuestaria previa.
   - Omite la negociación competitiva y la comparación de cotizaciones.
   - Genera fricciones en el cierre contable y hallazgos de auditoría interna.
3. **Tratamiento en el agente**:
   - La regla **RC8** detecta automáticamente `factura.fecha < solicitud.fecha_solicitud` y activa el indicador `retroactiva = true`.
   - Exige confirmación explícita de la analista antes de emitir la OC en SAP.
   - Registra la marca `retroactiva = true` en `out/control.csv` y registra la excepción `RC8` dentro del arreglo `excepciones[]` del payload SAP con el identificador de confirmación para que Dirección y Auditoría midan el porcentaje de desvío por centro de costo y solicitante.
