import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O FUNIL DE NASCIMENTO É ESCOLHIDO POR REGRA DECLARADA NO FUNIL (CENTRAL-EMPRESAS-001, 5a).
 *
 * ─── O que se pede ──────────────────────────────────────────────────────────
 * Hoje `garantirLeadDaConversa` só conhece três destinos: o funil da campanha,
 * o funil de clientes (`is_client_pipeline` + `cliente_pela_agenda`) e o funil
 * padrão (`is_default`). Todo contato conhecido que não tem negócio aberto
 * nasce no padrão — numa instalação real, a TRIAGEM — e alguém o recria à mão
 * no funil certo: é de onde vêm os negócios duplicados.
 *
 * A regra nova mora em `crm_pipelines.settings.nascimento` (jsonb que já existe,
 * a mesma casa de `reabertura` e `canonical_tags`; nenhuma migration):
 *
 *   { "tags_do_contato":   ["contexto:labest"],      // contacts.tags
 *     "sessoes_do_canal":  ["<channel_session_id>"], // o número de WhatsApp
 *     "origens_do_contato":["site"],                 // contacts.source
 *     "retomar_no_inbound": true }                    // PB-15..PB-20
 *
 * Precedência: campanha > retomada > tag > sessão > origem > funil de clientes
 * > padrão. Empate numa camada (dois funis reclamam a mesma tag) não escolhe:
 * a camada é pulada e o empate vai para o log. Toda falha cai no padrão — a
 * regra do cabeçalho de `nascimento-do-lead.ts` ("errar o funil é visível, não
 * nascer é a pessoa sumir").
 *
 * ─── Por que a regra LÊ O ESTADO e não reage a evento ───────────────────────
 * `crm_manage_tags` (MCP) grava a tag sem emitir `contact.tag_added`; uma regra
 * de automação por evento nunca a vê (WP7 §1). A regra de nascimento lê
 * `contacts.tags` no momento da mensagem: QUALQUER caminho que gravou a tag
 * vale. PB-13 prova isso, e prova que a decisão não consulta eventos.
 *
 * ─── O banco de mentira ─────────────────────────────────────────────────────
 * Com estado, por tabela. Método de query builder desconhecido LANÇA. A RPC
 * `fn_nascer_lead_da_conversa` é emulada com a mesma regra do banco (devolve
 * NULL quando o contato já tem negócio aberto), e o UPDATE de etapa emula o
 * gatilho `fn_crm_lead_close_on_stage` (etapa aberta reabre won/lost).
 *
 * ─── Vermelho pela razão certa ──────────────────────────────────────────────
 * Os casos de regra/retomada estão vermelhos porque o nascimento ignora
 * `settings.nascimento`. Os controles (marcados CONTROLE) descrevem o que já
 * vale hoje e têm de continuar verdes depois da fase verde.
 *
 * ─── Sabotagens que a fase verde tem de rodar (e ver vermelho) ──────────────
 *  S1 tirar o filtro `is_archived=false` da leitura das regras   → PB-7
 *  S2 escolher o primeiro funil num empate em vez de pular          → PB-9
 *  S3 trocar a ordem tag > sessão                                    → PB-5
 *  S4 tirar a normalização (trim + minúsculas) da tag                → PB-2
 *  S5 consultar a regra ANTES da checagem de negócio aberto          → PB-11
 *  S6 tirar o filtro `status <> 'open'` do UPDATE da retomada        → PB-20
 *  S7 aceitar `moved_to_another_pipeline` como candidato à retomada  → PB-18
 *
 * Fixtures sintéticas: ids fixos, nomes inventados, nenhum dado de pessoa.
 */

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger }));

const atividades = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    atividades.push(input);
    return { ok: true };
  }),
}));

const clientePelaAgenda = vi.hoisted(() => ({ ligado: false }));
vi.mock("@/lib/contacts/cliente-pela-agenda", () => ({
  lerClientePelaAgenda: vi.fn(async () => clientePelaAgenda.ligado),
}));

const ORG = "5a000000-0000-4000-8000-000000000001";
const OUTRA_ORG = "5a000000-0000-4000-8000-000000000002";
const CONTATO = "5a000000-0000-4000-8000-0000000000c1";
const CONVERSA = "5a000000-0000-4000-8000-0000000000a1";
const SESSAO_LAB = "5a000000-0000-4000-8000-0000000000d1";
const SESSAO_GERAL = "5a000000-0000-4000-8000-0000000000d2";

const P_TRIAGEM = "5a000000-0000-4000-8000-000000000101";
const P_CONTAS = "5a000000-0000-4000-8000-000000000102";
const P_CANAIS = "5a000000-0000-4000-8000-000000000103";
const P_PCL = "5a000000-0000-4000-8000-000000000104";
const P_CLIENTES = "5a000000-0000-4000-8000-000000000105";
const P_CAMPANHA = "5a000000-0000-4000-8000-000000000106";

const S_TRIAGEM_NOVO = "5a000000-0000-4000-8000-000000000201";
const S_CONTAS_NOVO = "5a000000-0000-4000-8000-000000000202";
const S_CONTAS_GANHO = "5a000000-0000-4000-8000-000000000203";
const S_CONTAS_PERDA = "5a000000-0000-4000-8000-000000000204";
const S_CANAIS_NOVO = "5a000000-0000-4000-8000-000000000205";
const S_PCL_NOVO = "5a000000-0000-4000-8000-000000000206";
const S_CLIENTES_NOVO = "5a000000-0000-4000-8000-000000000207";
const S_CAMPANHA_NOVO = "5a000000-0000-4000-8000-000000000208";

const LEAD_ANTIGO = "5a000000-0000-4000-8000-000000000301";

type Row = Record<string, unknown>;
type Filtro = { op: "eq" | "neq" | "is" | "in" | "not_is"; col: string; val: unknown };

interface Banco {
  client: never;
  tabelas: Record<string, Row[]>;
  acessos: string[];
  rpcs: Array<{ nome: string; args: Row }>;
  updates: Array<{ tabela: string; patch: Row; afetadas: string[] }>;
  antesDoUpdate?: (tabela: string) => void;
}

function bancoFalso(tabelas: Record<string, Row[]>): Banco {
  const banco: Banco = { client: null as never, tabelas, acessos: [], rpcs: [], updates: [] };
  let seq = 0;

  function casa(row: Row, f: Filtro): boolean {
    const v = row[f.col];
    switch (f.op) {
      case "eq":
        return v === f.val;
      case "neq":
        return v !== f.val;
      case "is":
        return f.val === null ? v === null || v === undefined : v === f.val;
      case "not_is":
        return f.val === null ? v !== null && v !== undefined : v !== f.val;
      case "in":
        return (f.val as unknown[]).includes(v);
    }
  }

  function from(tabela: string) {
    banco.acessos.push(tabela);
    const filtros: Filtro[] = [];
    const ordens: Array<[string, boolean]> = [];
    let limite = Number.POSITIVE_INFINITY;
    let operacao: "select" | "update" = "select";
    let patch: Row | null = null;

    const linhas = () => (banco.tabelas[tabela] ??= []);
    const filtradas = () => linhas().filter((r) => filtros.every((f) => casa(r, f)));

    function ordenadas(): Row[] {
      const copia = [...filtradas()];
      copia.sort((a, b) => {
        for (const [col, asc] of ordens) {
          const va = a[col];
          const vb = b[col];
          if (va === vb) continue;
          if (va === null || va === undefined) return 1;
          if (vb === null || vb === undefined) return -1;
          const diff =
            typeof va === "number" && typeof vb === "number"
              ? va - vb
              : String(va).localeCompare(String(vb));
          if (diff !== 0) return asc ? diff : -diff;
        }
        return 0;
      });
      return copia.slice(0, limite === Number.POSITIVE_INFINITY ? undefined : limite);
    }

    function aplicaUpdate(): Row[] {
      banco.antesDoUpdate?.(tabela);
      const afetadas = filtradas();
      for (const row of afetadas) {
        Object.assign(row, patch);
        if (tabela === "crm_leads" && patch && "stage_id" in patch) {
          const etapa = (banco.tabelas.crm_stages ?? []).find((s) => s.id === row.stage_id);
          if (etapa?.is_won) row.status = "won";
          else if (etapa?.is_lost) row.status = "lost";
          else if (row.status === "won" || row.status === "lost") {
            row.status = "open";
            row.closed_at = null;
          }
        }
      }
      banco.updates.push({ tabela, patch: { ...(patch ?? {}) }, afetadas: afetadas.map((r) => String(r.id)) });
      return afetadas;
    }

    function resolve(unico: boolean) {
      if (operacao === "update") {
        const afetadas = aplicaUpdate();
        return { data: unico ? (afetadas[0] ?? null) : afetadas, error: null, count: afetadas.length };
      }
      const rs = ordenadas();
      return { data: unico ? (rs[0] ?? null) : rs, error: null };
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => (filtros.push({ op: "eq", col, val }), builder),
      neq: (col: string, val: unknown) => (filtros.push({ op: "neq", col, val }), builder),
      is: (col: string, val: unknown) => (filtros.push({ op: "is", col, val }), builder),
      in: (col: string, val: unknown[]) => (filtros.push({ op: "in", col, val }), builder),
      not: (col: string, op: string, val: unknown) => {
        if (op !== "is") throw new Error(`dublê: not(${col}, ${op}) não implementado`);
        filtros.push({ op: "not_is", col, val });
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => (
        ordens.push([col, opts?.ascending ?? true]), builder
      ),
      limit: (n: number) => ((limite = n), builder),
      update: (p: Row) => ((operacao = "update"), (patch = p), builder),
      maybeSingle: async () => resolve(true),
      single: async () => resolve(true),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(false)).then(ok, ko),
    };

    return new Proxy(builder, {
      get(alvo, prop) {
        if (prop in alvo) return alvo[prop as string];
        if (typeof prop === "symbol") return undefined;
        throw new Error(`dublê: método ${String(prop)} não implementado (${tabela})`);
      },
    });
  }

  async function rpc(nome: string, args: Row) {
    banco.rpcs.push({ nome, args });
    if (nome === "fn_nascer_lead_da_conversa") {
      const aberto = (banco.tabelas.crm_leads ?? []).find(
        (l) =>
          l.organization_id === args.p_org && l.contact_id === args.p_contact && l.status === "open",
      );
      if (aberto) return { data: null, error: null };
      seq += 1;
      const id = `5a000000-0000-4000-8000-0000000009${String(seq).padStart(2, "0")}`;
      (banco.tabelas.crm_leads ??= []).push({
        id,
        organization_id: args.p_org,
        contact_id: args.p_contact,
        pipeline_id: args.p_pipeline,
        stage_id: args.p_stage,
        title: args.p_title,
        source: args.p_source,
        source_metadata: args.p_source_metadata ?? {},
        tags: args.p_tags ?? [],
        custom_fields: {},
        status: "open",
        closed_at: null,
        lost_reason: null,
        retomado_de_lead_id: null,
        created_at: "2026-10-09T12:00:00.000Z",
      });
      return { data: id, error: null };
    }
    if (nome === "emit_event") return { data: null, error: null };
    throw new Error(`dublê: rpc ${nome} não implementada`);
  }

  banco.client = { from, rpc } as never;
  return banco;
}

function etapa(id: string, pipeline: string, position: number, extra: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    pipeline_id: pipeline,
    position,
    is_won: false,
    is_lost: false,
    is_archived: false,
    ...extra,
  };
}

function funil(id: string, extra: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    is_default: false,
    is_client_pipeline: false,
    is_archived: false,
    settings: {},
    ...extra,
  };
}

interface Cenario {
  tagsDoContato?: string[];
  sourceDoContato?: string;
  sessaoDaConversa?: string;
  isPersonal?: boolean;
  firstServiceAt?: string | null;
  funis?: Row[];
  leads?: Row[];
  campanha?: { pipeline_id: string; stage_id: string | null } | null;
}

function montar(c: Cenario = {}): Banco {
  return bancoFalso({
    contacts: [
      {
        id: CONTATO,
        organization_id: ORG,
        is_blocked: false,
        is_personal: c.isPersonal ?? false,
        display_name: "Contato Sintético",
        name: "Contato Sintético",
        phone_number: "+550000000000",
        source: c.sourceDoContato ?? "whatsapp",
        source_metadata: {},
        first_service_at: c.firstServiceAt ?? null,
        tags: c.tagsDoContato ?? [],
      },
    ],
    conversations: [
      {
        id: CONVERSA,
        organization_id: ORG,
        contact_id: CONTATO,
        channel_session_id: c.sessaoDaConversa ?? SESSAO_GERAL,
        channel: "whatsapp",
      },
    ],
    crm_pipelines: c.funis ?? [
      funil(P_TRIAGEM, { is_default: true }),
      funil(P_CONTAS, { settings: { nascimento: { tags_do_contato: ["contexto:labest"] } } }),
      funil(P_CANAIS, { settings: { nascimento: { tags_do_contato: ["tipo:parceiro"] } } }),
      funil(P_PCL, { settings: { nascimento: { sessoes_do_canal: [SESSAO_LAB] } } }),
    ],
    crm_stages: [
      etapa(S_TRIAGEM_NOVO, P_TRIAGEM, 1000),
      etapa(S_CONTAS_NOVO, P_CONTAS, 1000),
      etapa(S_CONTAS_GANHO, P_CONTAS, 3000, { is_won: true }),
      etapa(S_CONTAS_PERDA, P_CONTAS, 4000, { is_lost: true }),
      etapa(S_CANAIS_NOVO, P_CANAIS, 1000),
      etapa(S_PCL_NOVO, P_PCL, 1000),
      etapa(S_CLIENTES_NOVO, P_CLIENTES, 1000),
      etapa(S_CAMPANHA_NOVO, P_CAMPANHA, 1000),
    ],
    crm_leads: c.leads ?? [],
    campaign_recipients: c.campanha
      ? [
          {
            organization_id: ORG,
            conversation_id: CONVERSA,
            campaign_id: "5a000000-0000-4000-8000-0000000000e1",
            sent_at: "2026-10-08T10:00:00.000Z",
            campaigns: { name: "Campanha sintética", ...c.campanha },
          },
        ]
      : [],
  });
}

async function nascer(banco: Banco) {
  const { garantirLeadDaConversa } = await import("@/lib/leads/nascimento-do-lead");
  return garantirLeadDaConversa(banco.client, {
    organizationId: ORG,
    contactId: CONTATO,
    conversationId: CONVERSA,
    nomeDoContato: "Contato Sintético",
  });
}

function nascimentos(banco: Banco) {
  return banco.rpcs.filter((r) => r.nome === "fn_nascer_lead_da_conversa");
}

function abertosDoContato(banco: Banco): Row[] {
  return (banco.tabelas.crm_leads ?? []).filter(
    (l) => l.contact_id === CONTATO && l.status === "open",
  );
}

beforeEach(() => {
  atividades.length = 0;
  clientePelaAgenda.ligado = false;
  logger.warn.mockClear();
});

// ─── Nascimento por regra ──────────────────────────────────────────────────

describe("PB-1..PB-5 o funil de nascimento sai da regra declarada no funil", () => {
  it("PB-1 contato com a tag declarada nasce no funil que a declarou, não na TRIAGEM", async () => {
    const banco = montar({ tagsDoContato: ["contexto:labest"] });
    const r = await nascer(banco);

    expect(r).toMatchObject({ criado: true, pipelineId: P_CONTAS, stageId: S_CONTAS_NOVO });
    // O escritor continua sendo a RPC com trava: a regra escolhe o destino, não
    // abre um segundo caminho de INSERT (é o que impede as três mensagens de
    // virarem três negócios).
    expect(nascimentos(banco)).toHaveLength(1);
    expect(nascimentos(banco)[0]!.args.p_pipeline).toBe(P_CONTAS);
    expect(abertosDoContato(banco).map((l) => l.pipeline_id)).toEqual([P_CONTAS]);
  });

  it("PB-2 a tag casa sem diferenciar maiúsculas nem espaços nas pontas", async () => {
    const banco = montar({ tagsDoContato: ["  Contexto:LabEst "] });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CONTAS });
  });

  it("PB-3 conversa que chegou pelo número declarado nasce no funil desse número", async () => {
    const banco = montar({ sessaoDaConversa: SESSAO_LAB });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_PCL, stageId: S_PCL_NOVO });
  });

  it("PB-4 origem do contato declarada (contacts.source) escolhe o funil", async () => {
    const banco = montar({
      sourceDoContato: "site",
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil(P_CANAIS, { settings: { nascimento: { origens_do_contato: ["site"] } } }),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CANAIS });
  });

  it("PB-5 tag vence número: quem a pessoa É pesa mais que por onde ela escreveu", async () => {
    const banco = montar({ tagsDoContato: ["tipo:parceiro"], sessaoDaConversa: SESSAO_LAB });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CANAIS });
  });

  it("PB-5b regra declarada vence o funil de clientes da agenda", async () => {
    clientePelaAgenda.ligado = true;
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      firstServiceAt: "2026-09-01T10:00:00.000Z",
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil(P_CLIENTES, { is_client_pipeline: true }),
        funil(P_CONTAS, { settings: { nascimento: { tags_do_contato: ["contexto:labest"] } } }),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CONTAS });
  });
});

describe("PB-6..PB-10 toda falha da regra cai no padrão (CONTROLES de hoje + guarda)", () => {
  it("PB-6 CONTROLE nada casa: nasce na TRIAGEM, primeira etapa", async () => {
    const banco = montar({ tagsDoContato: ["outra:coisa"] });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM, stageId: S_TRIAGEM_NOVO });
  });

  it("PB-7 CONTROLE regra em funil ARQUIVADO não vale: nasce na TRIAGEM", async () => {
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil(P_CONTAS, {
          is_archived: true,
          settings: { nascimento: { tags_do_contato: ["contexto:labest"] } },
        }),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM });
  });

  it("PB-8 CONTROLE funil da regra sem etapa utilizável: nasce na TRIAGEM", async () => {
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil("5a000000-0000-4000-8000-0000000001ff", {
          settings: { nascimento: { tags_do_contato: ["contexto:labest"] } },
        }),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM });
  });

  it("PB-9 dois funis reclamam a mesma tag: não adivinha, nasce na TRIAGEM e avisa no log", async () => {
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil(P_CONTAS, { settings: { nascimento: { tags_do_contato: ["contexto:labest"] } } }),
        funil(P_CANAIS, { settings: { nascimento: { tags_do_contato: ["contexto:labest"] } } }),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM });
    const avisos = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(avisos.some((m) => /ambígu|ambigu/i.test(m))).toBe(true);
  });

  it("PB-10 CONTROLE campanha com funil declarado vence a regra", async () => {
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      campanha: { pipeline_id: P_CAMPANHA, stage_id: S_CAMPANHA_NOVO },
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil(P_CONTAS, { settings: { nascimento: { tags_do_contato: ["contexto:labest"] } } }),
        funil(P_CAMPANHA),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CAMPANHA });
  });

  it("PB-10b CONTROLE regra de OUTRA organização nunca é lida", async () => {
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      funis: [
        funil(P_TRIAGEM, { is_default: true }),
        funil(P_CONTAS, {
          organization_id: OUTRA_ORG,
          settings: { nascimento: { tags_do_contato: ["contexto:labest"] } },
        }),
      ],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM });
  });
});

// ─── Um negócio aberto por contato ──────────────────────────────────────────

describe("PB-11..PB-12 a regra nunca fura 'um aberto por contato' nem o contato pessoal", () => {
  it("PB-11 CONTROLE contato com negócio aberto em QUALQUER funil: nada nasce, regra nem é lida", async () => {
    const banco = montar({
      tagsDoContato: ["contexto:labest"],
      leads: [
        {
          id: LEAD_ANTIGO,
          organization_id: ORG,
          contact_id: CONTATO,
          pipeline_id: P_CANAIS,
          stage_id: S_CANAIS_NOVO,
          status: "open",
        },
      ],
    });
    const r = await nascer(banco);
    expect(r).toEqual({ criado: false, motivo: "ja_existe" });
    expect(nascimentos(banco)).toHaveLength(0);
    expect(banco.acessos).not.toContain("crm_pipelines");
    expect(abertosDoContato(banco)).toHaveLength(1);
  });

  it("PB-12 CONTROLE contato pessoal com a tag da regra: nunca nasce", async () => {
    const banco = montar({ tagsDoContato: ["contexto:labest"], isPersonal: true });
    const r = await nascer(banco);
    expect(r).toEqual({ criado: false, motivo: "contato_pessoal" });
    expect(nascimentos(banco)).toHaveLength(0);
  });
});

// ─── A tag que não emitiu evento ────────────────────────────────────────────

describe("PB-13..PB-14 a regra lê o estado do contato e conta por que escolheu", () => {
  it("PB-13 tag gravada por caminho que NÃO emite tag_added (crm_manage_tags) ainda decide o funil", async () => {
    // O contato tem a tag; nenhum evento existe. Se a decisão dependesse de
    // `contact.tag_added`, o lead nasceria na TRIAGEM.
    const banco = montar({ tagsDoContato: ["contexto:labest"] });
    banco.tabelas.events = [];
    banco.tabelas.automation_rules = [];
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CONTAS });
    expect(banco.acessos).not.toContain("events");
    expect(banco.acessos).not.toContain("automation_rules");
  });

  it("PB-14 a linha do tempo diz QUAL regra escolheu o funil", async () => {
    const banco = montar({ tagsDoContato: ["contexto:labest"] });
    await nascer(banco);
    const criado = atividades.find((a) => a.type === "lead_created");
    expect(criado).toBeDefined();
    expect((criado!.payload as Row).regra_de_entrada).toEqual({
      tipo: "tag",
      valor: "contexto:labest",
      pipeline_id: P_CONTAS,
    });
  });
});

// ─── Retomar em vez de criar em branco ──────────────────────────────────────

function leadFechado(extra: Row = {}): Row {
  return {
    id: LEAD_ANTIGO,
    organization_id: ORG,
    contact_id: CONTATO,
    pipeline_id: P_CONTAS,
    stage_id: S_CONTAS_PERDA,
    status: "lost",
    lost_reason: "no_response",
    closed_at: "2026-09-20T10:00:00.000Z",
    custom_fields: { cnpj_hash: "sintetico", volume_mes: 12 },
    tags: ["chapeu:representante"],
    retomado_de_lead_id: null,
    ...extra,
  };
}

function funisComRetomada(reabertura?: "mesmo_registro" | "novo_negocio"): Row[] {
  return [
    funil(P_TRIAGEM, { is_default: true }),
    funil(P_CONTAS, {
      settings: {
        nascimento: { retomar_no_inbound: true },
        ...(reabertura ? { reabertura } : {}),
      },
    }),
  ];
}

describe("PB-15..PB-20 contato que volta retoma o negócio encerrado em vez de nascer em branco", () => {
  it("PB-15 funil com retomada (modo padrão mesmo_registro): o MESMO negócio reabre, nada nasce", async () => {
    const banco = montar({ funis: funisComRetomada(), leads: [leadFechado()] });
    const r = await nascer(banco);

    expect(nascimentos(banco)).toHaveLength(0);
    expect(r).toMatchObject({ leadId: LEAD_ANTIGO, retomado: "mesmo_registro" });
    const antigo = banco.tabelas.crm_leads!.find((l) => l.id === LEAD_ANTIGO)!;
    expect(antigo.status).toBe("open");
    expect(antigo.stage_id).toBe(S_CONTAS_NOVO);
    // campos, tags e histórico ficam: é o mesmo registro.
    expect(antigo.custom_fields).toEqual({ cnpj_hash: "sintetico", volume_mes: 12 });
    expect(antigo.tags).toEqual(["chapeu:representante"]);
    expect(abertosDoContato(banco)).toHaveLength(1);
  });

  it("PB-16 funil novo_negocio: nasce NOVO no mesmo funil, apontando o anterior e com campos copiados", async () => {
    const banco = montar({ funis: funisComRetomada("novo_negocio"), leads: [leadFechado()] });
    const r = await nascer(banco);

    expect(nascimentos(banco)).toHaveLength(1);
    expect(nascimentos(banco)[0]!.args.p_pipeline).toBe(P_CONTAS);
    expect(r).toMatchObject({ criado: true, pipelineId: P_CONTAS, retomado: "novo_negocio" });
    const novo = abertosDoContato(banco)[0]!;
    expect(novo.retomado_de_lead_id).toBe(LEAD_ANTIGO);
    expect(novo.custom_fields).toEqual({ cnpj_hash: "sintetico", volume_mes: 12 });
    expect(novo.tags).toEqual(expect.arrayContaining(["chapeu:representante"]));
    const antigo = banco.tabelas.crm_leads!.find((l) => l.id === LEAD_ANTIGO)!;
    expect(antigo.status).toBe("lost");
  });

  it("PB-17 negócio GANHO nunca é desganho: a retomada abre um novo apontando o ganho", async () => {
    const banco = montar({
      funis: funisComRetomada(),
      leads: [leadFechado({ status: "won", stage_id: S_CONTAS_GANHO, lost_reason: null })],
    });
    const r = await nascer(banco);

    expect(r).toMatchObject({ criado: true, pipelineId: P_CONTAS, retomado: "novo_negocio" });
    const antigo = banco.tabelas.crm_leads!.find((l) => l.id === LEAD_ANTIGO)!;
    expect(antigo.status).toBe("won");
    expect(antigo.stage_id).toBe(S_CONTAS_GANHO);
    expect(abertosDoContato(banco)[0]!.retomado_de_lead_id).toBe(LEAD_ANTIGO);
  });

  it("PB-18 CONTROLE origem de troca de funil (moved_to_another_pipeline) não é retomada", async () => {
    const banco = montar({
      funis: funisComRetomada(),
      leads: [leadFechado({ lost_reason: "moved_to_another_pipeline" })],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM });
    const antigo = banco.tabelas.crm_leads!.find((l) => l.id === LEAD_ANTIGO)!;
    expect(antigo.status).toBe("lost");
  });

  it("PB-19 CONTROLE funil sem retomada declarada: comportamento de hoje, nasce em branco na TRIAGEM", async () => {
    const banco = montar({
      funis: [funil(P_TRIAGEM, { is_default: true }), funil(P_CONTAS)],
      leads: [leadFechado()],
    });
    const r = await nascer(banco);
    expect(r).toMatchObject({ criado: true, pipelineId: P_TRIAGEM });
    expect(abertosDoContato(banco)[0]!.custom_fields).toEqual({});
  });

  it("PB-20 duas mensagens juntas: quem chega depois da reabertura não reabre de novo nem cria", async () => {
    const banco = montar({ funis: funisComRetomada(), leads: [leadFechado()] });
    // Outra mensagem reabriu o negócio entre a leitura e o UPDATE desta.
    banco.antesDoUpdate = (tabela) => {
      if (tabela !== "crm_leads") return;
      const antigo = banco.tabelas.crm_leads!.find((l) => l.id === LEAD_ANTIGO)!;
      antigo.status = "open";
      antigo.stage_id = S_CONTAS_NOVO;
      banco.antesDoUpdate = undefined;
    };
    const r = await nascer(banco);
    expect(r).toEqual({ criado: false, motivo: "ja_existe" });
    expect(nascimentos(banco)).toHaveLength(0);
    expect(abertosDoContato(banco)).toHaveLength(1);
    const update = banco.updates.find((u) => u.tabela === "crm_leads");
    expect(update?.afetadas).toEqual([]);
  });
});

// ─── Dublê ──────────────────────────────────────────────────────────────────

describe("harness: o dublê não verdeia por omissão", () => {
  it("CONTROLE método desconhecido do query builder lança", () => {
    const banco = montar();
    const q = (banco.client as unknown as { from: (t: string) => Record<string, () => unknown> }).from(
      "crm_leads",
    );
    expect(() => q.ilike!()).toThrow(/não implementado/);
  });

  it("CONTROLE a RPC emulada recusa o segundo aberto do mesmo contato", async () => {
    const banco = montar();
    const rpc = (banco.client as unknown as { rpc: (n: string, a: Row) => Promise<{ data: unknown }> }).rpc;
    const args = { p_org: ORG, p_contact: CONTATO, p_pipeline: P_TRIAGEM, p_stage: S_TRIAGEM_NOVO };
    expect((await rpc("fn_nascer_lead_da_conversa", args)).data).toBeTruthy();
    expect((await rpc("fn_nascer_lead_da_conversa", args)).data).toBeNull();
  });
});
