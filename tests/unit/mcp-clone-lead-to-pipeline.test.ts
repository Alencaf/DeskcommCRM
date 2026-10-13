import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as EmissorDeAtividade from "@/lib/leads/activity-emitter";

/**
 * `crm_clone_lead_to_pipeline` — TROCAR DE FUNIL PELO MCP SEM DUPLICAR E SEM PERDER HISTÓRICO
 * (CENTRAL-EMPRESAS-001 5a; é o PR-6 do WP1 §4.6, com a guarda de duplicata do 5a).
 *
 * ─── O que se pede ──────────────────────────────────────────────────────────
 * A tela já leva um negócio para outro funil (`/api/v1/leads/[id]/clone`, desde
 * a v1.36; botão "Levar para outro funil" desde a v1.48). Agente externo não
 * tem essa porta: `crm_move_lead_stage` devolve `pipeline_immutable_use_clone`
 * e não existe tool de clone. Hoje um agente "troca de funil" com
 * `crm_create_lead` + fechar o antigo — duas chamadas, e uma mensagem entre
 * elas cria o terceiro card na TRIAGEM (WP7 §2, corrida).
 *
 * A tool faz o que a rota faz (`lib/leads/clonar-para-funil.ts`): o negócio
 * nasce no destino com contato, valor, dono, tags do negócio e TODOS os
 * `custom_fields`; a origem fecha `lost` com `moved_to_another_pipeline`
 * (canônico, fora das métricas de perda) e `source_metadata.movido_para`; o
 * clone ganha a linha `moved_from_pipeline` na linha do tempo. A origem NUNCA é
 * apagada: notas e histórico continuam nela, e os dois lados apontam um para o
 * outro. E recusa o que a rota hoje não recusa: contato que já tem negócio
 * aberto no funil de destino (PB-25).
 *
 * Contrato do WP1: `simulate` por padrão; `apply` exige `reason`; contato
 * pessoal é recusado. Mora em `lib/mcp/tools/**` (fora do teto do núcleo).
 *
 * ─── Por que chama o handler e não o servidor MCP ───────────────────────────
 * O PR-1 já prova, no servidor, allowlist por token e auditoria para QUALQUER
 * tool registrada. Aqui o que importa é o efeito no banco; o registro em
 * `allTools` é afirmado à parte (PB-21), para que esquecer de registrar
 * continue vermelho.
 *
 * ─── Nenhum "nada gravado" é vácuo ──────────────────────────────────────────
 * Enquanto a tool não existe, `ferramenta()` lança: todo caso fica vermelho
 * pela razão certa antes de afirmar ausência de escrita.
 *
 * Sabotagens da fase verde: (1) default de `mode` para "apply" → PB-22;
 * (2) tirar a busca de aberto do contato no destino → PB-25; (3) apagar a
 * origem em vez de fechá-la → PB-24; (4) fechar com `other` → PB-23.
 */

const atividades = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/leads/activity-emitter", async (importOriginal) => ({
  ...(await importOriginal<typeof EmissorDeAtividade>()),
  emitLeadActivity: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    atividades.push(input);
    return { ok: true };
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
}));

const ORG = "5a000000-0000-4000-8000-00000000a001";
const TOKEN = "5a000000-0000-4000-8000-00000000a0aa";
const CONTATO = "5a000000-0000-4000-8000-00000000a0c1";
const CONTATO_PESSOAL = "5a000000-0000-4000-8000-00000000a0c2";
const P_TRIAGEM = "5a000000-0000-4000-8000-00000000a101";
const P_CONTAS = "5a000000-0000-4000-8000-00000000a102";
const S_TRIAGEM_NOVO = "5a000000-0000-4000-8000-00000000a201";
const S_TRIAGEM_PERDA = "5a000000-0000-4000-8000-00000000a202";
const S_CONTAS_NOVO = "5a000000-0000-4000-8000-00000000a203";
const S_CONTAS_PERDA = "5a000000-0000-4000-8000-00000000a204";
const LEAD = "5a000000-0000-4000-8000-00000000a301";
const LEAD_NO_DESTINO = "5a000000-0000-4000-8000-00000000a302";
const ATIVIDADE_ANTIGA = "5a000000-0000-4000-8000-00000000a401";

type Row = Record<string, unknown>;

/**
 * Dublê com estado e PERMISSIVO em tabela (tabela desconhecida é lista vazia),
 * porque a fase verde decide por onde passa (`createLeadHandler`, `encerraDemanda`
 * ou SQL próprio). Filtros, ordem e o gatilho de etapa são emulados.
 */
function bancoFalso(tabelas: Record<string, Row[]>) {
  let seq = 0;
  function from(tabela: string) {
    const filtros: Array<(r: Row) => boolean> = [];
    const ordens: Array<[string, boolean]> = [];
    let limite = Number.POSITIVE_INFINITY;
    let op: "select" | "insert" | "update" | "delete" = "select";
    let patch: Row | null = null;
    let novas: Row[] = [];
    const linhas = () => (tabelas[tabela] ??= []);
    const casadas = () => linhas().filter((r) => filtros.every((f) => f(r)));
    const ordenadas = () =>
      [...casadas()]
        .sort((a, b) => {
          for (const [c, asc] of ordens) {
            const d = Number(a[c] ?? 0) - Number(b[c] ?? 0);
            if (d !== 0) return asc ? d : -d;
          }
          return 0;
        })
        .slice(0, limite === Number.POSITIVE_INFINITY ? undefined : limite);

    function resolver(unico: boolean) {
      if (op === "insert") {
        linhas().push(...novas);
        return { data: unico ? novas[0] : novas, error: null };
      }
      if (op === "delete") {
        const fora = new Set(casadas());
        tabelas[tabela] = linhas().filter((r) => !fora.has(r));
        return { data: null, error: null };
      }
      if (op === "update") {
        const afetadas = casadas();
        for (const r of afetadas) {
          Object.assign(r, patch);
          if (tabela === "crm_leads" && patch && "stage_id" in patch) {
            const e = (tabelas.crm_stages ?? []).find((s) => s.id === r.stage_id);
            if (e?.is_won) r.status = "won";
            else if (e?.is_lost) r.status = "lost";
          }
        }
        return { data: unico ? (afetadas[0] ?? null) : afetadas, error: null };
      }
      const rs = ordenadas();
      return { data: unico ? (rs[0] ?? null) : rs, error: null };
    }

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filtros.push((r) => r[c] !== v), b),
      in: (c: string, v: unknown[]) => (filtros.push((r) => v.includes(r[c])), b),
      is: (c: string, v: unknown) => (filtros.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
      not: (c: string, o: string, v: unknown) => (
        filtros.push((r) => (o === "is" && v === null ? r[c] != null : r[c] !== v)), b
      ),
      order: (c: string, o?: { ascending?: boolean }) => (ordens.push([c, o?.ascending ?? true]), b),
      limit: (n: number) => ((limite = n), b),
      insert: (v: Row | Row[]) => {
        op = "insert";
        novas = (Array.isArray(v) ? v : [v]).map((r) => {
          seq += 1;
          return { id: `5a000000-0000-4000-8000-0000000b${String(seq).padStart(4, "0")}`, ...r };
        });
        return b;
      },
      update: (p: Row) => ((op = "update"), (patch = p), b),
      delete: () => ((op = "delete"), b),
      maybeSingle: async () => resolver(true),
      single: async () => resolver(true),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(resolver(false)).then(ok, ko),
    };
    return b;
  }
  return {
    client: { from, rpc: async () => ({ data: null, error: null }) } as never,
    tabelas,
  };
}

function etapa(id: string, pipeline: string, position: number, extra: Row = {}): Row {
  return { id, organization_id: ORG, pipeline_id: pipeline, position, is_won: false, is_lost: false, is_archived: false, ...extra };
}

function lead(id: string, extra: Row): Row {
  return {
    id,
    organization_id: ORG,
    status: "open",
    title: "Negócio sintético",
    description: null,
    value_cents: 120000,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    expected_close_date: null,
    tags: ["contexto:labest"],
    source: "whatsapp",
    source_metadata: { canal: "whatsapp" },
    custom_fields: { cnpj_hash: "sintetico", volume_mes: 12 },
    external_id: null,
    lost_reason: null,
    closed_at: null,
    position_in_stage: 1000,
    ...extra,
  };
}

let db: ReturnType<typeof bancoFalso>;

function montar(opcoes: { abertoNoDestino?: boolean; contato?: string } = {}) {
  const contato = opcoes.contato ?? CONTATO;
  db = bancoFalso({
    contacts: [
      { id: CONTATO, organization_id: ORG, is_personal: false, is_anonymized: false },
      { id: CONTATO_PESSOAL, organization_id: ORG, is_personal: true, is_anonymized: false },
    ],
    crm_pipelines: [
      { id: P_TRIAGEM, organization_id: ORG, name: "TRIAGEM", is_archived: false, settings: {} },
      { id: P_CONTAS, organization_id: ORG, name: "Gestão de Contas", is_archived: false, settings: {} },
    ],
    crm_stages: [
      etapa(S_TRIAGEM_NOVO, P_TRIAGEM, 1000),
      etapa(S_TRIAGEM_PERDA, P_TRIAGEM, 9000, { is_lost: true }),
      etapa(S_CONTAS_NOVO, P_CONTAS, 1000),
      etapa(S_CONTAS_PERDA, P_CONTAS, 9000, { is_lost: true }),
    ],
    crm_leads: [
      lead(LEAD, { pipeline_id: P_TRIAGEM, stage_id: S_TRIAGEM_NOVO, contact_id: contato }),
      ...(opcoes.abertoNoDestino
        ? [lead(LEAD_NO_DESTINO, { pipeline_id: P_CONTAS, stage_id: S_CONTAS_NOVO, contact_id: contato })]
        : []),
    ],
    crm_lead_activities: [
      { id: ATIVIDADE_ANTIGA, organization_id: ORG, lead_id: LEAD, type: "note_added", payload: { texto: "nota sintética" } },
    ],
  });
}

async function ferramenta() {
  const { allTools } = await import("@/lib/mcp/tools/index");
  const tool = allTools.find((t) => t.name === "crm_clone_lead_to_pipeline");
  if (!tool) throw new Error("crm_clone_lead_to_pipeline não está registrada em allTools");
  return tool;
}

async function chamar(args: Row): Promise<Row> {
  const tool = await ferramenta();
  const input = z.object(tool.inputSchema).parse(args);
  try {
    return (await tool.handler(input as never, {
      organizationId: ORG,
      role: "manager",
      actor: { type: "api_token", id: TOKEN },
      apiTokenId: TOKEN,
      requestId: "5a-req",
      supabase: db.client,
    } as never)) as Row;
  } catch (e) {
    const err = e as { code?: string; status?: number; message?: string };
    return { erro: err.code ?? err.message, status: err.status };
  }
}

/** Recusa vale como `outcome: "refused"` + `code`, ou como erro com `code`. */
function codigoDaRecusa(r: Row): string | undefined {
  return (r.code as string | undefined) ?? (r.erro as string | undefined);
}

function abertosDoContato(contato = CONTATO): Row[] {
  return db.tabelas.crm_leads!.filter((l) => l.contact_id === contato && l.status === "open");
}

beforeEach(() => {
  atividades.length = 0;
  montar();
});

describe("PB-21 a tool existe e está registrada como escrita", () => {
  it("PB-21 crm_clone_lead_to_pipeline em allTools: write, mcp:write, papel agent", async () => {
    const tool = await ferramenta();
    expect(tool.category).toBe("write");
    expect(tool.requiresScope).toBe("mcp:write");
    expect(tool.requiresRole).toBe("agent");
    expect(Object.keys(tool.inputSchema)).toEqual(
      expect.arrayContaining(["lead_id", "target_pipeline_id", "mode", "reason"]),
    );
  });
});

describe("PB-22 simulate por padrão", () => {
  it("PB-22 sem `mode`: responde o que faria e não grava nada", async () => {
    const antes = JSON.stringify(db.tabelas.crm_leads);
    const r = await chamar({ lead_id: LEAD, target_pipeline_id: P_CONTAS });
    expect(r).toMatchObject({ applied: false, mode: "simulate" });
    expect(JSON.stringify(db.tabelas.crm_leads)).toBe(antes);
  });

  it("PB-28 `apply` sem `reason` é entrada inválida", async () => {
    const tool = await ferramenta();
    const lido = z
      .object(tool.inputSchema)
      .safeParse({ lead_id: LEAD, target_pipeline_id: P_CONTAS, mode: "apply" });
    const r = lido.success ? await chamar({ lead_id: LEAD, target_pipeline_id: P_CONTAS, mode: "apply" }) : null;
    expect(lido.success === false || codigoDaRecusa(r!) === "invalid_input").toBe(true);
    expect(abertosDoContato().map((l) => l.id)).toEqual([LEAD]);
  });
});

describe("PB-23..PB-24 apply troca de funil sem duplicar e sem perder nada", () => {
  it("PB-23 o negócio fica no destino com campos, tags, valor e contato; a origem fecha como transferência", async () => {
    const r = await chamar({
      lead_id: LEAD,
      target_pipeline_id: P_CONTAS,
      mode: "apply",
      reason: "contato é conta de laboratório",
    });
    expect(r).toMatchObject({ applied: true });

    const abertos = abertosDoContato();
    expect(abertos).toHaveLength(1);
    const clone = abertos[0]!;
    expect(clone.pipeline_id).toBe(P_CONTAS);
    expect(clone.stage_id).toBe(S_CONTAS_NOVO);
    expect(clone.custom_fields).toEqual({ cnpj_hash: "sintetico", volume_mes: 12 });
    expect(clone.tags).toEqual(["contexto:labest"]);
    expect(clone.value_cents).toBe(120000);
    expect((clone.source_metadata as Row).clonado_de).toMatchObject({ lead_id: LEAD, pipeline_id: P_TRIAGEM });

    const origem = db.tabelas.crm_leads!.find((l) => l.id === LEAD)!;
    expect(origem.status).toBe("lost");
    expect(origem.lost_reason).toBe("moved_to_another_pipeline");
    expect((origem.source_metadata as Row).movido_para).toMatchObject({ lead_id: clone.id, pipeline_id: P_CONTAS });
  });

  it("PB-24 a origem não é apagada: a nota antiga fica nela e o clone conta de onde veio", async () => {
    await chamar({ lead_id: LEAD, target_pipeline_id: P_CONTAS, mode: "apply", reason: "conta de laboratório" });

    expect(db.tabelas.crm_leads!.some((l) => l.id === LEAD)).toBe(true);
    expect(db.tabelas.crm_lead_activities!.find((a) => a.id === ATIVIDADE_ANTIGA)).toMatchObject({ lead_id: LEAD });
    const clone = abertosDoContato()[0]!;
    const veio = atividades.find((a) => a.type === "moved_from_pipeline" && a.leadId === clone.id);
    expect(veio).toBeDefined();
    expect(JSON.stringify(veio!.payload)).toContain(LEAD);
  });
});

describe("PB-25..PB-27 recusas", () => {
  it("PB-25 contato já tem negócio aberto no destino: recusa, nada é criado nem fechado", async () => {
    montar({ abertoNoDestino: true });
    const r = await chamar({ lead_id: LEAD, target_pipeline_id: P_CONTAS, mode: "apply", reason: "conta" });
    expect(r).toMatchObject({ applied: false });
    expect(codigoDaRecusa(r)).toBe("destino_ja_tem_negocio_do_contato");
    expect(abertosDoContato().map((l) => l.id).sort()).toEqual([LEAD, LEAD_NO_DESTINO].sort());
    expect(db.tabelas.crm_leads).toHaveLength(2);
  });

  it("PB-26 destino = funil de origem: recusa pipeline_unchanged", async () => {
    const r = await chamar({ lead_id: LEAD, target_pipeline_id: P_TRIAGEM, mode: "apply", reason: "x" });
    expect(r).toMatchObject({ applied: false });
    expect(codigoDaRecusa(r)).toBe("pipeline_unchanged");
    expect(db.tabelas.crm_leads).toHaveLength(1);
  });

  it("PB-27 contato pessoal: recusa sem tocar o negócio", async () => {
    montar({ contato: CONTATO_PESSOAL });
    const r = await chamar({ lead_id: LEAD, target_pipeline_id: P_CONTAS, mode: "apply", reason: "x" });
    expect(r).toMatchObject({ applied: false });
    expect(codigoDaRecusa(r)).toBe("contact_personal");
    expect(abertosDoContato(CONTATO_PESSOAL)).toHaveLength(1);
  });
});

describe("harness", () => {
  it("CONTROLE crm_move_lead_stage continua recusando troca de funil (P-01 intacta)", async () => {
    const { allTools } = await import("@/lib/mcp/tools/index");
    const mover = allTools.find((t) => t.name === "crm_move_lead_stage");
    expect(mover).toBeDefined();
    expect(mover!.description).toMatch(/MESMO pipeline/);
  });
});
