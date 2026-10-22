// Client-side application for Agente Conversacional Órdenes de Compra SAP (Reto 03)

const OFFICIAL_DEMO_PROMPT =
  'Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.';

const DEFAULT_CASES_META = {
  "sol-001": { tag: "Flujo Normal (O1)", badgeClass: "badge-ok" },
  "sol-002": { tag: "Bloqueo RC1", badgeClass: "badge-block" },
  "sol-003": { tag: "Bloqueo RC2/RC3", badgeClass: "badge-block" },
  "sol-004": { tag: "Confirmación RC5", badgeClass: "badge-warn" },
  "sol-005": { tag: "Retroactiva RC8", badgeClass: "badge-warn" },
  "sol-006": { tag: "Derivado IVA RC6", badgeClass: "badge-warn" },
};

const FALLBACK_CASES = [
  {
    id: "sol-001",
    solicitud_id: "SOL-2026-001",
    proveedor: "TecnoSuministros S.A.S.",
    monto: 11400000,
    moneda: "COP",
    centro_costo: "CC-1010",
    descripcion: "Renovación licencias antivirus corporativo 120 puestos, vigencia 12 meses",
  },
  {
    id: "sol-002",
    solicitud_id: "SOL-2026-002",
    proveedor: "Soluciones Digitales del Norte S.A.S.",
    monto: 8500000,
    moneda: "COP",
    centro_costo: "CC-1010",
    descripcion: "Licencia anual herramienta de pruebas automatizadas, 5 usuarios",
  },
  {
    id: "sol-003",
    solicitud_id: "SOL-2026-003",
    proveedor: "Mobiliario Andino S.A.",
    monto: 74000000,
    moneda: "COP",
    centro_costo: "CC-2020",
    descripcion: "Mobiliario para nueva sede: 40 puestos de trabajo con silla ergonómica",
  },
  {
    id: "sol-004",
    solicitud_id: "SOL-2026-004",
    proveedor: "Cloud Andina S.A.S.",
    monto: 25000000,
    moneda: "COP",
    centro_costo: "CC-1010",
    descripcion: "Bolsa de 100 horas de arquitectura de nube para migración",
  },
  {
    id: "sol-005",
    solicitud_id: "SOL-2026-005",
    proveedor: "Papelería Central Ltda.",
    monto: 3200000,
    moneda: "COP",
    centro_costo: "CC-2020",
    descripcion: "Papelería y tóner para el trimestre",
  },
  {
    id: "sol-006",
    solicitud_id: "SOL-2026-006",
    proveedor: "TecnoSuministros S.A.S.",
    monto: 5400000,
    moneda: "COP",
    centro_costo: "CC-1010",
    descripcion: "Diademas con micrófono para la mesa de soporte",
  },
];

let state = {
  sessionId: getOrCreateSessionId(),
  busy: false,
  needsConfirmation: false,
  cases: FALLBACK_CASES,
};

// DOM Elements
const elHealthDot = document.getElementById("health-dot");
const elHealthText = document.getElementById("health-text");
const elSessionId = document.getElementById("session-id-display");
const elCasesList = document.getElementById("cases-list");
const elCasesTotalTag = document.getElementById("cases-total-tag");
const elChatMessages = document.getElementById("chat-messages");
const elThinkingBar = document.getElementById("thinking-bar");
const elConfirmationBanner = document.getElementById("confirmation-banner");
const elChatForm = document.getElementById("chat-form");
const elChatInput = document.getElementById("chat-input");
const elBtnSend = document.getElementById("btn-send");
const elBtnOfficialDemo = document.getElementById("btn-official-demo");
const elBtnConfirmYes = document.getElementById("btn-confirm-yes");
const elBtnConfirmNo = document.getElementById("btn-confirm-no");
const elBtnResetSession = document.getElementById("btn-reset-session");
const elBtnThemeToggle = document.getElementById("btn-theme-toggle");
const elBtnAuditDrawer = document.getElementById("btn-audit-drawer");
const elAuditDrawer = document.getElementById("audit-drawer");
const elBtnCloseAudit = document.getElementById("btn-close-audit");
const elBtnRefreshAudit = document.getElementById("btn-refresh-audit");
const elAuditCountBadge = document.getElementById("audit-count-badge");

function getOrCreateSessionId() {
  const saved = window.sessionStorage.getItem("perxia_oc_session_id");
  if (saved) return saved;
  const generated = "ses-" + Math.random().toString(36).substring(2, 9);
  window.sessionStorage.setItem("perxia_oc_session_id", generated);
  return generated;
}

function formatCurrency(amount, currency = "COP") {
  if (typeof amount !== "number" || Number.isNaN(amount)) return String(amount ?? "");
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

function escapeHtml(raw) {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Lightweight, safe Markdown renderer supporting headings, tables, code blocks, lists, bold, links
 */
function renderMarkdown(md) {
  if (!md) return "";
  const codeBlocks = [];
  let text = String(md).replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(
      `<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.trimEnd())}</code></pre>`
    );
    return `@@CODEBLOCK_${idx}@@`;
  });

  const lines = text.split(/\r?\n/);
  const htmlOut = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Check codeblock placeholder
    if (/^@@CODEBLOCK_\d+@@$/.test(line.trim())) {
      htmlOut.push(line.trim());
      i++;
      continue;
    }

    // Markdown Table detection
    if (
      line.trim().startsWith("|") &&
      i + 1 < lines.length &&
      /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i + 1])
    ) {
      const headerCells = parseTableRow(line);
      i += 2; // skip header + separator
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        bodyRows.push(parseTableRow(lines[i]));
        i++;
      }
      let tableHtml = "<table><thead><tr>";
      for (const h of headerCells) {
        tableHtml += `<th>${formatInline(h)}</th>`;
      }
      tableHtml += "</tr></thead><tbody>";
      for (const row of bodyRows) {
        tableHtml += "<tr>";
        for (const cell of row) {
          tableHtml += `<td>${formatInline(cell)}</td>`;
        }
        tableHtml += "</tr>";
      }
      tableHtml += "</tbody></table>";
      htmlOut.push(tableHtml);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlOut.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      htmlOut.push(
        "<ul>" + items.map((item) => `<li>${formatInline(item)}</li>`).join("") + "</ul>"
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      htmlOut.push(
        "<ol>" + items.map((item) => `<li>${formatInline(item)}</li>`).join("") + "</ol>"
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("|") &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^@@CODEBLOCK_\d+@@$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    htmlOut.push(`<p>${formatInline(paraLines.join("<br/>"))}</p>`);
  }

  let finalHtml = htmlOut.join("\n");
  finalHtml = finalHtml.replace(/@@CODEBLOCK_(\d+)@@/g, (_, idx) => codeBlocks[Number(idx)] || "");
  return finalHtml;
}

function parseTableRow(rowStr) {
  return rowStr
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function formatInline(str) {
  let out = escapeHtml(str);
  // Restore <br/> tags inserted intentionally
  out = out.replace(/&lt;br\/&gt;/g, "<br/>");
  // Inline code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}

function renderWelcomeCard() {
  elChatMessages.innerHTML = `
    <div class="welcome-card">
      <h2>Bienvenido al Agente de Órdenes de Compra SAP (Perxia 2.0)</h2>
      <p>
        Este agente automatiza la lectura de paquetes de compra (correo, solicitud, cotización, aprobación y factura),
        ejecuta las <strong>10 reglas de control (RC1–RC10)</strong> contra los maestros SAP, genera la evidencia de aprobación
        en PDF/TXT con huella SHA-256 y registra la Orden de Compra en SAP con idempotencia garantizada.
      </p>
      <div class="welcome-Prompts">
        <button type="button" class="btn btn-primary btn-sm" data-quick-prompt='${escapeHtml(OFFICIAL_DEMO_PROMPT)}'>
          ▶ Demo Oficial: sol-004 (Confirmación Cotización)
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-quick-prompt='Procesa la solicitud "sol-001" y crea la OC si cumple todos los controles.'>
          Procesar sol-001 (Flujo Normal)
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-quick-prompt='Procesa la solicitud "sol-002".'>
          Analizar sol-002 (Bloqueo Proveedor)
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-quick-prompt='Procesa la solicitud "sol-003".'>
          Analizar sol-003 (Bloqueo Aprobador/Tope)
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-quick-prompt='Procesa la solicitud "sol-005" y dime si es retroactiva.'>
          Analizar sol-005 (Factura Retroactiva)
        </button>
        <button type="button" class="btn btn-secondary btn-sm" data-quick-prompt='Procesa la solicitud "sol-006".'>
          Analizar sol-006 (IVA Derivado)
        </button>
      </div>
    </div>
  `;

  elChatMessages.querySelectorAll("[data-quick-prompt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const prompt = btn.getAttribute("data-quick-prompt");
      if (prompt) sendUserMessage(prompt);
    });
  });
}

function summarizeToolCall(tc) {
  const argsObj = tc.args || {};
  const caso = argsObj.caso ? `caso="${argsObj.caso}"` : "";
  const parsed = typeof tc.result === "string" ? safeJsonParse(tc.result) : tc.result;
  if (!parsed) return caso;

  if (parsed.ok === false) {
    return `${caso} → Error: ${parsed.error || "Fallo en herramienta"}`;
  }

  const data = parsed.data || parsed;
  if (tc.name.endsWith("leer_paquete") && data.solicitud) {
    return `${caso} → ${data.solicitud.solicitud_id} · ${data.solicitud.proveedor_nombre} (${formatCurrency(data.solicitud.valor_total, data.solicitud.moneda)})`;
  }
  if (tc.name.endsWith("validar")) {
    const b = Array.isArray(data.bloqueos) ? data.bloqueos.length : 0;
    const c = Array.isArray(data.confirmaciones) ? data.confirmaciones.length : 0;
    return `${caso} → apta=${Boolean(data.apta)} · bloqueos=${b} · confirmaciones=${c} · retroactiva=${Boolean(data.retroactiva)}`;
  }
  if (tc.name.endsWith("construir_payload")) {
    const payload = data.payload || data;
    return `${caso} → Sociedad ${payload.sociedad || "1000"} · Prov SAP ${payload.proveedor?.codigo_sap || ""}`;
  }
  if (tc.name.endsWith("generar_evidencia")) {
    return `${caso} → ${data.ruta_pdf || data.ruta || "aprobacion.txt"} (sha256: ${String(data.sha256 || "").slice(0, 12)}…)`;
  }
  if (tc.name.endsWith("crear")) {
    return `${caso} → OC #${data.numero_oc || "--"} (idempotente=${Boolean(data.idempotente)})`;
  }
  return caso;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function buildToolCallsHtml(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  const cards = toolCalls.map((tc) => {
    const isOk = tc.ok !== false;
    const brief = summarizeToolCall(tc);
    const argsFormatted = JSON.stringify(tc.args ?? {}, null, 2);
    const parsedRes = typeof tc.result === "string" ? safeJsonParse(tc.result) : tc.result;
    const resultFormatted = parsedRes
      ? JSON.stringify(parsedRes, null, 2)
      : String(tc.result ?? "");
    const duration = typeof tc.durationMs === "number" ? `${tc.durationMs} ms` : "";

    return `
      <details class="tool-card ${isOk ? "tool-ok" : "tool-error"}">
        <summary class="tool-card-summary">
          <div class="tool-summary-left">
            <span class="tool-status-badge ${isOk ? "ok" : "err"}">${isOk ? "OK" : "ERR"}</span>
            <span class="tool-name">⚙ ${escapeHtml(tc.name)}</span>
            <span class="tool-brief">${escapeHtml(brief)}</span>
          </div>
          <div class="tool-summary-right">
            <span>${escapeHtml(duration)}</span>
            <span>▾ Inspeccionar</span>
          </div>
        </summary>
        <div class="tool-card-details">
          <div class="tool-io-block">
            <h4>Argumentos de Entrada (zod validado)</h4>
            <pre class="tool-io-pre">${escapeHtml(argsFormatted)}</pre>
          </div>
          <div class="tool-io-block">
            <h4>Resultado Determinista de Herramienta</h4>
            <pre class="tool-io-pre">${escapeHtml(resultFormatted)}</pre>
          </div>
        </div>
      </details>
    `;
  });

  return `<div class="tool-calls-stack">${cards.join("")}</div>`;
}

function appendMessage({ role, content, toolCalls = [], needsConfirmation = false, meta = "" }) {
  const row = document.createElement("div");
  row.className = `msg-row msg-${role}${needsConfirmation ? " needs-confirmation" : ""}`;

  const authorLabel = role === "user" ? "Analista Administrativa" : "Agente SAP MM";
  const timeStr = new Date().toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const toolsHtml = role === "assistant" ? buildToolCallsHtml(toolCalls) : "";
  const bodyHtml =
    role === "user"
      ? `<div class="msg-bubble">${escapeHtml(content).replace(/\n/g, "<br/>")}</div>`
      : `<div class="msg-bubble md-content">${renderMarkdown(content)}</div>`;

  row.innerHTML = `
    <div class="msg-header">
      <span class="msg-author">${escapeHtml(authorLabel)}</span>
      <span>· ${escapeHtml(timeStr)}</span>
      ${meta ? `<span>· ${escapeHtml(meta)}</span>` : ""}
    </div>
    ${toolsHtml}
    ${bodyHtml}
  `;

  elChatMessages.appendChild(row);
  elChatMessages.scrollTop = elChatMessages.scrollHeight;
}

function updateConfirmationBanner(needsConfirmation) {
  state.needsConfirmation = Boolean(needsConfirmation);
  if (state.needsConfirmation) {
    elConfirmationBanner.classList.remove("hidden");
  } else {
    elConfirmationBanner.classList.add("hidden");
  }
}

function setBusy(busy) {
  state.busy = busy;
  elBtnSend.disabled = busy;
  elChatInput.disabled = busy;
  if (busy) {
    elThinkingBar.classList.remove("hidden");
  } else {
    elThinkingBar.classList.add("hidden");
  }
}

async function sendUserMessage(messageText) {
  const trimmed = String(messageText || "").trim();
  if (!trimmed || state.busy) return;

  elChatInput.value = "";
  updateConfirmationBanner(false);
  appendMessage({ role: "user", content: trimmed });
  setBusy(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        message: trimmed,
      }),
    });

    const payload = await response.json();

    if (!response.ok || payload.ok === false) {
      const errMsg = payload.error || `Error HTTP ${response.status}`;
      appendMessage({
        role: "assistant",
        content: `⚠️ **Error procesando el turno:** ${errMsg}`,
        toolCalls: payload.toolCalls || [],
        needsConfirmation: false,
      });
      return;
    }

    if (payload.sessionId) {
      state.sessionId = payload.sessionId;
      window.sessionStorage.setItem("perxia_oc_session_id", state.sessionId);
      elSessionId.textContent = state.sessionId;
    }

    const metaParts = [];
    if (typeof payload.iterationCount === "number") {
      metaParts.push(`${payload.iterationCount} iter`);
    }
    if (payload.tokenUsage && typeof payload.tokenUsage.totalTokens === "number") {
      metaParts.push(`${payload.tokenUsage.totalTokens} tokens`);
    }

    appendMessage({
      role: "assistant",
      content: payload.reply || "(Sin respuesta de texto)",
      toolCalls: payload.toolCalls || [],
      needsConfirmation: Boolean(payload.needsConfirmation),
      meta: metaParts.join(" · "),
    });

    updateConfirmationBanner(Boolean(payload.needsConfirmation));
    await refreshAuditData();
  } catch (err) {
    appendMessage({
      role: "assistant",
      content: `⚠️ **Error de comunicación con el servidor:** ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    setBusy(false);
    elChatInput.focus();
  }
}

async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data && data.ok) {
      elHealthDot.classList.add("online");
      elHealthText.textContent = `${data.provider || "llm"} · ${data.model || "activo"}`;
    } else {
      elHealthText.textContent = "Backend con advertencia";
    }
  } catch {
    elHealthDot.classList.remove("online");
    elHealthText.textContent = "Sin conexión al backend";
  }
}

async function loadCases() {
  try {
    const res = await fetch("/api/cases");
    const data = await res.json();
    if (data && data.ok && Array.isArray(data.cases) && data.cases.length > 0) {
      state.cases = data.cases;
    }
  } catch {
    // Keep FALLBACK_CASES
  }
  renderCasesSidebar();
  renderEvidenceLinksGrid();
}

function renderCasesSidebar() {
  elCasesTotalTag.textContent = `${state.cases.length} casos`;
  elCasesList.innerHTML = state.cases
    .map((c) => {
      const meta = DEFAULT_CASES_META[c.id] || { tag: "Solicitud", badgeClass: "badge-ok" };
      return `
        <button type="button" class="case-card" data-case-id="${escapeHtml(c.id)}">
          <div class="case-card-top">
            <span class="case-id">${escapeHtml(c.id)} · ${escapeHtml(c.solicitud_id || "")}</span>
            <span class="case-badge ${meta.badgeClass}">${escapeHtml(meta.tag)}</span>
          </div>
          <div class="case-provider">${escapeHtml(c.proveedor || "Proveedor")}</div>
          <div class="case-desc">${escapeHtml(c.descripcion || "")}</div>
          <div class="case-meta">
            <span>${escapeHtml(c.centro_costo || "")}</span>
            <span>${escapeHtml(formatCurrency(c.monto, c.moneda || "COP"))}</span>
          </div>
        </button>
      `;
    })
    .join("");

  elCasesList.querySelectorAll(".case-card").forEach((card) => {
    card.addEventListener("click", () => {
      const caseId = card.getAttribute("data-case-id");
      if (!caseId) return;
      if (caseId === "sol-004") {
        sendUserMessage(OFFICIAL_DEMO_PROMPT);
      } else {
        sendUserMessage(
          `Procesa la solicitud "${caseId}". Valida el paquete contra los maestros, muéstrame el payload SAP y crea la OC si no tiene bloqueos ni confirmaciones pendientes.`
        );
      }
    });
  });
}

function renderEvidenceLinksGrid() {
  const container = document.getElementById("evidence-links-grid");
  if (!container) return;
  container.innerHTML = state.cases
    .map(
      (c) => `
      <div class="evidence-case-box">
        <div class="evidence-case-title">${escapeHtml(c.id)}</div>
        <div class="evidence-links-row">
          <a class="evidence-link" href="/out/${encodeURIComponent(c.id)}/aprobacion.pdf" target="_blank" rel="noopener">PDF Evidencia</a>
          <a class="evidence-link" href="/out/${encodeURIComponent(c.id)}/aprobacion.txt" target="_blank" rel="noopener">TXT SHA256</a>
          <a class="evidence-link" href="/out/${encodeURIComponent(c.id)}/trazabilidad.json" target="_blank" rel="noopener">Trazabilidad</a>
        </div>
      </div>
    `
    )
    .join("");
}

async function refreshAuditData() {
  try {
    const res = await fetch("/api/control");
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.ok) return;

    const ordenes = Array.isArray(data.ordenes) ? data.ordenes : [];
    const controlRows = Array.isArray(data.controlRows) ? data.controlRows : [];

    elAuditCountBadge.textContent = String(ordenes.length);

    document.getElementById("kpi-ordenes").textContent = String(ordenes.length);
    const retroCount = controlRows.filter(
      (r) => String(r.retroactiva).toLowerCase() === "true"
    ).length;
    const blockCount = controlRows.filter(
      (r) => String(r.resultado).toUpperCase().includes("BLOQUE")
    ).length;
    document.getElementById("kpi-retroactivas").textContent = String(retroCount);
    document.getElementById("kpi-bloqueados").textContent = String(blockCount);

    const sapContainer = document.getElementById("sap-orders-container");
    if (ordenes.length === 0) {
      sapContainer.innerHTML = `<p class="empty-state">Aún no se han creado órdenes en esta ejecución.</p>`;
    } else {
      sapContainer.innerHTML = `
        <table class="audit-table">
          <thead>
            <tr>
              <th>N° OC SAP</th>
              <th>Solicitud</th>
              <th>Proveedor</th>
              <th>Cond. Pago</th>
              <th>Fecha</th>
            </tr>
          </thead>
          <tbody>
            ${ordenes
              .map((o) => {
                const payload = o.orden || o.payload || o;
                const refId =
                  o.solicitud_id || payload?.referencia?.solicitud_id || "--";
                const prov =
                  payload?.proveedor?.nombre || payload?.proveedor?.codigo_sap || "--";
                const cond = payload?.condiciones_pago || "--";
                return `
                  <tr>
                    <td class="mono"><strong>${escapeHtml(o.numero_oc || "--")}</strong></td>
                    <td class="mono">${escapeHtml(refId)}</td>
                    <td>${escapeHtml(prov)}</td>
                    <td class="mono">${escapeHtml(cond)}</td>
                    <td class="mono">${escapeHtml(String(o.fecha || "").slice(0, 19))}</td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
      `;
    }

    const controlContainer = document.getElementById("control-log-container");
    if (controlRows.length === 0) {
      controlContainer.innerHTML = `<p class="empty-state">Sin registros en <code>out/control.csv</code> todavía.</p>`;
    } else {
      controlContainer.innerHTML = `
        <table class="audit-table">
          <thead>
            <tr>
              <th>Solicitud</th>
              <th>Resultado</th>
              <th>N° OC</th>
              <th>Retroactiva</th>
              <th>Excepciones</th>
            </tr>
          </thead>
          <tbody>
            ${controlRows
              .map(
                (r) => `
              <tr>
                <td class="mono">${escapeHtml(r.solicitud_id || "")}</td>
                <td><strong>${escapeHtml(r.resultado || "")}</strong></td>
                <td class="mono">${escapeHtml(r.numero_oc || "-")}</td>
                <td class="mono">${String(r.retroactiva) === "true" ? "⚠️ SÍ" : "No"}</td>
                <td>${escapeHtml(r.bloqueos || r.confirmaciones || "-")}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `;
    }
  } catch {
    // Non-fatal if endpoint not yet populated
  }
}

async function resetSession() {
  try {
    await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/reset`, {
      method: "POST",
    });
  } catch {
    // Ignore network error on reset
  }
  state.sessionId = "ses-" + Math.random().toString(36).substring(2, 9);
  window.sessionStorage.setItem("perxia_oc_session_id", state.sessionId);
  elSessionId.textContent = state.sessionId;
  updateConfirmationBanner(false);
  renderWelcomeCard();
}

// Event Listeners
elChatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendUserMessage(elChatInput.value);
});

elChatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage(elChatInput.value);
  }
});

elBtnOfficialDemo.addEventListener("click", () => {
  sendUserMessage(OFFICIAL_DEMO_PROMPT);
});

elBtnConfirmYes.addEventListener("click", () => {
  sendUserMessage("Confirmo las excepciones informadas. Procede a crear la orden de compra en SAP.");
});

elBtnConfirmNo.addEventListener("click", () => {
  sendUserMessage("No confirmo. Cancela la creación de esta orden de compra y devuélvela al solicitante.");
});

elBtnResetSession.addEventListener("click", () => {
  resetSession();
});

elBtnThemeToggle.addEventListener("click", () => {
  const html = document.documentElement;
  const current = html.getAttribute("data-theme") || "dark";
  html.setAttribute("data-theme", current === "dark" ? "light" : "dark");
});

elBtnAuditDrawer.addEventListener("click", () => {
  elAuditDrawer.classList.toggle("hidden");
  if (!elAuditDrawer.classList.contains("hidden")) {
    refreshAuditData();
  }
});

elBtnCloseAudit.addEventListener("click", () => {
  elAuditDrawer.classList.add("hidden");
});

elBtnRefreshAudit.addEventListener("click", () => {
  refreshAuditData();
});

// Initialize App
elSessionId.textContent = state.sessionId;
renderWelcomeCard();
loadHealth();
loadCases();
refreshAuditData();
