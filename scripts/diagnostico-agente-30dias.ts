import fs from "node:fs";
/**
 * Diagnóstico de 30 Dias: Performance de Vendas, Gargalos do Funil e Custos de IA.
 *
 * Executa uma varredura completa de leitura (READ-ONLY) sobre as tabelas:
 * - crm_leads & crm_stages (vendas, funil, estagnação, motivos de perda)
 * - llm_calls (chamadas de IA, tokens, cache read, custos em USD)
 * - conversations (volume de atendimento, transbordo humano)
 */

import { createClient } from "@supabase/supabase-js";

interface Args {
  days: number;
  url?: string;
  key?: string;
  orgId?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let days = 30;
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let orgId: string | undefined;

  // Fallback para .env.local se nao estiver no env
  if (!url || !key) {
    for (const envFile of [".env.local", ".env"]) {
      if (fs.existsSync(envFile)) {
        const lines = fs.readFileSync(envFile, "utf8").split("\n");
        for (const line of lines) {
          const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
          if (m) {
            const k = m[1];
            const v = m[2].replace(/^"(.*)"$/, "$1").trim();
            if (k === "NEXT_PUBLIC_SUPABASE_URL" && !url) url = v;
            if (k === "SUPABASE_SERVICE_ROLE_KEY" && !key) key = v;
          }
        }
      }
    }
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days" && args[i + 1]) {
      days = parseInt(args[i + 1], 10) || 30;
      i++;
    } else if (args[i] === "--url" && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--key" && args[i + 1]) {
      key = args[i + 1];
      i++;
    } else if (args[i] === "--org" && args[i + 1]) {
      orgId = args[i + 1];
      i++;
    }
  }

  return { days, url, key, orgId };
}

function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function run() {
  const { days, url, key, orgId } = parseArgs();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cutoffStagnant = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

  console.log("================================================================================");
  console.log(`🔎 INICIANDO DIAGNÓSTICO DO AGENTE — JANELA DE ${days} DIAS`);
  console.log(`Período analisado: desde ${since.slice(0, 10)}`);
  console.log("================================================================================\n");

  if (!url || !key) {
    console.error("❌ Credenciais ausentes. Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(1);
  }

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. PERFORMANCE DE VENDAS
  let leadsQuery = supabase
    .from("crm_leads")
    .select("id, status, value_cents, currency, stage_id, created_at, closed_at, last_activity_at, lost_reason, tags")
    .gte("created_at", since);

  if (orgId) {
    leadsQuery = leadsQuery.eq("organization_id", orgId);
  }

  const { data: leads, error: leadsErr } = await leadsQuery;
  if (leadsErr) {
    console.error("❌ Erro ao consultar crm_leads:", leadsErr.message);
  }

  const allLeads = leads ?? [];
  const totalLeads = allLeads.length;
  const wonLeads = allLeads.filter((l) => l.status === "won");
  const lostLeads = allLeads.filter((l) => l.status === "lost");
  const openLeads = allLeads.filter((l) => l.status === "open");

  const conversionRate = totalLeads > 0 ? wonLeads.length / totalLeads : 0;
  const totalWonCents = wonLeads.reduce((acc, l) => acc + (Number(l.value_cents) || 0), 0);
  const totalRevenueBRL = totalWonCents / 100;
  const ticketMedioBRL = wonLeads.length > 0 ? totalRevenueBRL / wonLeads.length : 0;

  // Ciclo médio de fechamento (dias)
  const closingTimesDays: number[] = [];
  for (const l of wonLeads) {
    if (l.closed_at && l.created_at) {
      const ms = new Date(l.closed_at).getTime() - new Date(l.created_at).getTime();
      if (ms > 0) closingTimesDays.push(ms / (1000 * 60 * 60 * 24));
    }
  }
  const avgClosingDays =
    closingTimesDays.length > 0
      ? closingTimesDays.reduce((a, b) => a + b, 0) / closingTimesDays.length
      : null;

  console.log("┌──────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ 1. PERFORMANCE DE VENDAS (Últimos 30 dias)                                   │");
  console.log("├──────────────────────────────────────────────────────────────────────────────┤");
  console.log(`│ • Total de Leads Inbound:       ${totalLeads.toString().padEnd(43)}│`);
  console.log(`│ • Vendas Fechadas (Won):        ${wonLeads.length.toString().padEnd(43)}│`);
  console.log(`│ • Vendas Perdidas (Lost):       ${lostLeads.length.toString().padEnd(43)}│`);
  console.log(`│ • Em Negociação (Open):         ${openLeads.length.toString().padEnd(43)}│`);
  console.log(`│ • Taxa de Conversão Geral:      ${formatPct(conversionRate).padEnd(43)}│`);
  console.log(`│ • Faturamento Total Gerado:     ${formatBRL(totalRevenueBRL).padEnd(43)}│`);
  console.log(`│ • Ticket Médio por Venda:       ${formatBRL(ticketMedioBRL).padEnd(43)}│`);
  console.log(
    `│ • Ciclo Médio de Fechamento:    ${(avgClosingDays !== null ? `${avgClosingDays.toFixed(1)} dias` : "N/D").padEnd(43)}│`,
  );
  console.log("└──────────────────────────────────────────────────────────────────────────────┘\n");

  // 2. DIAGNÓSTICO DO FUNIL E ONDE TRAVA
  let stagesQuery = supabase.from("crm_stages").select("id, name, position, is_won, is_lost").order("position", { ascending: true });
  if (orgId) {
    stagesQuery = stagesQuery.eq("organization_id", orgId);
  }
  const { data: stages } = await stagesQuery;
  const allStages = stages ?? [];

  console.log("┌──────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ 2. ONDE O FUNIL TRAVA (Distribuição de Leads e Parados)                      │");
  console.log("├──────────────────────────────────────────────────────────────────────────────┤");

  if (allStages.length === 0) {
    console.log("│ Nenhuma etapa de funil encontrada.                                           │");
  } else {
    for (const stage of allStages) {
      const inStage = allLeads.filter((l) => l.stage_id === stage.id);
      const stagnant = inStage.filter(
        (l) => l.status === "open" && l.last_activity_at && l.last_activity_at < cutoffStagnant,
      );
      const pct = totalLeads > 0 ? (inStage.length / totalLeads) * 100 : 0;
      const statusSuffix = stage.is_won ? " [WON]" : stage.is_lost ? " [LOST]" : "";
      console.log(
        `│ • ${stage.name}${statusSuffix}: ${inStage.length} leads (${pct.toFixed(1)}%) | Parados > 5 dias: ${stagnant.length}`,
      );
    }
  }
  console.log("└──────────────────────────────────────────────────────────────────────────────┘\n");

  // Motivos de perda
  const lostReasonsMap = new Map<string, number>();
  for (const l of lostLeads) {
    const reason = l.lost_reason || "Motivo não informado / Ghosting";
    lostReasonsMap.set(reason, (lostReasonsMap.get(reason) ?? 0) + 1);
  }

  if (lostReasonsMap.size > 0) {
    console.log("📊 Principais Motivos de Perda (Lost):");
    const sorted = [...lostReasonsMap.entries()].sort((a, b) => b[1] - a[1]);
    for (const [r, count] of sorted.slice(0, 5)) {
      console.log(`   - ${r}: ${count} leads (${((count / Math.max(1, lostLeads.length)) * 100).toFixed(1)}%)`);
    }
    console.log();
  }

  // 3. CUSTOS E EFICIÊNCIA DE IA (llm_calls)
  let llmQuery = supabase
    .from("llm_calls")
    .select("cost_cents, input_tokens, output_tokens, cache_read_tokens, latency_ms, status, purpose, model")
    .gte("created_at", since);

  if (orgId) {
    llmQuery = llmQuery.eq("organization_id", orgId);
  }

  const { data: llmCalls, error: llmErr } = await llmQuery;
  if (llmErr) {
    console.error("❌ Erro ao consultar llm_calls:", llmErr.message);
  }

  const calls = llmCalls ?? [];
  const totalCalls = calls.length;
  const totalCostCentsUSD = calls.reduce((acc, c) => acc + (Number(c.cost_cents) || 0), 0);
  const totalCostUSD = totalCostCentsUSD / 100;
  const estimatedCostBRL = totalCostUSD * 5.6; // Cotação média BRL

  const totalInputTokens = calls.reduce((acc, c) => acc + (Number(c.input_tokens) || 0), 0);
  const totalOutputTokens = calls.reduce((acc, c) => acc + (Number(c.output_tokens) || 0), 0);
  const totalCacheReadTokens = calls.reduce((acc, c) => acc + (Number(c.cache_read_tokens) || 0), 0);

  const cacheHitRatio = totalInputTokens > 0 ? (totalCacheReadTokens / totalInputTokens) * 100 : 0;
  const costPerLeadBRL = totalLeads > 0 ? estimatedCostBRL / totalLeads : 0;
  const costPerSaleBRL = wonLeads.length > 0 ? estimatedCostBRL / wonLeads.length : 0;
  const roiIA = totalCostUSD > 0 ? (totalRevenueBRL - estimatedCostBRL) / estimatedCostBRL : null;

  console.log("┌──────────────────────────────────────────────────────────────────────────────┐");
  console.log("│ 3. CUSTOS E EFICIÊNCIA DE IA (Últimos 30 dias)                               │");
  console.log("├──────────────────────────────────────────────────────────────────────────────┤");
  console.log(`│ • Total de Chamadas LLM:        ${totalCalls.toString().padEnd(43)}│`);
  console.log(`│ • Custo Total de IA (USD):      ${formatUSD(totalCostUSD).padEnd(43)}│`);
  console.log(`│ • Custo Total Estimado (BRL):   ${formatBRL(estimatedCostBRL).padEnd(43)}│`);
  console.log(`│ • Total Tokens Entrada:         ${totalInputTokens.toLocaleString("pt-BR").padEnd(43)}│`);
  console.log(`│ • Total Tokens Saída:           ${totalOutputTokens.toLocaleString("pt-BR").padEnd(43)}│`);
  console.log(`│ • Aproveitamento de Cache:      ${`${cacheHitRatio.toFixed(1)}% dos tokens de entrada`.padEnd(43)}│`);
  console.log(`│ • Custo de IA por Lead:         ${formatBRL(costPerLeadBRL).padEnd(43)}│`);
  console.log(`│ • Custo de IA por Venda Fechada:${formatBRL(costPerSaleBRL).padEnd(43)}│`);
  console.log(
    `│ • ROI da Operação de IA:        ${(roiIA !== null ? `${roiIA.toFixed(1)}x de retorno` : "N/D").padEnd(43)}│`,
  );
  console.log("└──────────────────────────────────────────────────────────────────────────────┘\n");

  // 4. VEREDITO & ALAVANCAS
  console.log("================================================================================");
  console.log("💡 VEREDITO & RECOMENDAÇÕES");
  console.log("================================================================================");

  if (totalLeads === 0) {
    console.log("⚠️  Nenhum lead encontrado no período.");
  } else {
    if (conversionRate < 0.05) {
      console.log("• [Vendas Abaixo do Potencial]: Conversão < 5%. O agente atende, mas não fecha. Insira um gatilho de fechamento explícito ou link de compra direto.");
    } else if (conversionRate >= 0.15) {
      console.log("• [Excelente Conversão]: Conversão ≥ 15%. Seu agente está performando acima da média!");
    } else {
      console.log("• [Conversão Saudável]: Conversão entre 5% e 15%. Há espaço para otimizar tempo de resposta e follow-up.");
    }

    if (cacheHitRatio < 30) {
      console.log("• [Desperdício em IA]: Aproveitamento de cache < 30%. Habilite prompt caching para economizar tokens.");
    } else {
      console.log("• [Eficiência de IA]: Cache hit saudável (> 30%).");
    }

    if (costPerSaleBRL > 0 && ticketMedioBRL > 0) {
      const pctCusto = (costPerSaleBRL / ticketMedioBRL) * 100;
      console.log(`• [Unit Economics]: O custo de IA consome ${pctCusto.toFixed(2)}% de cada venda.`);
    }
  }
  console.log("================================================================================\n");
}

run().catch((err) => {
  console.error("Erro fatal na execução do diagnóstico:", err);
  process.exit(1);
});
