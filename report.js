// Cálculo e renderização do relatório por prédio.
// Os dados vêm ao vivo da RPC public.pricing_relatorio_predios_json() (Supabase) — nada fica fixo no HTML.
// Regras (as mesmas da versão de 20/08/2026):
//  - reservas status "Reserva", sem reserva do proprietário, agrupadas por mês de check-in;
//  - unidade ativa num mês = teve reserva em até 3 meses antes/depois; para meses futuros também conta
//    quem teve reserva nos últimos 3 meses até hoje (reserva futura ainda pode não ter sido feita);
//  - "Margem de Manobra" não-clone tem a receita reatribuída ao prédio do grupo, mas não conta como unidade;
//  - unidade com contrato encerrado (owner-contract da Stays, duration.to) sai da conta a partir do dia
//    seguinte ao fim: no mês do término conta só os dias até o fim; nos meses seguintes não conta.

export const MESES_PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
const ACTIVITY_WINDOW = 3;

const mi = (ano, mes) => ano * 12 + mes;
const daysIn = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

export function todayRecife(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Recife", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { ano: +parts.year, mes: +parts.month, dia: +parts.day };
}

// rows: [empreendimento, unit_key, margem_only, ano, mes, reservas, noites, faturamento]
export function computeReport(rows, today, fimContrato = {}) {
  const Y2 = today.ano, Y1 = today.ano - 1;
  const TODAY_IDX = mi(today.ano, today.mes);
  const REPORT_MONTHS = [];
  for (const ano of [Y1, Y2]) for (let mes = 1; mes <= 12; mes++) REPORT_MONTHS.push([ano, mes]);
  const inReport = (ano, mes) => ano === Y1 || ano === Y2;

  const unitActivity = new Map();   // building -> Map(unit -> Set(monthIdx))
  const exact = new Map();          // building -> Map("ano-mes" -> {reservas,noites,faturamento})
  for (const [b, u, margemOnly, ano, mes, reservas, noites, fat] of rows) {
    if (!unitActivity.has(b)) unitActivity.set(b, new Map());
    if (!exact.has(b)) exact.set(b, new Map());
    if (!margemOnly) {
      const units = unitActivity.get(b);
      if (!units.has(u)) units.set(u, new Set());
      units.get(u).add(mi(ano, mes));
    }
    if (inReport(ano, mes)) {
      const k = ano + "-" + mes, m = exact.get(b);
      const acc = m.get(k) || { reservas: 0, noites: 0, faturamento: 0 };
      acc.reservas += Number(reservas) || 0;
      acc.noites += Number(noites) || 0;
      acc.faturamento += Number(fat) || 0;
      m.set(k, acc);
    }
  }

  const buildings = [...unitActivity.keys()].sort();

  // Fim de contrato só vale se a unidade parou de receber check-ins depois dele. Há contratos
  // renovados sem atualizar a data na Stays (ex.: unidades vendendo em 2027 com fim em 2025) —
  // nesses casos a data é ignorada e vale só a regra de atividade (±3 meses).
  const fimEfetivo = {};
  for (const units of unitActivity.values()) {
    for (const [u, months] of units) {
      const fim = fimContrato[u];
      if (!fim) continue;
      const [fy, fm] = fim.split("-").map(Number);
      if (Math.max(...months) <= mi(fy, fm)) fimEfetivo[u] = fim;
    }
  }

  // dias do mês em que a unidade estava sob contrato (0 = contrato já tinha acabado)
  function contractDays(u, ano, mes) {
    const fim = fimEfetivo[u];
    const dias = daysIn(ano, mes);
    if (!fim) return dias;
    const [fy, fm, fd] = fim.split("-").map(Number);
    const fIdx = mi(fy, fm), t = mi(ano, mes);
    if (fIdx > t) return dias;
    if (fIdx < t) return 0;
    return fd;
  }

  function activeUnits(b, ano, mes) {
    const target = mi(ano, mes);
    const out = new Set();
    for (const [u, months] of unitActivity.get(b)) {
      if (!contractDays(u, ano, mes)) continue;
      let ok = false;
      for (const t of months) {
        if (Math.abs(t - target) <= ACTIVITY_WINDOW) { ok = true; break; }
        if (target > TODAY_IDX && t >= TODAY_IDX - ACTIVITY_WINDOW && t <= TODAY_IDX) { ok = true; break; }
      }
      if (ok) out.add(u);
    }
    return out;
  }

  const byBuilding = {};
  const activeSets = {};
  const unitsYear = {};
  for (const b of buildings) {
    byBuilding[b] = {}; activeSets[b] = {}; unitsYear[b] = {};
    for (const [ano, mes] of REPORT_MONTHS) {
      const k = ano + "-" + mes;
      const s = activeUnits(b, ano, mes);
      activeSets[b][k] = s;
      const m = exact.get(b).get(k) || { reservas: 0, noites: 0, faturamento: 0 };
      const qtd = s.size;
      let avail = 0;
      for (const u of s) avail += contractDays(u, ano, mes);
      byBuilding[b][k] = {
        reservas: m.reservas, noites: m.noites, faturamento: m.faturamento,
        avail,
        occ: avail ? m.noites / avail * 100 : 0,
        adr: m.noites ? m.faturamento / m.noites : 0,
        revcat: qtd ? m.faturamento / qtd : 0,
        alos: m.reservas ? m.noites / m.reservas : 0,
        qtd_unidades: qtd,
        // mês em curso e meses seguintes ainda estão vendendo
        provisional: ano === Y2 && mes >= today.mes,
      };
    }
    for (const ano of [Y1, Y2]) {
      const union = new Set();
      for (let mes = 1; mes <= 12; mes++) for (const u of activeSets[b][ano + "-" + mes]) union.add(u);
      unitsYear[b][ano] = union.size;
    }
  }

  // Consolidado: só meses fechados, mesmo recorte nos dois anos (em janeiro, usa o mês corrente).
  const lastClosed = Math.max(1, today.mes - 1);
  const ytdMonths = Array.from({ length: lastClosed }, (_, i) => i + 1);

  function consolidate(b, ano) {
    let noites = 0, faturamento = 0, reservas = 0, avail = 0;
    const union = new Set();
    for (const m of ytdMonths) {
      const d = byBuilding[b][ano + "-" + m];
      noites += d.noites; faturamento += d.faturamento; reservas += d.reservas;
      avail += d.avail;
      for (const u of activeSets[b][ano + "-" + m]) union.add(u);
    }
    return {
      noites, faturamento, reservas, avail, unidades: union.size,
      occ: avail ? noites / avail * 100 : 0,
      adr: noites ? faturamento / noites : 0,
      alos: reservas ? noites / reservas : 0,
    };
  }

  const overview = {};
  for (const b of buildings) overview[b] = { y1: consolidate(b, Y1), y2: consolidate(b, Y2) };

  return { Y1, Y2, today, buildings, byBuilding, unitsYear, overview, ytdMonths, fimEfetivo };
}

// ---------- formatação ----------
const nf0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
export const fmtPct = v => v.toFixed(1) + "%";
export const fmtBrl = v => "R$ " + nf0.format(Math.round(v));
export const fmtInt = v => v.toFixed(0);
export const fmtNights = v => v.toFixed(1) + " noites";
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugOf = b => b.replace(/[^\p{L}\p{N}]/gu, "-").replace(/^-+|-+$/g, "").toLowerCase();

function deltaPct(v1, v2) {
  if (v1 == null || v2 == null || v1 === 0) return "—";
  const d = (v2 - v1) / v1 * 100;
  const up = d >= 0;
  return `<span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${up ? "+" : ""}${d.toFixed(0)}%</span>`;
}

// ---------- gráfico SVG ----------
const W = 860, H = 340, PAD_L = 58, PAD_R = 18, PAD_T = 20, PAD_B = 34;
const PLOT_W = W - PAD_L - PAD_R, PLOT_H = H - PAD_T - PAD_B;

function buildChart(R, b, key, fmt) {
  const s1 = [], s2 = [];
  for (let m = 1; m <= 12; m++) { s1.push(R.byBuilding[b][R.Y1 + "-" + m]); s2.push(R.byBuilding[b][R.Y2 + "-" + m]); }
  const vals = [...s1, ...s2].filter(Boolean).map(d => d[key]);
  let vmax = vals.length ? Math.max(...vals) : 1;
  vmax = vmax > 0 ? vmax * 1.18 : 1;
  const x = i => PAD_L + PLOT_W * i / 11;
  const y = v => PAD_T + PLOT_H - v / vmax * PLOT_H;
  const parts = [`<svg viewBox="0 0 ${W} ${H}" class="chart-svg" xmlns="http://www.w3.org/2000/svg">`,
    `<line x1="${PAD_L}" y1="${PAD_T + PLOT_H}" x2="${W - PAD_R}" y2="${PAD_T + PLOT_H}" class="axisline"/>`];
  for (let g = 0; g < 5; g++) {
    const val = vmax * g / 4, yy = y(val);
    parts.push(`<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${W - PAD_R}" y2="${yy.toFixed(1)}" class="gridline"/>`);
    parts.push(`<text x="${PAD_L - 6}" y="${(yy + 3).toFixed(1)}" class="axislabel" text-anchor="end">${fmt(val)}</text>`);
  }
  MESES_PT.forEach((m, i) => parts.push(`<text x="${x(i).toFixed(1)}" y="${H - 6}" class="axislabel" text-anchor="middle">${m}</text>`));

  function series(arr, cls, year) {
    const coords = arr.map((d, i) => d ? [x(i), y(d[key]), d] : null);
    const path = pts => pts.map((c, k) => `${k ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
    const out = [];
    const solid = coords.filter(c => c && !c[2].provisional);
    if (solid.length) out.push(`<path d="${path(solid)}" class="${cls}-line" fill="none"/>`);
    const p0 = coords.findIndex(c => c && c[2].provisional);
    if (p0 >= 0) {
      const chain = [];
      if (p0 > 0 && coords[p0 - 1]) chain.push(coords[p0 - 1]);
      for (let i = p0; i < 12; i++) if (coords[i]) chain.push(coords[i]);
      if (chain.length >= 2) out.push(`<path d="${path(chain)}" class="${cls}-line ${cls}-dash" fill="none"/>`);
    }
    coords.forEach((c, i) => {
      if (!c) return;
      const tip = esc(`${MESES_PT[i]}/${year}: ${fmt(c[2][key])}${c[2].provisional ? " (parcial)" : ""}`);
      out.push(`<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="4.2" class="${cls}-dot" data-tip="${tip}"/>`);
      out.push(`<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="10" class="hit-dot" data-tip="${tip}"/>`);
    });
    return out.join("");
  }
  parts.push(series(s1, "y25", R.Y1), series(s2, "y26", R.Y2), "</svg>");
  return parts.join("");
}

// ---------- tabelas ----------
function buildTable(R, b) {
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const d1 = R.byBuilding[b][R.Y1 + "-" + m], d2 = R.byBuilding[b][R.Y2 + "-" + m];
    const cell = (d, k, fmt) => `<td class="${d.provisional ? "prov" : ""}">${fmt(d[k])}</td>`;
    const dc = k => d2.provisional ? '<td class="prov">parcial</td>' : `<td>${deltaPct(d1[k], d2[k])}</td>`;
    rows.push(`<tr><td class="monthcell">${MESES_PT[m - 1]}</td>`
      + cell(d1, "occ", fmtPct) + cell(d2, "occ", fmtPct) + dc("occ")
      + cell(d1, "adr", fmtBrl) + cell(d2, "adr", fmtBrl) + dc("adr")
      + cell(d1, "revcat", fmtBrl) + cell(d2, "revcat", fmtBrl) + dc("revcat")
      + cell(d1, "reservas", fmtInt) + cell(d2, "reservas", fmtInt) + dc("reservas")
      + cell(d1, "alos", fmtNights) + cell(d2, "alos", fmtNights) + dc("alos")
      + `<td class="unitcell">${d1.qtd_unidades} / ${d2.qtd_unidades}</td></tr>`);
  }
  return rows.join("");
}

function buildOverviewRows(R) {
  const rows = [];
  const t = { n1: 0, n2: 0, f1: 0, f2: 0, a1: 0, a2: 0, u1: 0, u2: 0, r1: 0, r2: 0 };
  const z = v => v || null;
  const line = (label, u1, u2, o1, o2, f1, f2, a1, a2, r1, r2, l1, l2, cls = "") =>
    `<tr${cls}>${label}<td>${u1}</td><td>${u2}</td>`
    + `<td>${fmtPct(o1)}</td><td>${fmtPct(o2)}</td><td>${deltaPct(z(o1), z(o2))}</td>`
    + `<td>${fmtBrl(a1)}</td><td>${fmtBrl(a2)}</td><td>${deltaPct(z(a1), z(a2))}</td>`
    + `<td>${fmtBrl(f1)}</td><td>${fmtBrl(f2)}</td><td>${deltaPct(z(f1), z(f2))}</td>`
    + `<td>${fmtInt(r1)}</td><td>${fmtInt(r2)}</td><td>${deltaPct(z(r1), z(r2))}</td>`
    + `<td>${fmtNights(l1)}</td><td>${fmtNights(l2)}</td><td>${deltaPct(z(l1), z(l2))}</td></tr>`;
  for (const b of R.buildings) {
    const { y1: c1, y2: c2 } = R.overview[b];
    t.n1 += c1.noites; t.n2 += c2.noites; t.f1 += c1.faturamento; t.f2 += c2.faturamento;
    t.a1 += c1.avail; t.a2 += c2.avail; t.u1 += c1.unidades; t.u2 += c2.unidades;
    t.r1 += c1.reservas; t.r2 += c2.reservas;
    rows.push(line(`<td class="buildname"><a href="#" class="jump" data-b="${esc(b)}">${esc(b)}</a></td>`,
      c1.unidades, c2.unidades, c1.occ, c2.occ, c1.faturamento, c2.faturamento, c1.adr, c2.adr,
      c1.reservas, c2.reservas, c1.alos, c2.alos));
  }
  const d = (a, b) => b ? a / b : 0;
  rows.push(line("<td>TOTAL</td>", t.u1, t.u2, d(t.n1, t.a1) * 100, d(t.n2, t.a2) * 100, t.f1, t.f2,
    d(t.f1, t.n1), d(t.f2, t.n2), t.r1, t.r2, d(t.n1, t.r1), d(t.n2, t.r2), ' class="totalrow"'));
  return rows.join("");
}

// ---------- leitura automática do período ----------
// Substitui as notas escritas à mão (que ficavam velhas): descreve as variações do consolidado
// e atribui o efeito na receita a volume (unidades/ocupação) ou preço (ticket).
export function buildNote(R, b) {
  const { y1: a, y2: c } = R.overview[b];
  const per = periodLabel(R);
  const pct = (x, y) => (y - x) / x * 100;
  const sgn = v => (v >= 0 ? "+" : "") + v.toFixed(0) + "%";
  if (!a.reservas && !c.reservas) return `Sem reservas em ${per} de ${R.Y1} nem de ${R.Y2}.`;
  if (!a.reservas) return `Sem operação em ${per}/${R.Y1} para comparar — prédio entrou na carteira depois. Em ${per}/${R.Y2}: ${c.unidades} unidades ativas, ocupação de ${fmtPct(c.occ)} e ticket médio de ${fmtBrl(c.adr)}.`;
  if (!c.reservas) return `Sem reservas em ${per}/${R.Y2} — prédio saiu ou está com calendário fechado. Em ${per}/${R.Y1} eram ${a.unidades} unidades ativas, com ${fmtPct(a.occ)} de ocupação.`;

  const dU = c.unidades - a.unidades, dOcc = c.occ - a.occ, dAdr = pct(a.adr, c.adr), dRev = pct(a.faturamento, c.faturamento);
  const s = [];
  s.push(Math.abs(dU) <= Math.max(1, a.unidades * 0.05)
    ? `Base de unidades estável (${a.unidades} → ${c.unidades})`
    : `Unidades ativas ${dU > 0 ? "subiram" : "caíram"} de ${a.unidades} para ${c.unidades}`);
  s[0] += `; ocupação ${Math.abs(dOcc) < 1 ? "estável" : dOcc > 0 ? "subiu" : "caiu"} (${fmtPct(a.occ)} → ${fmtPct(c.occ)}) e ticket médio ${Math.abs(dAdr) < 2 ? "estável" : dAdr > 0 ? "subiu" : "caiu"} (${fmtBrl(a.adr)} → ${fmtBrl(c.adr)}).`;
  // decomposição: receita = noites × ticket; noites = disponibilidade × ocupação
  const volume = pct(a.noites, c.noites);
  let driver;
  if (Math.abs(dRev) < 3) driver = `Receita praticamente estável (${sgn(dRev)})`;
  else if (Math.sign(volume) === Math.sign(dRev) && Math.abs(volume) >= Math.abs(dAdr) * 2) driver = `A ${dRev > 0 ? "alta" : "queda"} de receita (${sgn(dRev)}) vem quase toda de volume de noites vendidas (${sgn(volume)}), não de preço`;
  else if (Math.sign(dAdr) === Math.sign(dRev) && Math.abs(dAdr) >= Math.abs(volume) * 2) driver = `A ${dRev > 0 ? "alta" : "queda"} de receita (${sgn(dRev)}) vem principalmente do preço (ticket ${sgn(dAdr)})`;
  else driver = `Receita ${sgn(dRev)}, combinando volume de noites (${sgn(volume)}) e ticket (${sgn(dAdr)})`;
  const alos = pct(a.alos, c.alos);
  s.push(driver + (Math.abs(alos) >= 8 ? `; estadias ${alos > 0 ? "mais longas" : "mais curtas"} (${a.alos.toFixed(1)} → ${c.alos.toFixed(1)} noites).` : "."));
  if (dU < -a.unidades * 0.1 && dOcc > 3) s.push("Menos unidades, mas as que ficaram estão vendendo mais.");
  return s.join(" ");
}

export function periodLabel(R) {
  const n = R.ytdMonths.length;
  return n === 1 ? MESES_PT[0] : `Jan-${MESES_PT[n - 1]}`;
}

// ---------- montagem ----------
export function renderReport(R, { tabsEl, panelsEl }) {
  const per = periodLabel(R);
  const legend = `<div class="legend"><span class="dot y25"></span>${R.Y1} <span class="dot y26"></span>${R.Y2} <span class="dash-sample"></span>parcial (mês em curso)</div>`;
  const tabs = ['<button class="tab-btn active" data-tab="overview">VISÃO GERAL</button>'];
  const panels = [`
<section class="panel active" id="panel-overview">
  <p class="note">Consolidado <strong>${per}</strong> — só meses fechados, mesmo recorte nos dois anos, pra comparar de forma justa (o mês em curso ainda está vendendo). Clique no nome do prédio para abrir o detalhe mensal com gráficos.
  "Unidades ativas" conta as que tiveram reserva em algum mês de ${per} daquele ano com no máximo ${ACTIVITY_WINDOW} meses de intervalo e estavam com contrato vigente
  (data de fim do contrato com o proprietário na Stays) — unidades com contrato encerrado saem da conta de ocupação e receita a partir do fim do contrato. Ocupação e ticket médio são a soma do período (não a média simples dos meses).</p>
  <div class="table-wrap">
  <table class="overview-table">
    <thead>
      <tr><th rowspan="2">Prédio</th><th colspan="2">Unidades ativas</th><th colspan="3">Ocupação (${per})</th><th colspan="3">Ticket médio/noite (${per})</th><th colspan="3">Receita total (${per})</th><th colspan="3">Check-ins (${per})</th><th colspan="3">Noites médias/reserva (${per})</th></tr>
      <tr><th>${R.Y1}</th><th>${R.Y2}</th>${`<th>${R.Y1}</th><th>${R.Y2}</th><th>YoY</th>`.repeat(5)}</tr>
    </thead>
    <tbody>${buildOverviewRows(R)}</tbody>
  </table>
  </div>
</section>`];
  const charts = [
    ["occ", fmtPct, "Ocupação (%) — mensal"],
    ["adr", fmtBrl, "Ticket médio por noite (R$)"],
    ["revcat", fmtBrl, "Receita média do prédio (R$/unidade ativa)"],
    ["qtd_unidades", fmtInt, "Unidades ativas — base de cálculo"],
    ["reservas", fmtInt, "Check-ins (reservas) — mensal"],
    ["alos", fmtNights, "Noites médias por reserva"],
  ];
  for (const b of R.buildings) {
    const slug = slugOf(b);
    tabs.push(`<button class="tab-btn" data-tab="${slug}">${esc(b)}</button>`);
    panels.push(`
<section class="panel" id="panel-${slug}" data-building="${esc(b)}">
  <div class="panel-head">
    <h2>${esc(b)}</h2>
    <span class="chip">Unidades ativas ${R.Y1}: ${R.unitsYear[b][R.Y1]}</span>
    <span class="chip">Unidades ativas ${R.Y2}: ${R.unitsYear[b][R.Y2]}</span>
  </div>
  <div class="charts-grid">
    ${charts.map(([k, f, t]) => `<div class="chart-card"><h3>${t}</h3>${buildChart(R, b, k, f)}${legend}</div>`).join("\n    ")}
  </div>
  <div class="table-wrap">
  <table class="detail-table">
    <thead>
      <tr><th rowspan="2">Mês</th><th colspan="3">Ocupação</th><th colspan="3">Ticket médio/noite</th><th colspan="3">Receita média do prédio</th><th colspan="3">Check-ins</th><th colspan="3">Noites médias/reserva</th><th rowspan="2">Unid. ativas</th></tr>
      <tr>${`<th>${R.Y1}</th><th>${R.Y2}</th><th>Var.</th>`.repeat(5)}</tr>
    </thead>
    <tbody>${buildTable(R, b)}</tbody>
  </table>
  </div>
  <div class="insight-note">
    <h4>Leitura do período (${per}, automática)</h4>
    <p>${esc(buildNote(R, b))}</p>
  </div>
</section>`);
  }
  tabsEl.innerHTML = tabs.join("");
  panelsEl.innerHTML = panels.join("");
}
