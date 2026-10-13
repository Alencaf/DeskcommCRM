import fs from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpAuthResult } from "@/lib/mcp/auth";
import { TASK_SOURCE_LABELS } from "@/lib/tarefas/vocabulario-de-origem";

/**
 * FERRAMENTAS MCP DE TAREFA: `crm_create_task` e `crm_list_tasks` (PR-4).
 *
 * ─── O que se pede ──────────────────────────────────────────────────────────
 * Hoje nenhuma tool MCP toca `crm_tasks` (a rota REST só aceita cookie). Um
 * agente externo precisa abrir uma tarefa interna — em especial a de REVISÃO,
 * "um humano confira isto" — e listar o que já está aberto, sem mexer em
 * esquema nenhum: `crm_tasks` já tem tudo, inclusive `source_kind` (0464).
 *
 * ─── Por que o teste passa pelo servidor, e não por uma função ──────────────
 * Mesma razão do PR-1: as garantias são "não gravou nada", "não vazou a tarefa
 * de outra organização", "a auditoria não leva o conteúdo". Um teste que
 * chamasse o handler direto seguiria verde se alguém deixasse de registrar a
 * tool, de redigir a auditoria ou de passar pelo teto. Aqui o cliente MCP fala
 * com `createMcpServer` por transporte em memória.
 *
 * ─── O banco de mentira ─────────────────────────────────────────────────────
 * Um dublê COM ESTADO (não o dublê vazio do PR-1): linhas por tabela, filtros
 * do PostgREST, unicidade do recibo de idempotência, FKs e CHECKs de
 * `crm_tasks`. Sem estado não há como provar "uma linha só", "a segunda chamada
 * achou a primeira" nem "a organização B não aparece".
 *   - Ele NÃO tem RLS, de propósito: o cliente do MCP é service-role, e é o
 *     handler quem filtra `organization_id` (ver `lib/mcp/server.ts`). Um filtro
 *     esquecido aparece como vazamento — um dublê que filtrasse sozinho
 *     esconderia o bug. Há um caso que prova isso (grupo `harness`).
 *   - Método do query builder que o dublê não conhece LANÇA, em vez de devolver
 *     vazio: "não implementado no dublê" nunca pode virar "passou".
 *   - FKs emuladas: `created_by`/`assigned_to` apontam para `auth_users`. Gravar
 *     o id do TOKEN em `created_by` estoura como estoura em produção (a mesma
 *     armadilha que `lib/mcp/audit.ts` documenta para `actor_user_id`).
 *   - Premissa a revisar: a pertença do `assigned_to` à organização é lida em
 *     `user_organizations` (a tabela que `lib/mcp/tools/agendamento.ts` já usa).
 *
 * ─── Nenhum "nada gravado" é vácuo ──────────────────────────────────────────
 * Enquanto a tool não existe, "0 linhas gravadas" é verdade por ausência. Todo
 * teste que afirma ausência de escrita afirma ANTES uma resposta positiva da
 * tool (JSON com `applied`/`outcome`/`tasks`); sem a tool, `resposta()` lança e
 * o teste fica vermelho pela razão certa.
 *
 * ─── Fixtures ───────────────────────────────────────────────────────────────
 * Sintéticas: ids fixos, nomes e contatos inventados (`.invalid`, telefone
 * zerado). Nenhum dado de pessoa, nenhuma instalação real.
 *
 * ─── Sabotagens que a fase verde tem de rodar (e ver vermelho) ──────────────
 *  1. default de `mode` trocado para "apply"   → T3 default / simulate receipt
 *  2. tirar o `eq("organization_id")` do list  → list isolation (3 casos)
 *  3. tirar a checagem de dono do contact_id   → T8 other-org / nonexistent
 *  4. tirar a busca pela chave natural          → T13 (same call twice)
 *  5. tirar o filtro de status da chave natural → T13 control (done task)
 *  6. tirar `redigirParaAuditoria`              → audit (2 casos)
 *  7. tirar a exigência de `evidence`           → T12 without evidence
 *  8. `created_by` recebendo o id do token      → created_by never the token id
 *  9. tirar `ensureScope`/`requiresScope`       → scope pair (par já provado hoje
 *     contra `crm_create_lead`, ver o commit e o relatório)
 */
const auditSpy = vi.fn();
const tetoSpy = vi.fn(async () => undefined);

vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/mcp/rate-limit", () => ({
  verificarTetoMcp: (...a: unknown[]) => tetoSpy(...(a as [])),
}));

type Linha = Record<string, unknown>;
type Erro = { message: string; code?: string } | null;
type Resposta = { data: unknown; error: Erro; count?: number | null };

const banco = {
  tabelas: {} as Record<string, Linha[]>,
  leituras: [] as Array<{ tabela: string; colunas: string }>,
  rpcs: [] as string[],
};

const UNICOS: Record<string, string[]> = {
  idempotency_keys: ["organization_id", "key", "endpoint"],
};
const FKS: Record<string, Record<string, string>> = {
  crm_tasks: {
    contact_id: "contacts",
    lead_id: "crm_leads",
    assigned_to: "auth_users",
    created_by: "auth_users",
  },
};
const PRIORIDADES = ["low", "medium", "high", "urgent"];
const SITUACOES = ["pending", "in_progress", "done", "cancelled"];

let sequencia = 0;
const novoId = () => `00000000-0000-4000-9000-${(++sequencia).toString(16).padStart(12, "0")}`;
const agoraIso = () => new Date().toISOString();
const valor = (l: Linha, c: string) => l[c] ?? null;
const tabela = (nome: string) => (banco.tabelas[nome] ??= []);

function padroes(nome: string): Linha {
  if (nome === "crm_tasks") {
    return {
      id: novoId(),
      status: "pending",
      priority: "medium",
      created_at: agoraIso(),
      updated_at: agoraIso(),
    };
  }
  return { id: novoId() };
}

function violacao(nome: string, l: Linha): Erro {
  const fks = FKS[nome] ?? {};
  for (const [coluna, alvo] of Object.entries(fks)) {
    const v = valor(l, coluna);
    if (v !== null && !tabela(alvo).some((a) => a.id === v)) {
      return { code: "23503", message: `violates foreign key constraint on ${nome}.${coluna}` };
    }
  }
  if (nome === "crm_tasks") {
    if (typeof l.title !== "string" || l.title.trim().length === 0) {
      return { code: "23514", message: "crm_tasks_titulo_nao_vazio" };
    }
    if (!PRIORIDADES.includes(String(l.priority))) {
      return { code: "23514", message: "crm_tasks_priority_check" };
    }
    if (!SITUACOES.includes(String(l.status))) {
      return { code: "23514", message: "crm_tasks_status_check" };
    }
  }
  return null;
}

function lista(texto: unknown): string[] {
  return String(texto)
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => s.length > 0);
}

function padrao(pat: string): RegExp {
  const escapado = pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
  return new RegExp(`^${escapado}$`, "i");
}

function predicado(c: string, op: string, x: unknown): (l: Linha) => boolean {
  switch (op) {
    case "eq":
      return (l) => valor(l, c) === (x === "null" ? null : x) && x !== null;
    case "neq":
      return (l) => valor(l, c) !== x;
    case "gt":
      return (l) => valor(l, c) !== null && (valor(l, c) as string) > (x as string);
    case "gte":
      return (l) => valor(l, c) !== null && (valor(l, c) as string) >= (x as string);
    case "lt":
      return (l) => valor(l, c) !== null && (valor(l, c) as string) < (x as string);
    case "lte":
      return (l) => valor(l, c) !== null && (valor(l, c) as string) <= (x as string);
    case "in": {
      const itens = Array.isArray(x) ? x : lista(x);
      return (l) => itens.includes(valor(l, c));
    }
    case "is": {
      const alvo = x === "null" ? null : x === "true" ? true : x === "false" ? false : x;
      return (l) => valor(l, c) === alvo;
    }
    case "ilike":
    case "like":
      return (l) => typeof valor(l, c) === "string" && padrao(String(x)).test(String(valor(l, c)));
    default:
      throw new Error(`test fake: unsupported filter operator '${op}'`);
  }
}

function ou(expressao: string): (l: Linha) => boolean {
  const partes: string[] = [];
  let nivel = 0;
  let atual = "";
  for (const ch of expressao) {
    if (ch === "(") nivel++;
    if (ch === ")") nivel--;
    if (ch === "," && nivel === 0) {
      partes.push(atual);
      atual = "";
    } else atual += ch;
  }
  if (atual) partes.push(atual);
  const preds = partes.map((p) => {
    const [c, op, ...resto] = p.split(".");
    return predicado(c!, op!, resto.join("."));
  });
  return (l) => preds.some((f) => f(l));
}

class Consulta {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filtros: Array<(l: Linha) => boolean> = [];
  private valores: Linha | Linha[] = {};
  private colunas = "*";
  private devolve = false;
  private soContar = false;
  private contar = false;
  private ordem: Array<{ col: string; asc: boolean }> = [];
  private teto: number | null = null;

  constructor(private readonly nome: string) {}

  select(colunas = "*", opcoes?: { count?: string; head?: boolean }) {
    if (this.op === "select") banco.leituras.push({ tabela: this.nome, colunas });
    else this.devolve = true;
    this.colunas = colunas;
    this.contar = opcoes?.count !== undefined;
    this.soContar = opcoes?.head === true;
    return this;
  }
  insert(v: Linha | Linha[]) {
    this.op = "insert";
    this.valores = v;
    return this;
  }
  update(v: Linha) {
    this.op = "update";
    this.valores = v;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, x: unknown) {
    this.filtros.push((l) => valor(l, c) === x && x !== null);
    return this;
  }
  neq(c: string, x: unknown) {
    this.filtros.push(predicado(c, "neq", x));
    return this;
  }
  gt(c: string, x: unknown) {
    this.filtros.push(predicado(c, "gt", x));
    return this;
  }
  gte(c: string, x: unknown) {
    this.filtros.push(predicado(c, "gte", x));
    return this;
  }
  lt(c: string, x: unknown) {
    this.filtros.push(predicado(c, "lt", x));
    return this;
  }
  lte(c: string, x: unknown) {
    this.filtros.push(predicado(c, "lte", x));
    return this;
  }
  in(c: string, x: unknown[]) {
    this.filtros.push(predicado(c, "in", x));
    return this;
  }
  is(c: string, x: unknown) {
    this.filtros.push((l) => valor(l, c) === x);
    return this;
  }
  not(c: string, op: string, x: unknown) {
    const p = predicado(c, op, x);
    this.filtros.push((l) => !p(l));
    return this;
  }
  ilike(c: string, x: string) {
    this.filtros.push(predicado(c, "ilike", x));
    return this;
  }
  like(c: string, x: string) {
    this.filtros.push(predicado(c, "like", x));
    return this;
  }
  or(expressao: string) {
    this.filtros.push(ou(expressao));
    return this;
  }
  match(o: Linha) {
    for (const [c, x] of Object.entries(o)) this.eq(c, x);
    return this;
  }
  order(col: string, opcoes?: { ascending?: boolean }) {
    this.ordem.push({ col, asc: opcoes?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.teto = n;
    return this;
  }
  maybeSingle(): Promise<Resposta> {
    return this.executar().then((r) => this.unica(r, false));
  }
  single(): Promise<Resposta> {
    return this.executar().then((r) => this.unica(r, true));
  }
  then<T1 = Resposta, T2 = never>(
    ok?: ((v: Resposta) => T1 | PromiseLike<T1>) | null,
    ko?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.executar().then(ok, ko);
  }

  private unica(r: Resposta, exige: boolean): Resposta {
    if (r.error) return r;
    const linhas = (r.data as Linha[] | null) ?? [];
    if (linhas.length === 1) return { data: linhas[0], error: null };
    if (linhas.length === 0 && !exige) return { data: null, error: null };
    return { data: null, error: { code: "PGRST116", message: "expected a single row" } };
  }

  private projetar(l: Linha): Linha {
    if (this.colunas === "*") return { ...l };
    if (/[()!]/.test(this.colunas)) {
      throw new Error(`test fake: unsupported embedded select '${this.colunas}'`);
    }
    const saida: Linha = {};
    for (const c of this.colunas.split(",").map((s) => s.trim())) saida[c] = valor(l, c);
    return saida;
  }

  private async executar(): Promise<Resposta> {
    const todas = tabela(this.nome);
    const passa = (l: Linha) => this.filtros.every((f) => f(l));

    if (this.op === "select") {
      let linhas = todas.filter(passa);
      for (const { col, asc } of [...this.ordem].reverse()) {
        linhas = [...linhas].sort((a, b) => {
          const x = valor(a, col) as string | null;
          const y = valor(b, col) as string | null;
          if (x === y) return 0;
          if (x === null) return 1;
          if (y === null) return -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      const total = linhas.length;
      if (this.teto !== null) linhas = linhas.slice(0, this.teto);
      return {
        data: this.soContar ? null : linhas.map((l) => this.projetar(l)),
        error: null,
        ...(this.contar ? { count: total } : {}),
      };
    }

    if (this.op === "insert") {
      const novas = (Array.isArray(this.valores) ? this.valores : [this.valores]).map((v) => ({
        ...padroes(this.nome),
        ...v,
      }));
      for (const nova of novas) {
        const erro = violacao(this.nome, nova);
        if (erro) return { data: null, error: erro };
        const chaves = UNICOS[this.nome];
        if (chaves && todas.some((l) => chaves.every((c) => valor(l, c) === valor(nova, c)))) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
      }
      todas.push(...novas);
      return { data: this.devolve ? novas.map((l) => this.projetar(l)) : null, error: null };
    }

    if (this.op === "update") {
      const alvo = todas.filter(passa);
      for (const l of alvo) {
        const depois = { ...l, ...(this.valores as Linha) };
        const erro = violacao(this.nome, depois);
        if (erro) return { data: null, error: erro };
      }
      for (const l of alvo) Object.assign(l, this.valores);
      return { data: this.devolve ? alvo.map((l) => this.projetar(l)) : null, error: null };
    }

    const restantes = todas.filter((l) => !passa(l));
    banco.tabelas[this.nome] = restantes;
    return { data: null, error: null };
  }
}

vi.mock("@/lib/supabase/admin", () => {
  const consulta = (nome: string) =>
    new Proxy(new Consulta(nome), {
      get: (alvo, prop, receptor) => {
        if (prop in alvo) return Reflect.get(alvo, prop, receptor);
        if (typeof prop === "symbol") return undefined;
        return () => {
          throw new Error(`test fake: unsupported query-builder method '${prop}'`);
        };
      },
    });
  const cliente = {
    from: (nome: string) => consulta(nome),
    // Chamada de RPC é aceita e anotada, nunca silenciosamente executada:
    // quem a usar para gravar tarefa não deixa linha no dublê e o teste de
    // escrita fica vermelho.
    rpc: (nome: string) => {
      banco.rpcs.push(nome);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { createAdminClient: () => cliente };
});

const { createMcpServer } = await import("@/lib/mcp/server");
const { allTools } = await import("@/lib/mcp/tools");

const ORG = "00000000-0000-4000-8000-00000000000b";
const OUTRA_ORG = "00000000-0000-4000-8000-00000000000c";
const TOKEN_ID = "00000000-0000-4000-8000-0000000000a1";
const CONTATO_A = "00000000-0000-4000-8000-0000000000d1";
const CONTATO_B = "00000000-0000-4000-8000-0000000000d2";
const CONTATO_PESSOAL = "00000000-0000-4000-8000-0000000000d3";
const CONTATO_ANONIMIZADO = "00000000-0000-4000-8000-0000000000d4";
const CONTATO_FORA = "00000000-0000-4000-8000-0000000000d5";
const CONTATO_INEXISTENTE = "00000000-0000-4000-8000-0000000000dd";
const LEAD_A = "00000000-0000-4000-8000-0000000000e1";
const LEAD_FORA = "00000000-0000-4000-8000-0000000000e2";
const MEMBRO = "00000000-0000-4000-8000-0000000000f1";
const MEMBRO_FORA = "00000000-0000-4000-8000-0000000000f2";
const CHAVE = "00000000-0000-4000-8000-0000000000c1";

const NOME_CONTATO = "SYNTH-CONTACT-NAME-5b1e";
const EMAIL_CONTATO = "titular.sintetico@exemplo.invalid";
const TELEFONE_CONTATO = "+5500000000000";
const MARCA_TITULO = "SYNTH-TITLE-MARKER-41c2";
const MARCA_DESCRICAO = "SYNTH-DESCRIPTION-MARKER-9d07";
const MARCA_PERGUNTA = "SYNTH-QUESTION-MARKER-77aa";
const MARCA_FONTE = "SYNTH-SOURCE-MARKER-3c58";
const MOTIVO = "SYNTH-REASON-needs-human-check";

const ESCRITA = ["mcp:read", "mcp:write", "role:agent"];
const SO_LEITURA = ["mcp:read", "role:agent"];

function token(scopes: string[]): McpAuthResult {
  return {
    organizationId: ORG,
    role: "agent",
    actor: { type: "api_token", id: TOKEN_ID, role: "agent" },
    apiTokenId: TOKEN_ID,
    scopes,
  };
}

async function chamar(
  auth: McpAuthResult,
  name: string,
  args: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const server = createMcpServer(auth, "req-tasks", [], [], idempotencyKey);
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  return { isError: r.isError === true, texto: r.content[0]?.text ?? "" };
}

interface Resultado {
  applied: boolean;
  mode: string;
  outcome: string;
  id?: string;
  diff?: Record<string, { from: unknown; to: unknown }>;
  reason?: string;
  warnings?: string[];
  tasks?: Array<{ id: string; title: string; status?: string; contact_id?: string | null }>;
}

/** A resposta de SUCESSO da tool; qualquer erro (inclusive "tool not found") lança. */
function resposta(r: { isError: boolean; texto: string }): Resultado {
  if (r.isError) throw new Error(`the tool call did not succeed: ${r.texto}`);
  return JSON.parse(r.texto) as Resultado;
}

const criar = (args: Record<string, unknown>, scopes = ESCRITA, chave?: string) =>
  chamar(token(scopes), "crm_create_task", args, chave);
const listar = (args: Record<string, unknown> = {}, scopes = SO_LEITURA) =>
  chamar(token(scopes), "crm_list_tasks", args);

const BASE = {
  title: `Revisar cadastro ${MARCA_TITULO}`,
  priority: "medium",
  kind: "task",
  contact_id: CONTATO_A,
};
const APLICAR = { ...BASE, mode: "apply", reason: MOTIVO };

const tarefas = () => banco.tabelas.crm_tasks ?? [];
const linhasDeTarefa = () => tarefas().length;

function semearTarefa(parcial: Linha): Linha {
  const linha: Linha = {
    id: novoId(),
    organization_id: ORG,
    title: "Tarefa semeada",
    description: null,
    priority: "medium",
    status: "pending",
    contact_id: CONTATO_A,
    lead_id: null,
    assigned_to: null,
    created_by: null,
    source_kind: null,
    ...parcial,
  };
  tarefas().push(linha);
  return linha;
}

function eventosDeAuditoria() {
  return auditSpy.mock.calls.map((c) => c[0] as { action: string; [k: string]: unknown });
}

beforeEach(() => {
  auditSpy.mockClear();
  tetoSpy.mockClear();
  banco.leituras.length = 0;
  banco.rpcs.length = 0;
  banco.tabelas = {
    auth_users: [{ id: MEMBRO }, { id: MEMBRO_FORA }],
    user_organizations: [
      { user_id: MEMBRO, organization_id: ORG, role: "agent" },
      { user_id: MEMBRO_FORA, organization_id: OUTRA_ORG, role: "agent" },
    ],
    contacts: [
      { id: CONTATO_A, organization_id: ORG, name: NOME_CONTATO, email: EMAIL_CONTATO, phone_number: TELEFONE_CONTATO, is_personal: false, is_anonymized: false },
      { id: CONTATO_B, organization_id: ORG, name: "Contato sintetico B", is_personal: false, is_anonymized: false },
      { id: CONTATO_PESSOAL, organization_id: ORG, name: NOME_CONTATO, email: EMAIL_CONTATO, phone_number: TELEFONE_CONTATO, is_personal: true, is_anonymized: false },
      { id: CONTATO_ANONIMIZADO, organization_id: ORG, name: NOME_CONTATO, email: EMAIL_CONTATO, phone_number: TELEFONE_CONTATO, is_personal: false, is_anonymized: true },
      { id: CONTATO_FORA, organization_id: OUTRA_ORG, name: NOME_CONTATO, email: EMAIL_CONTATO, phone_number: TELEFONE_CONTATO, is_personal: false, is_anonymized: false },
    ],
    crm_leads: [
      { id: LEAD_A, organization_id: ORG, contact_id: CONTATO_A, title: "Lead sintetico A" },
      { id: LEAD_FORA, organization_id: OUTRA_ORG, contact_id: CONTATO_FORA, title: "Lead sintetico fora" },
    ],
    crm_tasks: [],
    crm_lead_activities: [],
    idempotency_keys: [],
  };
});

describe("registry — the tools exist with the contract's authorization", () => {
  it("R1 crm_create_task is a write tool: agent role, mcp:write, with an audit redactor", () => {
    const tool = allTools.find((t) => t.name === "crm_create_task");

    expect(tool, "crm_create_task is not registered in allTools").toBeDefined();
    expect(tool!.category).toBe("write");
    expect(tool!.requiresScope).toBe("mcp:write");
    expect(tool!.requiresRole).toBe("agent");
    expect(typeof tool!.redigirParaAuditoria, "no redigirParaAuditoria: task text would reach api_audit_log").toBe("function");
  });

  it("R2 crm_list_tasks is a read tool: agent role, mcp:read", () => {
    const tool = allTools.find((t) => t.name === "crm_list_tasks");

    expect(tool, "crm_list_tasks is not registered in allTools").toBeDefined();
    expect(tool!.category).toBe("read");
    expect(tool!.requiresScope).toBe("mcp:read");
    expect(tool!.requiresRole).toBe("agent");
  });

  it("R3 the MCP origin is declared in the shared source_kind vocabulary, not as a loose string", () => {
    expect(Object.keys(TASK_SOURCE_LABELS)).toContain("mcp_tool");
  });
});

describe("T3 — mode defaults to simulate: a forgotten flag never writes", () => {
  it("T3 a call without mode reports what would happen and writes nothing", async () => {
    const r = resposta(await criar(BASE));

    expect(r.applied).toBe(false);
    expect(r.mode).toBe("simulate");
    expect(r.outcome).toBe("created");
    expect(r.diff?.title?.to, "the simulate report carries no diff").toContain(MARCA_TITULO);
    expect(linhasDeTarefa(), "the default mode wrote a row").toBe(0);
    expect(banco.tabelas.crm_lead_activities).toHaveLength(0);
    expect(banco.tabelas.idempotency_keys).toHaveLength(0);
  });

  it("T3 an explicit simulate with an idempotency_key leaves no receipt, so the later apply with that key creates", async () => {
    const simulado = resposta(await criar({ ...BASE, mode: "simulate", idempotency_key: CHAVE }));
    expect(simulado.applied).toBe(false);
    expect(banco.tabelas.idempotency_keys, "simulate stored an idempotency receipt").toHaveLength(0);

    const aplicado = resposta(await criar({ ...APLICAR, idempotency_key: CHAVE }));
    expect(aplicado.applied).toBe(true);
    expect(aplicado.outcome).toBe("created");
    expect(linhasDeTarefa()).toBe(1);
  });

  it("T3 simulate against an open duplicate reports exists and still writes nothing", async () => {
    const existente = semearTarefa({ title: BASE.title });

    const r = resposta(await criar({ ...BASE, mode: "simulate" }));

    expect(r.outcome).toBe("exists");
    expect(r.applied).toBe(false);
    expect(r.id).toBe(existente.id);
    expect(linhasDeTarefa()).toBe(1);
  });
});

describe("T4 — apply requires a reason", () => {
  it("T4 apply without reason is invalid_input and writes nothing", async () => {
    const r = await criar({ ...BASE, mode: "apply" });

    expect(r.isError, "apply without reason was accepted").toBe(true);
    expect(r.texto).toMatch(/invalid_input/);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("T4 a reason over 280 characters is refused as invalid input", async () => {
    const r = await criar({ ...APLICAR, reason: "x".repeat(281) });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input|input validation error|invalid arguments/i);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("T4 [control] apply with a reason writes", async () => {
    const r = resposta(await criar(APLICAR));

    expect(r.applied).toBe(true);
    expect(linhasDeTarefa()).toBe(1);
  });
});

describe("apply writes exactly one row, with the contract's provenance", () => {
  it("apply creates one pending crm_tasks row in the token's organization", async () => {
    const r = resposta(
      await criar({
        ...APLICAR,
        description: `Contexto ${MARCA_DESCRICAO}`,
        priority: "high",
        due_date: "2026-10-20T14:00:00-03:00",
        assigned_to: MEMBRO,
      }),
    );

    expect(r.applied).toBe(true);
    expect(r.mode).toBe("apply");
    expect(r.outcome).toBe("created");
    expect(linhasDeTarefa()).toBe(1);

    const linha = tarefas()[0]!;
    expect(r.id).toBe(linha.id);
    expect(linha.organization_id).toBe(ORG);
    expect(linha.title).toBe(BASE.title);
    expect(String(linha.description)).toContain(MARCA_DESCRICAO);
    expect(linha.priority).toBe("high");
    expect(linha.status).toBe("pending");
    expect(linha.contact_id).toBe(CONTATO_A);
    expect(linha.assigned_to).toBe(MEMBRO);
    expect(new Date(String(linha.due_date)).getTime()).toBe(new Date("2026-10-20T14:00:00-03:00").getTime());
  });

  it("apply stamps source_kind 'mcp_tool' (declared origin of the row)", async () => {
    resposta(await criar(APLICAR));

    expect(tarefas()[0]?.source_kind).toBe("mcp_tool");
  });

  it("created_by is never the API token id (it is a FK to auth.users) — the row is simply unattributed to a person", async () => {
    resposta(await criar(APLICAR));

    expect(linhasDeTarefa(), "the insert was refused by the created_by FK").toBe(1);
    expect(tarefas()[0]?.created_by ?? null).toBeNull();
  });

  it("a task tied only to a lead is accepted and lands on that lead's timeline (task_created)", async () => {
    const { contact_id: _semContato, ...semContato } = APLICAR;
    const r = resposta(await criar({ ...semContato, lead_id: LEAD_A }));

    expect(r.applied).toBe(true);
    expect(tarefas()[0]?.lead_id).toBe(LEAD_A);
    const atividades = banco.tabelas.crm_lead_activities!;
    expect(atividades, "the lead timeline got no task_created row").toHaveLength(1);
    expect(atividades[0]?.type).toBe("task_created");
    expect(atividades[0]?.source_id).toBe(r.id);
  });

  it("a call with neither contact_id nor lead_id is invalid_input and writes nothing", async () => {
    const { contact_id: _semContato, ...semAlvo } = APLICAR;
    const r = await criar(semAlvo);

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input/);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("a title over 120 characters is refused as invalid input", async () => {
    const r = await criar({ ...APLICAR, title: "t".repeat(121) });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input|input validation error|invalid arguments/i);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("an assigned_to who is not a member of the organization is refused and nothing is written", async () => {
    const r = resposta(await criar({ ...APLICAR, assigned_to: MEMBRO_FORA }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(linhasDeTarefa()).toBe(0);
  });
});

describe("T8 — protected and foreign contacts are refused without revealing anything", () => {
  it("T8 a personal contact is refused, writes nothing and echoes none of its fields", async () => {
    const r = await criar({ ...APLICAR, contact_id: CONTATO_PESSOAL });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(false);
    expect(corpo.outcome).toBe("refused");
    expect(linhasDeTarefa()).toBe(0);
    for (const dado of [NOME_CONTATO, EMAIL_CONTATO, TELEFONE_CONTATO]) {
      expect(r.texto, "the refusal leaked a contact field").not.toContain(dado);
    }
  });

  it("T8 an anonymized contact is refused, writes nothing and echoes none of its fields", async () => {
    const r = await criar({ ...APLICAR, contact_id: CONTATO_ANONIMIZADO });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(false);
    expect(corpo.outcome).toBe("refused");
    expect(linhasDeTarefa()).toBe(0);
    for (const dado of [NOME_CONTATO, EMAIL_CONTATO, TELEFONE_CONTATO]) {
      expect(r.texto).not.toContain(dado);
    }
  });

  it("a contact of another organization and a nonexistent contact get the same refusal (no existence oracle)", async () => {
    const outraOrg = resposta(await criar({ ...APLICAR, contact_id: CONTATO_FORA }));
    const inexistente = resposta(await criar({ ...APLICAR, contact_id: CONTATO_INEXISTENTE }));

    expect(outraOrg.applied).toBe(false);
    expect(outraOrg.outcome).toBe("refused");
    expect(inexistente.outcome).toBe("refused");
    expect(outraOrg.reason, "the reasons differ: a uuid became an existence oracle").toBe(inexistente.reason);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("a lead of another organization is refused and nothing is written", async () => {
    const { contact_id: _semContato, ...semContato } = APLICAR;
    const r = resposta(await criar({ ...semContato, lead_id: LEAD_FORA }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(linhasDeTarefa()).toBe(0);
  });

  it("T8 the list leaves out the tasks of a personal contact (reads exclude personal)", async () => {
    semearTarefa({ title: "Tarefa visivel", contact_id: CONTATO_A });
    semearTarefa({ title: "Tarefa de pessoal", contact_id: CONTATO_PESSOAL });

    const r = resposta(await listar());

    expect(r.tasks?.map((t) => t.title)).toContain("Tarefa visivel");
    expect(r.tasks?.map((t) => t.title), "a personal contact's task was listed").not.toContain("Tarefa de pessoal");
  });
});

describe("T12 — a review task carries its evidence", () => {
  const EVIDENCIA = { source: `Fonte ${MARCA_FONTE}`, confidence: 0.82, question: `Pergunta ${MARCA_PERGUNTA}` };

  it("T12 kind review without evidence is invalid_input and writes nothing", async () => {
    const r = await criar({ ...APLICAR, kind: "review" });

    expect(r.isError, "a review task was accepted without evidence").toBe(true);
    expect(r.texto).toMatch(/invalid_input/);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("T12 kind review with evidence prefixes the title and puts the evidence block in the description", async () => {
    const r = resposta(
      await criar({ ...APLICAR, kind: "review", evidence: EVIDENCIA, description: `Contexto ${MARCA_DESCRICAO}` }),
    );

    expect(r.applied).toBe(true);
    const linha = tarefas()[0]!;
    expect(linha.title).toBe(`[Revisar] ${BASE.title}`);
    const descricao = String(linha.description);
    expect(descricao).toContain(MARCA_FONTE);
    expect(descricao).toContain(MARCA_PERGUNTA);
    expect(descricao).toContain("0.82");
    expect(descricao, "the caller's own description was dropped").toContain(MARCA_DESCRICAO);
  });

  it("T12 evidence confidence outside 0..1 is refused as invalid input", async () => {
    const r = await criar({ ...APLICAR, kind: "review", evidence: { ...EVIDENCIA, confidence: 1.5 } });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input|input validation error|invalid arguments/i);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("T12 [control] kind task keeps the title as given, with no prefix", async () => {
    resposta(await criar(APLICAR));

    expect(tarefas()[0]?.title).toBe(BASE.title);
  });
});

describe("T13 / T9 — dedupe by natural key and idempotency by receipt", () => {
  it("T13 the same apply call twice: the second is exists, pointing at the first, and there is one row", async () => {
    const primeira = resposta(await criar(APLICAR));
    const segunda = resposta(await criar(APLICAR));

    expect(primeira.outcome).toBe("created");
    expect(segunda.outcome, "the second call did not find the first").toBe("exists");
    expect(segunda.applied).toBe(false);
    expect(segunda.id).toBe(primeira.id);
    expect(linhasDeTarefa()).toBe(1);
  });

  it("T13 an in_progress task with the same title and contact also counts as the same task", async () => {
    const existente = semearTarefa({ title: BASE.title, status: "in_progress" });

    const r = resposta(await criar(APLICAR));

    expect(r.outcome).toBe("exists");
    expect(r.id).toBe(existente.id);
    expect(linhasDeTarefa()).toBe(1);
  });

  it("T13 a pending review task with the same title for the same contact is exists", async () => {
    const evidencia = { source: "fonte", confidence: 0.5, question: "pergunta" };
    const primeira = resposta(await criar({ ...APLICAR, kind: "review", evidence: evidencia }));
    const segunda = resposta(await criar({ ...APLICAR, kind: "review", evidence: evidencia }));

    expect(segunda.outcome).toBe("exists");
    expect(segunda.id).toBe(primeira.id);
    expect(linhasDeTarefa()).toBe(1);
  });

  it("T13 [control] the same title when the earlier task is done creates a new one", async () => {
    semearTarefa({ title: BASE.title, status: "done" });

    const r = resposta(await criar(APLICAR));

    expect(r.outcome).toBe("created");
    expect(linhasDeTarefa()).toBe(2);
  });

  it("T13 [control] the same title for a different contact creates a new one", async () => {
    semearTarefa({ title: BASE.title, contact_id: CONTATO_B });

    const r = resposta(await criar(APLICAR));

    expect(r.outcome).toBe("created");
    expect(linhasDeTarefa()).toBe(2);
  });

  it("T9 the same call with the same idempotency_key replays the first response and writes one row and one receipt", async () => {
    const primeira = await criar({ ...APLICAR, idempotency_key: CHAVE });
    const segunda = await criar({ ...APLICAR, idempotency_key: CHAVE });

    expect(resposta(primeira).outcome).toBe("created");
    expect(resposta(segunda), "the replay is not the recorded first response").toEqual(resposta(primeira));
    expect(linhasDeTarefa()).toBe(1);
    const recibos = banco.tabelas.idempotency_keys!;
    expect(recibos).toHaveLength(1);
    expect(recibos[0]?.endpoint).toBe("crm_create_task");
    expect(recibos[0]?.organization_id).toBe(ORG);
    expect(recibos[0]?.key).toBe(CHAVE);
  });

  it("T9 the same idempotency_key with a different body is a conflict and writes nothing more", async () => {
    resposta(await criar({ ...APLICAR, idempotency_key: CHAVE }));

    const r = resposta(await criar({ ...APLICAR, title: "Outro titulo", idempotency_key: CHAVE }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("conflict");
    expect(linhasDeTarefa()).toBe(1);
  });

  it("T9 the Idempotency-Key request header works like the argument", async () => {
    const primeira = resposta(await criar(APLICAR, ESCRITA, CHAVE));
    const segunda = resposta(await criar(APLICAR, ESCRITA, CHAVE));

    expect(segunda).toEqual(primeira);
    expect(linhasDeTarefa()).toBe(1);
    expect(banco.tabelas.idempotency_keys).toHaveLength(1);
  });
});

describe("crm_list_tasks — scoped to the organization", () => {
  it("returns the organization's tasks and none of another organization's, unfiltered", async () => {
    const minha = semearTarefa({ title: "Tarefa da minha org" });
    const alheia = semearTarefa({ title: "Tarefa de outra org", organization_id: OUTRA_ORG, contact_id: CONTATO_FORA });

    const r = resposta(await listar());
    const ids = r.tasks?.map((t) => t.id);

    expect(ids).toContain(minha.id);
    expect(ids, "another organization's task leaked").not.toContain(alheia.id);
  });

  it("a contact_id of another organization lists nothing", async () => {
    semearTarefa({ title: "Tarefa de outra org", organization_id: OUTRA_ORG, contact_id: CONTATO_FORA });

    const r = resposta(await listar({ contact_id: CONTATO_FORA }));

    expect(r.tasks).toEqual([]);
  });

  it("a lead_id of another organization lists nothing", async () => {
    semearTarefa({ title: "Tarefa de outra org", organization_id: OUTRA_ORG, contact_id: CONTATO_FORA, lead_id: LEAD_FORA });

    const r = resposta(await listar({ lead_id: LEAD_FORA }));

    expect(r.tasks).toEqual([]);
  });

  it("filters by status", async () => {
    const aberta = semearTarefa({ title: "Aberta", status: "pending" });
    const feita = semearTarefa({ title: "Feita", status: "done" });

    const r = resposta(await listar({ status: "pending" }));
    const ids = r.tasks?.map((t) => t.id);

    expect(ids).toContain(aberta.id);
    expect(ids).not.toContain(feita.id);
  });

  it("filters by contact_id", async () => {
    const deA = semearTarefa({ title: "Do A", contact_id: CONTATO_A });
    const deB = semearTarefa({ title: "Do B", contact_id: CONTATO_B });

    const r = resposta(await listar({ contact_id: CONTATO_A }));
    const ids = r.tasks?.map((t) => t.id);

    expect(ids).toContain(deA.id);
    expect(ids).not.toContain(deB.id);
  });

  it("a list call writes no task, no timeline row and no receipt", async () => {
    semearTarefa({ title: "Qualquer" });

    const r = resposta(await listar());

    expect(r.tasks).toHaveLength(1);
    expect(linhasDeTarefa()).toBe(1);
    expect(banco.tabelas.crm_lead_activities).toHaveLength(0);
    expect(banco.tabelas.idempotency_keys).toHaveLength(0);
  });
});

describe("audit — the record carries the call's metadata, never its content", () => {
  const CONTEUDO = [MARCA_TITULO, MARCA_DESCRICAO, MARCA_PERGUNTA, MARCA_FONTE, EMAIL_CONTATO, TELEFONE_CONTATO];
  const COM_CONTEUDO = {
    ...APLICAR,
    kind: "review",
    description: `${MARCA_DESCRICAO} ${EMAIL_CONTATO} ${TELEFONE_CONTATO}`,
    evidence: { source: `Fonte ${MARCA_FONTE}`, confidence: 0.9, question: `Pergunta ${MARCA_PERGUNTA}` },
  };

  it("an applied call is audited with tool, mode, reason and token — and no title, description or evidence text", async () => {
    resposta(await criar(COM_CONTEUDO));

    const eventos = eventosDeAuditoria();
    const chamada = eventos.find((e) => e.action === "mcp.tool_called");
    expect(chamada, "no mcp.tool_called audit event").toBeDefined();
    expect(chamada!.actorApiTokenId).toBe(TOKEN_ID);
    expect(chamada!.organizationId).toBe(ORG);
    const texto = JSON.stringify(eventos);
    expect(texto).toContain("crm_create_task");
    expect(texto).toContain(MOTIVO);
    expect(texto).toContain('"mode":"apply"');
    for (const dado of CONTEUDO) {
      expect(texto, `audit carries raw content: ${dado}`).not.toContain(dado);
    }
  });

  it("a simulate call is audited as simulate, also without the content", async () => {
    resposta(await criar({ ...COM_CONTEUDO, mode: "simulate" }));

    const texto = JSON.stringify(eventosDeAuditoria());
    expect(texto).toContain("crm_create_task");
    expect(texto).toContain('"mode":"simulate"');
    for (const dado of CONTEUDO) {
      expect(texto).not.toContain(dado);
    }
  });

  it("a refused call (review without evidence) is audited as a failure, and still without the content", async () => {
    const { evidence: _semEvidencia, ...semEvidencia } = COM_CONTEUDO;
    const r = await criar(semEvidencia);
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input/);

    const falhas = eventosDeAuditoria().filter(
      (e) => e.action === "mcp.tool_called" && (e.metadata as { success?: boolean }).success === false,
    );
    expect(falhas, "the failed call was not audited as success:false").toHaveLength(1);
    const texto = JSON.stringify(eventosDeAuditoria());
    for (const dado of CONTEUDO) {
      expect(texto, `audit of the failure carries raw content: ${dado}`).not.toContain(dado);
    }
  });
});

describe("scopes — a read-only token reads and never writes", () => {
  it("a read-only token calling crm_create_task is refused by the missing mcp:write scope and writes nothing", async () => {
    const r = await criar(APLICAR, SO_LEITURA);

    expect(r.isError, "a read-only token reached the write tool").toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("a read-only token calling crm_list_tasks gets the list", async () => {
    semearTarefa({ title: "Visivel ao token de leitura" });

    const r = resposta(await listar({}, SO_LEITURA));

    expect(r.tasks?.map((t) => t.title)).toContain("Visivel ao token de leitura");
  });
});

describe("sabotage control pairs", () => {
  it("[harness control] today's scope guard on an existing write tool: read-only token refused with the same message", async () => {
    // Passa HOJE, contra uma tool que já existe, e fica vermelho se o
    // `ensureScope` for neutralizado — é a prova de que o instrumento (dublê +
    // asserção + mensagem) enxerga a remoção da guarda, independente de a tool
    // nova existir. A evidência da neutralização está no commit e no relatório.
    const r = await chamar(
      token(SO_LEITURA),
      "crm_create_lead",
      { pipeline_id: CONTATO_A, stage_id: CONTATO_B, title: "Lead sintetico" },
    );

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(banco.tabelas.crm_leads?.length, "the write tool ran for a read-only token").toBe(2);
  });

  it("[control] apply with a reason and an explicit mode writes exactly one row", async () => {
    resposta(await criar(APLICAR));

    expect(linhasDeTarefa()).toBe(1);
  });

  it("[counterpart] the same call with the mode omitted writes zero rows — red when the default flips to apply", async () => {
    const { mode: _semMode, ...semMode } = APLICAR;
    const r = resposta(await criar(semMode));

    expect(r.mode).toBe("simulate");
    expect(r.applied).toBe(false);
    expect(linhasDeTarefa()).toBe(0);
  });

  it("[control] a list scoped to the organization returns the organization's own task", async () => {
    const minha = semearTarefa({ title: "Minha" });
    semearTarefa({ title: "Alheia", organization_id: OUTRA_ORG, contact_id: CONTATO_FORA });

    const r = resposta(await listar());

    expect(r.tasks?.map((t) => t.id)).toContain(minha.id);
  });

  it("[counterpart] the same list never contains the other organization's task — red when the organization filter is removed", async () => {
    const alheia = semearTarefa({ title: "Alheia", organization_id: OUTRA_ORG, contact_id: CONTATO_FORA });
    semearTarefa({ title: "Minha" });

    const r = resposta(await listar());

    expect(r.tasks?.map((t) => t.id)).not.toContain(alheia.id);
    expect(r.tasks).toHaveLength(1);
  });
});

describe("harness — the instruments can go red", () => {
  it("[harness] the write counter sees a row written through the admin client", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    await createAdminClient().from("crm_tasks").insert({ organization_id: ORG, title: "Escrita direta", contact_id: CONTATO_A });

    expect(linhasDeTarefa()).toBe(1);
  });

  it("[harness] the fake has no RLS: an unfiltered query sees another organization's task, so a missing org filter would show", async () => {
    semearTarefa({ title: "Alheia", organization_id: OUTRA_ORG, contact_id: CONTATO_FORA });
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { data } = await createAdminClient().from("crm_tasks").select("id, organization_id");

    expect(data).toHaveLength(1);
  });

  it("[harness] the fake enforces the created_by FK, as the database does", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { error } = await createAdminClient()
      .from("crm_tasks")
      .insert({ organization_id: ORG, title: "FK", contact_id: CONTATO_A, created_by: TOKEN_ID });

    expect(error?.code).toBe("23503");
  });

  it("[harness] the fake rejects a duplicate idempotency receipt with 23505", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const recibo = { organization_id: ORG, key: CHAVE, endpoint: "crm_create_task" };
    const db = createAdminClient();
    await db.from("idempotency_keys").insert(recibo);

    const { error } = await db.from("idempotency_keys").insert(recibo);

    expect(error?.code).toBe("23505");
  });
});

describe("no schema change — PR-4 reuses crm_tasks as it is", () => {
  it("only the three known migrations mention crm_tasks, and source_kind already exists (0464)", () => {
    const pasta = path.join(process.cwd(), "supabase", "migrations");
    const mencionam = fs
      .readdirSync(pasta)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => fs.readFileSync(path.join(pasta, f), "utf8").includes("crm_tasks"))
      .sort();

    expect(mencionam).toEqual([
      "20260903143000_0210_tarefas_do_crm.sql",
      "20260928140200_0464_proposta_comercial.sql",
      "20261004090000_0533_support_readonly_nao_escreve_fatia_2.sql",
    ]);
    const proposta = fs.readFileSync(path.join(pasta, "20260928140200_0464_proposta_comercial.sql"), "utf8");
    expect(proposta).toMatch(/add column if not exists source_kind text/);
  });
});
