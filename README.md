# Reto Técnico 03 — Agente Conversacional "Órdenes de Compra SAP"

> **Periferia IT Group · Equipo Perxia 2.0**
> Agente conversacional de extremo a extremo para automatizar la lectura, validación contra maestros (RC1–RC10), generación de evidencia en PDF/TXT con huella SHA-256 y creación idempotente de Órdenes de Compra en SAP.

---

## 1. Inicio Rápido (Un Solo Comando)

Requisitos previos: **Bun 1.1+** (recomendado) o **Node.js 20+**.

```bash
cp .env.example .env
bun install && bun run dev
```

La aplicación (Frontend interactivo + Backend de ciclo de agente) queda disponible en:

- **Interfaz Web de Chat y Auditoría SAP**: [http://localhost:3000](http://localhost:3000)
- **Healthcheck del Agente**: [http://localhost:3000/api/health](http://localhost:3000/api/health)

> **Nota sobre la clave de modelo LLM**: Si configuras `GEMINI_API_KEY`, `OPENAI_API_KEY` o `ANTHROPIC_API_KEY` en `.env`, el backend utiliza ese proveedor automáticamente. Si no defines ninguna API key en `.env`, el servidor activa el **motor agéntico determinista local multi-turno** (`local-deterministic`) para que puedas probar toda la interfaz, las herramientas tipadas y el flujo de confirmación humana (`CA3`) de inmediato sin fricción.

---

## 2. Verificación sin Modelo (`demo.ts`)

De acuerdo con la sección 6.6 del PRD, `demo.ts` procesa los 6 casos de `fixtures/reto-03/solicitudes/` invocando directamente las herramientas tipadas sin requerir clave de ningún proveedor LLM. Además verifica:
1. **Flujo normal sin intervención (`sol-001`)** → crea `4500000001`.
2. **Idempotencia (`sol-001` ejecutado por segunda vez)** → devuelve la misma OC `4500000001` con `idempotente: true` sin duplicar registro.
3. **Bloqueos de control (`sol-002` y `sol-003`)** → impide la creación y registra el intento bloqueado en `out/control.csv`.
4. **Confirmaciones explícitas (`sol-004`, `sol-005` retroactiva y `sol-006` IVA derivado)** → valida primero que sin confirmación se rechaza (`PENDIENTE_CONFIRMACION`) y luego ejecuta con `confirmado: true`.

```bash
bun install && bun run demo.ts
```

Archivos generados en `out/` tras ejecutar `demo.ts` o usar el chat:
- `out/control.csv` — Log de auditoría y control (`solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts`).
- `out/sap/ordenes.jsonl` — Órdenes creadas en el adaptador SAP simulado.
- `out/<caso>/trazabilidad.json` — Trazabilidad campo por campo (`solicitud`, `cotizacion`, `maestro.<nombre>`, `derivado`).
- `out/<caso>/aprobacion.txt` — Evidencia P0 con encabezados, cuerpo y hash `sha256`.
- `out/<caso>/aprobacion.pdf` — Evidencia P1 en formato PDF generada con `pdf-lib`.
- `out/log.jsonl` — Registro estructurado de cada llamada a herramienta del agente (CA4).

---

## 3. Pruebas Automatizadas y Typecheck

```bash
# Ejecutar suite completa de tests (herramientas, RC1-RC10, idempotencia, PDF, Excel P1 y ciclo del agente)
bun test

# Verificación estática de tipos TypeScript (sin any)
bun run typecheck
```

---

## 4. Variables de Entorno (`.env.example`)

Copia `.env.example` a `.env`. Ninguna clave se expone jamás al navegador, a los logs ni a las respuestas de `/api/*`.

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PORT` | Puerto HTTP del servidor | `3000` |
| `LLM_PROVIDER` | Proveedor LLM: `gemini` \| `openai` \| `anthropic` \| `auto` | `auto` (detecta según API key presente) |
| `LLM_MODEL` | Modelo específico (ej. `gemini-2.5-flash`, `gpt-4o-mini`, `claude-3-5-haiku-latest`) | Según proveedor activo |
| `GEMINI_API_KEY` | Clave de Google Gemini API | *(vacío)* |
| `OPENAI_API_KEY` | Clave de OpenAI / OpenRouter / compatible | *(vacío)* |
| `OPENAI_BASE_URL` | Endpoint compatible OpenAI opcional | `https://api.openai.com/v1` |
| `ANTHROPIC_API_KEY` | Clave de Anthropic API | *(vacío)* |
| `MAX_ITERATIONS_PER_TURN` | Tope de iteraciones herramienta → modelo por turno (CA1) | `25` |
| `MAX_TOKENS_PER_SESSION` | Presupuesto máximo de tokens acumulados por sesión | `120000` |
| `LLM_TIMEOUT_MS` | Timeout por petición al proveedor LLM en milisegundos | `30000` |

---

## 5. Link Público de Prueba

- **URL de despliegue / túnel público**: Configurable mediante `bun run dev` + Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) o despliegue directo en Render / Railway / Fly.io (incluido soporte Node/Bun autónomo en el puerto `$PORT`).
- **Clave de acceso**: No requiere contraseña (acceso directo para evaluación durante la defensa).

---

## 6. Contrato de la API HTTP

| Método | Ruta | Cuerpo / Respuesta |Propósito |
|---|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ ok, sessionId, reply, toolCalls[], needsConfirmation, iterationCount, tokenUsage }` | Ejecuta un turno del ciclo del agente con tope de iteraciones (`CA1`) y detección de confirmación (`CA3`). |
| `GET` | `/api/sessions/:id` | `{ ok, session: { id, messages[], toolCalls[], needsConfirmation, tokenUsage } }` | Devuelve el historial completo de la sesión solicitada. |
| `POST` | `/api/sessions/:id/reset` | `{ ok: true, sessionId }` | Reinicia el estado de la sesión. |
| `GET` | `/api/health` | `{ ok: true, provider, model, maxIterations, maxTokens }` | Estado del servidor y proveedor LLM activo (sin exponer claves). |
| `GET` | `/api/cases` | `{ ok: true, cases: [...] }` | Lista resumen de los 6 casos en `fixtures/reto-03/solicitudes/`. |
| `GET` | `/api/control` | `{ ok: true, controlRows: [...], ordenes: [...] }` | Estado en vivo de `out/control.csv` y `out/sap/ordenes.jsonl`. |
| `GET` | `/out/<caso>/<archivo>` | Archivo estático (`aprobacion.pdf`, `aprobacion.txt`, `trazabilidad.json`) | Descarga o visualización directa de evidencias generadas. |

---

## 7. Estructura del Repositorio

```text
reto-03/
├── agent/
│   └── prompt.md                        # System prompt del agente (Comportamiento, CA1–CA5)
├── src/
│   ├── server.ts                        # Servidor HTTP y endpoints API + estáticos
│   ├── agent.ts                         # Ciclo del agente (bucle, validación zod, log.jsonl, CA1–CA5)
│   ├── llm/
│   │   ├── adapter.ts                   # Interfaz desacoplada LlmAdapter
│   │   └── providers.ts                 # Implementaciones Gemini, OpenAI, Anthropic y fallback determinista
│   ├── tools/
│   │   └── oc.ts                        # Herramientas P0 y P1 (oc_leer_paquete, oc_validar, oc_construir_payload, oc_generar_evidencia, oc_crear, oc_leer_excel)
│   ├── sap/
│   │   ├── adapter.ts                   # Interfaz SapAdapter y esquema zod OrdenCompra (7.4)
│   │   └── mock.ts                      # Implementación SAP simulada e idempotente sobre out/sap/ordenes.jsonl
│   └── knowledge/
│       └── ordenes-compra.md            # Conocimiento de negocio y reglas RC1–RC10
├── modulo/                              # Bonus 9.4: Módulo reutilizable independiente del servidor
│   ├── agent.md                         # Frontmatter + system prompt sincronizado
│   ├── tools/
│   │   └── oc.ts                        # Re-export directo de las herramientas de src/tools/oc.ts
│   └── skill/
│       └── ordenes-compra/
│           └── SKILL.md                 # Frontmatter + conocimiento del proceso
├── web/                                 # Frontend interactivo de chat y auditoría SAP
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── tests/
│   └── oc.test.ts                       # Suite de pruebas automatizadas
├── fixtures/                            # Datos de entrada y maestros provistos para el reto
├── out/                                 # Evidencias, trazabilidad, control.csv y órdenes SAP generadas
├── demo.ts                              # Script de verificación determinista sin modelo (6 casos + idempotencia)
├── .env.example                         # Plantilla de variables de entorno
├── package.json
├── tsconfig.json
├── README.md
└── SOLUCION.md                          # Documento arquitectónico completo (12 secciones + diseño SAP 7.5)
```
