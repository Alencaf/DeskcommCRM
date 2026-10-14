import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { recusouMarketing } from "@/lib/campanhas/elegibilidade";
import { checarGuardasDeContato } from "@/lib/automation/guarda-do-contato";
import type { McpAuthResult } from "@/lib/mcp/auth";
import { catalogEntry } from "@/lib/mcp/tools/catalog";

/**
 * FERRAMENTA MCP `crm_record_consent` (PR-3).
 *
 * ─── O que se pede ──────────────────────────────────────────────────────────
 * O consentimento mora em `contacts.consent` (jsonb por finalidade, sem
 * tabela) e a doutrina do produto manda auditar toda mudança como
 * `lgpd.consent_changed` — ação DECLARADA em `lib/audit/actions.ts` e que
 * nenhum código emite hoje. Nenhuma tool MCP grava consentimento; quem grava
 * por SQL destrói a prova (a auditoria É a evidência da base legal). Esta tool
 * registra, por finalidade, a base legal, a origem da prova e a referência da
 * evidência; revoga pela mesma porta, sem apagar; e emite a auditoria.
 *
 * ─── O que a tool NÃO faz nesta versão ──────────────────────────────────────
 *  - Nunca concede `marketing` (nenhuma origem, nenhum chamador). As guardas de
 *    envio do produto leem `consent.marketing.declined_at`, e uma lista
 *    importada não é consentimento.
 *  - Nunca limpa `is_blocked`, nunca mexe em `campaign_suppressions`, nunca
 *    escreve outra coluna que não `consent`.
 *
 * ─── Por que o teste passa pelo servidor, e não por uma função ──────────────
 * Mesma razão dos PR-1/2/4: as garantias são "não gravou", "só a coluna
 * consent", "a auditoria nasceu", "a finalidade vizinha ficou intacta". O
 * cliente MCP fala com `createMcpServer` em memória e o banco é um dublê com
 * estado e log de escritas.
 *
 * ─── O banco de mentira ─────────────────────────────────────────────────────
 * O mesmo dublê do PR-2, em arquivo próprio (índice único parcial de telefone,
 * FKs, log de escritas `banco.escritas` com as colunas de cada UPDATE, SEM RLS
 * de propósito, método desconhecido LANÇA). É o log que prova "o UPDATE
 * carrega só `consent`".
 *
 * ─── Nenhum "nada gravado" é vácuo ──────────────────────────────────────────
 * Sem a tool, "0 escritas" é verdade por ausência. Todo teste de ausência de
 * escrita afirma ANTES uma resposta positiva da tool (JSON com `outcome`);
 * sem a tool, `resposta()` lança e o teste fica vermelho pela razão certa.
 *
 * ─── Fixtures ───────────────────────────────────────────────────────────────
 * Sintéticas: ids fixos, nomes inventados, e-mails `.invalid`, telefones de
 * faixa de teste, referências de evidência inventadas. Nenhum dado de pessoa,
 * nenhuma instalação real.
 *
 * ─── Sabotagens que a fase verde tem de rodar (e ver vermelho) ──────────────
 *  1. default de `mode` trocado para "apply"        → T3 / receipt
 *  2. aceitar `marketing` (qualquer origem)         → T10 (todas as origens)
 *  3. `consent` por substituição (não merge)        → merge preserves others
 *  4. revogar apagando a chave da finalidade        → revoke never deletes
 *  5. não emitir `lgpd.consent_changed`             → audit (todos)
 *  6. emitir a auditoria também em simulate/exists  → audit (nenhum evento)
 *  7. `before/after` com o objeto consent inteiro   → audit purpose-only
 *  8. tirar `redigirParaAuditoria`                  → mcp.tool_called sem evidência
 *  9. gravar outra coluna além de `consent`         → write only consent
 * 10. conceder em contato bloqueado                 → blocked grant refused
 * 11. regravar timestamp em chamada repetida        → exists keeps granted_at
 * 12. tirar `ensureScope`/`ensureRole`              → scope/role pairs (provados
 *     hoje contra tools existentes, ver o commit e o relatório)
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
  escritas: [] as Array<{ tabela: string; op: string; chaves: string[] }>,
};

const UNICOS: Record<string, string[]> = {
  idempotency_keys: ["organization_id", "key", "endpoint"],
};
const FKS: Record<string, Record<string, string>> = {
  contacts: { person_id: "people", created_by_user_id: "auth_users" },
};

let sequencia = 0;
const novoId = () => `00000000-0000-4000-9000-${(++sequencia).toString(16).padStart(12, "0")}`;
const agoraIso = () => new Date().toISOString();
const valor = (l: Linha, c: string) => l[c] ?? null;
const tabela = (nome: string) => (banco.tabelas[nome] ??= []);

function padroes(nome: string): Linha {
  if (nome === "contacts") {
    return {
      id: novoId(),
      is_personal: false,
      is_anonymized: false,
      is_blocked: false,
      is_merged_into: null,
      consent: {},
      tags: [],
      source: "manual",
      source_metadata: {},
      custom_fields: {},
      kind: "person",
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
  if (nome === "contacts") {
    const telefone = valor(l, "phone_number");
    if (telefone !== null && !/^\+\d{8,15}$/.test(String(telefone))) {
      return { code: "23514", message: "contacts_phone_e164_format" };
    }
    const cf = valor(l, "custom_fields");
    if (cf === null || typeof cf !== "object" || Array.isArray(cf)) {
      return { code: "23514", message: "contacts_custom_fields_object" };
    }
    const pessoa = valor(l, "person_id");
    if (pessoa !== null) {
      const dona = tabela("people").find((p) => p.id === pessoa);
      if (dona && dona.organization_id !== l.organization_id) {
        return { code: "P0001", message: "contacts.person_id: organization_id deve coincidir com a pessoa" };
      }
    }
  }
  return null;
}

/** Índice único PARCIAL de telefone: só contato vivo (is_merged_into nulo), por organização. */
function telefoneRepetido(nome: string, todas: Linha[], nova: Linha, ignorar?: Linha): boolean {
  if (nome !== "contacts") return false;
  if (valor(nova, "phone_number") === null || valor(nova, "is_merged_into") !== null) return false;
  return todas.some(
    (l) =>
      l !== ignorar &&
      valor(l, "is_merged_into") === null &&
      valor(l, "organization_id") === valor(nova, "organization_id") &&
      valor(l, "phone_number") === valor(nova, "phone_number"),
  );
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
        if (telefoneRepetido(this.nome, todas, nova)) {
          return { data: null, error: { code: "23505", message: "uniq_contacts_org_phone" } };
        }
      }
      for (const v of Array.isArray(this.valores) ? this.valores : [this.valores]) {
        banco.escritas.push({ tabela: this.nome, op: "insert", chaves: Object.keys(v) });
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
        if (telefoneRepetido(this.nome, todas, depois, l)) {
          return { data: null, error: { code: "23505", message: "uniq_contacts_org_phone" } };
        }
      }
      if (alvo.length > 0) {
        banco.escritas.push({ tabela: this.nome, op: "update", chaves: Object.keys(this.valores as Linha) });
      }
      for (const l of alvo) Object.assign(l, this.valores);
      return { data: this.devolve ? alvo.map((l) => this.projetar(l)) : null, error: null };
    }

    const restantes = todas.filter((l) => !passa(l));
    if (restantes.length !== todas.length) banco.escritas.push({ tabela: this.nome, op: "delete", chaves: [] });
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
const CHAVE = "00000000-0000-4000-8000-0000000000c1";
const CONTATO_A = "00000000-0000-4000-8000-0000000000d1";
const CONTATO_BLOQUEADO = "00000000-0000-4000-8000-0000000000d2";
const CONTATO_PESSOAL = "00000000-0000-4000-8000-0000000000d3";
const CONTATO_ANONIMIZADO = "00000000-0000-4000-8000-0000000000d4";
const CONTATO_FORA = "00000000-0000-4000-8000-0000000000d5";
const CONTATO_FUNDIDO = "00000000-0000-4000-8000-0000000000d6";
const CONTATO_INEXISTENTE = "00000000-0000-4000-8000-0000000000dd";

const NOME = "SYNTH-NAME-MARKER-5b1e";
const EMAIL = "titular.sintetico@exemplo.invalid";
const EVIDENCIA = "SYNTH-EVIDENCE-REF-6e2b";
const EVIDENCIA_2 = "SYNTH-EVIDENCE-REF-9a07";
const MARCA_VIZINHA = "SYNTH-NEIGHBOUR-PURPOSE-3c58";
const MOTIVO = "SYNTH-REASON-record-consent";

const MANAGER = ["mcp:read", "mcp:write", "role:manager"];
const SO_LEITURA = ["mcp:read", "role:manager"];
const AGENTE = ["mcp:read", "mcp:write", "role:agent"];
const INVALIDO = /invalid_input|input validation error|invalid arguments/i;

function token(scopes: string[], role: McpAuthResult["role"] = "manager"): McpAuthResult {
  return {
    organizationId: ORG,
    role,
    actor: { type: "api_token", id: TOKEN_ID, role },
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
  const server = createMcpServer(auth, "req-consent", [], [], idempotencyKey);
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

interface Finalidade {
  granted_at?: string | null;
  revoked_at?: string | null;
  declined_at?: string | null;
  source?: string | null;
  version?: string | null;
  legal_basis?: string | null;
  evidence_ref?: string | null;
  actor?: unknown;
}

interface Resultado {
  applied: boolean;
  mode: string;
  outcome: string;
  id?: string;
  diff?: Record<string, { from: Finalidade | null; to: Finalidade | null }>;
  reason?: string;
  warnings?: string[];
}

/** A resposta de SUCESSO da tool; qualquer erro (inclusive "tool not found") lança. */
function resposta(r: { isError: boolean; texto: string }): Resultado {
  if (r.isError) throw new Error(`the tool call did not succeed: ${r.texto}`);
  return JSON.parse(r.texto) as Resultado;
}

const registrar = (args: Record<string, unknown>, scopes = MANAGER, chave?: string) =>
  chamar(token(scopes), "crm_record_consent", args, chave);

const BASE = {
  contact_id: CONTATO_A,
  purpose: "transactional",
  status: "granted",
  legal_basis: "consent",
  source: "whatsapp_message",
  evidence_ref: EVIDENCIA,
};
const APLICAR = { ...BASE, mode: "apply", reason: MOTIVO };

const contatos = () => banco.tabelas.contacts ?? [];
const contatoA = () => contatos().find((c) => c.id === CONTATO_A)!;
const consentDe = (c: Linha) => c.consent as Record<string, Finalidade>;
const escritasEm = (t: string) => banco.escritas.filter((e) => e.tabela === t);

/** O DEFAULT que a coluna `contacts.consent` tem no produto: toda finalidade nasce com a forma de "ninguém perguntou". */
const consentPadrao = (): Record<string, unknown> => ({
  marketing: { granted_at: null, source: null, version: null },
  transactional: { granted_at: null, source: null, version: null },
  profiling: { granted_at: null, source: null, version: null },
});

function semearContato(parcial: Linha): Linha {
  const linha: Linha = {
    id: novoId(),
    organization_id: ORG,
    name: NOME,
    display_name: null,
    email: EMAIL,
    phone_number: null,
    is_personal: false,
    is_anonymized: false,
    is_blocked: false,
    is_merged_into: null,
    consent: consentPadrao(),
    tags: [],
    source: "etl_sintetico",
    source_metadata: {},
    custom_fields: {},
    person_id: null,
    created_by_user_id: null,
    kind: "person",
    ...parcial,
  };
  contatos().push(linha);
  return linha;
}

function eventosDeAuditoria() {
  return auditSpy.mock.calls.map((c) => c[0] as { action: string; [k: string]: unknown });
}
const eventosDeConsentimento = () => eventosDeAuditoria().filter((e) => e.action === "lgpd.consent_changed");

beforeEach(() => {
  auditSpy.mockClear();
  tetoSpy.mockClear();
  banco.leituras.length = 0;
  banco.rpcs.length = 0;
  banco.escritas.length = 0;
  banco.tabelas = {
    auth_users: [],
    people: [],
    contacts: [],
    campaign_suppressions: [],
    idempotency_keys: [],
  };
  semearContato({ id: CONTATO_A });
});

describe("registry — the tool exists with the contract's authorization", () => {
  it("R1 crm_record_consent is a write tool: manager role, mcp:write, with an audit redactor", () => {
    const tool = allTools.find((t) => t.name === "crm_record_consent");

    expect(tool, "crm_record_consent is not registered in allTools").toBeDefined();
    expect(tool!.category).toBe("write");
    expect(tool!.requiresScope).toBe("mcp:write");
    expect(tool!.requiresRole).toBe("manager");
    expect(typeof tool!.redigirParaAuditoria, "no redigirParaAuditoria: the evidence reference would reach mcp.tool_called").toBe("function");
  });

  it("[gap Q9] R2 the catalog declares it as 'critico' (risk high: a legal record, switched on one by one, never by package)", () => {
    const entrada = catalogEntry("crm_record_consent");

    expect(entrada, "crm_record_consent has no catalog entry").toBeDefined();
    expect(entrada!.category).toBe("write");
    expect(entrada!.risco).toBe("critico");
  });
});

describe("T3 — mode defaults to simulate: a forgotten flag never writes", () => {
  it("T3 a call without mode reports the purpose diff and writes nothing, audits nothing as a consent change", async () => {
    const r = resposta(await registrar(BASE));

    expect(r.applied).toBe(false);
    expect(r.mode).toBe("simulate");
    expect(r.outcome).toBe("updated");
    expect(r.diff?.consent?.from?.granted_at ?? null).toBeNull();
    expect(r.diff?.consent?.to?.legal_basis).toBe("consent");
    expect(r.diff?.consent?.to?.source).toBe("whatsapp_message");
    expect(banco.escritas, "the default mode wrote").toEqual([]);
    expect(consentDe(contatoA()).transactional?.granted_at ?? null).toBeNull();
    expect(eventosDeConsentimento(), "a simulate was audited as a consent change").toEqual([]);
  });

  it("T3 an explicit simulate with an idempotency_key leaves no receipt, so the later apply with that key records", async () => {
    resposta(await registrar({ ...BASE, mode: "simulate", idempotency_key: CHAVE }));
    expect(banco.tabelas.idempotency_keys, "simulate stored an idempotency receipt").toHaveLength(0);

    const aplicado = resposta(await registrar({ ...APLICAR, idempotency_key: CHAVE }));

    expect(aplicado.applied).toBe(true);
    expect(consentDe(contatoA()).transactional?.granted_at).toBeTruthy();
  });
});

describe("T4 — apply requires a reason and an evidence reference", () => {
  it("T4 apply without reason is invalid_input and writes nothing", async () => {
    const r = await registrar({ ...BASE, mode: "apply" });

    expect(r.isError, "apply without reason was accepted").toBe(true);
    expect(r.texto).toMatch(/invalid_input/);
    expect(banco.escritas).toEqual([]);
  });

  it("T4 a reason over 280 characters is refused as invalid input", async () => {
    const r = await registrar({ ...APLICAR, reason: "x".repeat(281) });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(INVALIDO);
    expect(banco.escritas).toEqual([]);
  });

  it("an evidence_ref over 200 characters is refused as invalid input", async () => {
    const r = await registrar({ ...APLICAR, evidence_ref: "e".repeat(201) });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(INVALIDO);
    expect(banco.escritas).toEqual([]);
  });

  it("a call without evidence_ref is refused as invalid input", async () => {
    const { evidence_ref: _semEvidencia, ...semEvidencia } = APLICAR;
    const r = await registrar(semEvidencia);

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(INVALIDO);
    expect(banco.escritas).toEqual([]);
  });

  it("an unknown purpose, status, basis or source is refused as invalid input", async () => {
    for (const troca of [
      { purpose: "newsletter" },
      { status: "pending" },
      { legal_basis: "vital_interest" },
      { source: "telepathy" },
    ]) {
      const r = await registrar({ ...APLICAR, ...troca });
      expect(r.isError, `accepted ${JSON.stringify(troca)}`).toBe(true);
      expect(r.texto).toMatch(INVALIDO);
    }
    expect(banco.escritas).toEqual([]);
  });

  it("T4 [control] apply with a reason records", async () => {
    const r = resposta(await registrar(APLICAR));

    expect(r.applied).toBe(true);
    expect(escritasEm("contacts")).toHaveLength(1);
  });
});

describe("apply records the purpose, and only the consent column", () => {
  it("T10 [control] transactional from a WhatsApp message is recorded with basis, source, evidence, version and actor", async () => {
    const r = resposta(await registrar({ ...APLICAR, version: "v1" }));

    expect(r.applied).toBe(true);
    expect(r.mode).toBe("apply");
    expect(r.outcome).toBe("updated");
    expect(r.id).toBe(CONTATO_A);
    const finalidade = consentDe(contatoA()).transactional!;
    expect(Date.parse(String(finalidade.granted_at)), "granted_at is not a timestamp").toBeGreaterThan(Date.now() - 60_000);
    expect(finalidade.revoked_at ?? null).toBeNull();
    expect(finalidade.legal_basis).toBe("consent");
    expect(finalidade.source).toBe("whatsapp_message");
    expect(finalidade.evidence_ref).toBe(EVIDENCIA);
    expect(finalidade.version).toBe("v1");
    expect(JSON.stringify(finalidade.actor), "the record does not say who recorded it").toContain(TOKEN_ID);
  });

  it("the UPDATE carries only the consent column and nothing else is written (no blocking, no suppression, no tags)", async () => {
    resposta(await registrar({ ...APLICAR, idempotency_key: CHAVE }));

    expect(escritasEm("contacts")).toHaveLength(1);
    expect(escritasEm("contacts")[0]?.chaves, "the UPDATE touched other columns").toEqual(["consent"]);
    expect([...new Set(banco.escritas.map((e) => e.tabela))].sort()).toEqual(["contacts", "idempotency_keys"]);
    expect(contatoA().is_blocked).toBe(false);
    expect(banco.escritas.some((e) => e.op === "delete")).toBe(false);
  });

  it("transactional with legitimate_interest from a partner vCard is recorded as such", async () => {
    const r = resposta(
      await registrar({ ...APLICAR, legal_basis: "legitimate_interest", source: "vcard_from_partner" }),
    );

    expect(r.outcome).toBe("updated");
    const finalidade = consentDe(contatoA()).transactional!;
    expect(finalidade.legal_basis).toBe("legitimate_interest");
    expect(finalidade.source).toBe("vcard_from_partner");
  });

  it("profiling is a purpose of its own and can be recorded (the marketing refusal is not a blanket)", async () => {
    const r = resposta(await registrar({ ...APLICAR, purpose: "profiling", legal_basis: "legitimate_interest", source: "form" }));

    expect(r.applied).toBe(true);
    expect(consentDe(contatoA()).profiling?.legal_basis).toBe("legitimate_interest");
  });

  it("[gap Q4] a legitimate_interest basis from an import is recorded (the list is the origin of the evidence, not a claim of consent)", async () => {
    const r = resposta(await registrar({ ...APLICAR, legal_basis: "legitimate_interest", source: "import" }));

    expect(r.applied).toBe(true);
    expect(consentDe(contatoA()).transactional?.source).toBe("import");
  });

  it("[gap Q4] a 'consent' basis whose evidence is an import is refused for any purpose: imported_list_is_not_consent", async () => {
    const r = resposta(await registrar({ ...APLICAR, source: "import" }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toMatch(/imported_list_is_not_consent/);
    expect(banco.escritas).toEqual([]);
    expect(eventosDeConsentimento()).toEqual([]);
  });

  it("[gap Q4 — PENDING owner decision, pinned conservative] a 'consent' basis evidenced by a partner vCard is refused too", async () => {
    const r = resposta(await registrar({ ...APLICAR, source: "vcard_from_partner" }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(typeof r.reason).toBe("string");
    expect(banco.escritas).toEqual([]);
    expect(eventosDeConsentimento()).toEqual([]);
  });

  it("[gap Q3] an extra argument that tries to write another column (is_blocked, tags) is ignored", async () => {
    resposta(await registrar({ ...APLICAR, is_blocked: true, tags: ["cliente"] }));

    expect(escritasEm("contacts")[0]?.chaves).toEqual(["consent"]);
    expect(contatoA().is_blocked).toBe(false);
  });
});

describe("T10 — marketing is never recorded by this tool, from any source", () => {
  it("T10 marketing from an import is refused with imported_list_is_not_consent and writes nothing", async () => {
    const r = resposta(await registrar({ ...APLICAR, purpose: "marketing", source: "import" }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toMatch(/imported_list_is_not_consent/);
    expect(banco.escritas).toEqual([]);
    expect(eventosDeConsentimento()).toEqual([]);
  });

  it("marketing from every other source (ui, form, whatsapp_message, vcard_from_partner) is refused too, and nothing is written", async () => {
    for (const source of ["ui", "form", "whatsapp_message", "vcard_from_partner"]) {
      const r = resposta(await registrar({ ...APLICAR, purpose: "marketing", source }));
      expect(r.applied, `marketing from ${source} was recorded`).toBe(false);
      expect(r.outcome).toBe("refused");
      expect(typeof r.reason).toBe("string");
    }
    expect(banco.escritas).toEqual([]);
    expect(consentDe(contatoA()).marketing?.granted_at ?? null).toBeNull();
    expect(eventosDeConsentimento()).toEqual([]);
  });

  it("[Q2 owner decision] T10 a marketing REVOCATION is never refused, from any source (an opt-out is always accepted)", async () => {
    for (const source of ["ui", "form", "whatsapp_message", "vcard_from_partner", "import"]) {
      const r = resposta(await registrar({ ...APLICAR, purpose: "marketing", status: "revoked", source }));
      expect(r.applied, `the marketing opt-out from ${source} was refused`).toBe(true);
      expect(r.outcome).toBe("updated");
    }
    expect(consentDe(contatoA()).marketing?.declined_at).toBeTruthy();
  });

  it("T10 marketing in simulate mode is refused as well (the simulation does not promise what apply will refuse)", async () => {
    const r = resposta(await registrar({ ...BASE, purpose: "marketing", source: "ui" }));

    expect(r.applied).toBe(false);
    expect(r.mode).toBe("simulate");
    expect(r.outcome).toBe("refused");
  });
});

describe("[Q2 owner decision] marketing opt-out — written where the existing send-gate reads it", () => {
  it("a marketing revocation records declined_at together with the revoked record, and never granted_at", async () => {
    const r = resposta(await registrar({ ...APLICAR, purpose: "marketing", status: "revoked", evidence_ref: EVIDENCIA_2 }));

    expect(r.outcome).toBe("updated");
    const marketing = consentDe(contatoA()).marketing!;
    expect(marketing.declined_at, "no declined_at: the automation gate would not see the opt-out").toBeTruthy();
    expect(Date.parse(String(marketing.declined_at))).toBeGreaterThan(Date.now() - 60_000);
    expect(marketing.revoked_at).toBe(marketing.declined_at);
    expect(marketing.granted_at ?? null).toBeNull();
    expect(marketing.source).toBe("whatsapp_message");
    expect(marketing.legal_basis).toBe("consent");
    expect(marketing.evidence_ref).toBe(EVIDENCIA_2);
    expect(JSON.stringify(marketing.actor)).toContain(TOKEN_ID);
  });

  it("the existing gates honour it: the automation guard answers consent_declined and the campaign check reads a recorded refusal", async () => {
    const contato = (consent: unknown) => ({ context: { contact: { id: CONTATO_A, phone_number: "+5511990000009", is_blocked: false, consent } } });
    expect(
      checarGuardasDeContato(contato(contatoA().consent) as never),
      "control: before the opt-out the guard lets the contact through",
    ).toMatchObject({ ok: true });
    expect(recusouMarketing(contatoA().consent)).toBe(false);

    resposta(await registrar({ ...APLICAR, purpose: "marketing", status: "revoked" }));

    expect(checarGuardasDeContato(contato(contatoA().consent) as never)).toEqual({ ok: false, reason: "consent_declined" });
    expect(recusouMarketing(contatoA().consent)).toBe(true);
  });

  it("the opt-out UPDATE carries only the consent column, leaves is_blocked alone and emits one lgpd.consent_changed with that purpose's before/after", async () => {
    contatoA().consent = {
      ...consentPadrao(),
      transactional: { granted_at: "2026-01-01T00:00:00.000Z", source: "form", version: MARCA_VIZINHA },
    };

    resposta(await registrar({ ...APLICAR, purpose: "marketing", status: "revoked", idempotency_key: CHAVE }));

    expect(escritasEm("contacts")).toHaveLength(1);
    expect(escritasEm("contacts")[0]?.chaves).toEqual(["consent"]);
    expect(contatoA().is_blocked).toBe(false);
    const eventos = eventosDeConsentimento();
    expect(eventos).toHaveLength(1);
    const metadados = eventos[0]!.metadata as { purpose?: string; before?: Finalidade; after?: Finalidade };
    expect(metadados.purpose).toBe("marketing");
    expect(metadados.before?.granted_at ?? null).toBeNull();
    expect(metadados.after?.revoked_at).toBeTruthy();
    expect(JSON.stringify(eventos[0]), "the event carries another purpose").not.toContain(MARCA_VIZINHA);
    expect(consentDe(contatoA()).transactional?.version, "the neighbouring purpose was changed").toBe(MARCA_VIZINHA);
  });

  it("the same opt-out twice: the second is exists and writes nothing", async () => {
    const args = { ...APLICAR, purpose: "marketing", status: "revoked" };
    resposta(await registrar(args));
    const antes = banco.escritas.length;

    const r = resposta(await registrar(args));

    expect(r.outcome).toBe("exists");
    expect(r.applied).toBe(false);
    expect(banco.escritas).toHaveLength(antes);
  });

  it("in simulate mode the opt-out reports declined_at in the diff and writes nothing", async () => {
    const r = resposta(await registrar({ ...BASE, purpose: "marketing", status: "revoked" }));

    expect(r.applied).toBe(false);
    expect(r.mode).toBe("simulate");
    expect(r.outcome).toBe("updated");
    expect(r.diff?.consent?.to?.declined_at).toBeTruthy();
    expect(banco.escritas).toEqual([]);
  });

  it("[control] a transactional revocation does NOT write declined_at (that field is the marketing gate's)", async () => {
    resposta(await registrar({ ...APLICAR, status: "revoked" }));

    const transactional = consentDe(contatoA()).transactional as Finalidade & { declined_at?: string };
    expect(transactional.revoked_at).toBeTruthy();
    expect(transactional.declined_at ?? null).toBeNull();
  });

  it("an opt-out on a blocked contact is accepted and leaves is_blocked untouched", async () => {
    const bloqueado = semearContato({ id: CONTATO_BLOQUEADO, is_blocked: true });

    const r = resposta(await registrar({ ...APLICAR, purpose: "marketing", status: "revoked", contact_id: CONTATO_BLOQUEADO }));

    expect(r.outcome).toBe("updated");
    expect(consentDe(bloqueado).marketing?.declined_at).toBeTruthy();
    expect(bloqueado.is_blocked).toBe(true);
  });
});

describe("revocation — same tool, never a delete", () => {
  it("revoking a granted purpose records revoked_at, drops granted_at and keeps the purpose key", async () => {
    resposta(await registrar(APLICAR));
    const r = resposta(
      await registrar({ ...APLICAR, status: "revoked", evidence_ref: EVIDENCIA_2, source: "whatsapp_message" }),
    );

    expect(r.outcome).toBe("updated");
    const consent = consentDe(contatoA());
    expect(Object.keys(consent), "the purpose key was deleted").toContain("transactional");
    expect(Date.parse(String(consent.transactional?.revoked_at))).toBeGreaterThan(Date.now() - 60_000);
    expect(consent.transactional?.granted_at ?? null, "the record claims granted and revoked at once").toBeNull();
    expect(consent.transactional?.evidence_ref).toBe(EVIDENCIA_2);
    expect(banco.escritas.some((e) => e.op === "delete")).toBe(false);
  });

  it("revoking a purpose that was never granted records the revocation (a recorded 'no' is information)", async () => {
    const r = resposta(await registrar({ ...APLICAR, status: "revoked" }));

    expect(r.outcome).toBe("updated");
    expect(consentDe(contatoA()).transactional?.revoked_at).toBeTruthy();
  });

  it("the same revocation twice: the second is exists and writes nothing", async () => {
    const args = { ...APLICAR, status: "revoked" };
    resposta(await registrar(args));
    const antes = banco.escritas.length;

    const r = resposta(await registrar(args));

    expect(r.outcome).toBe("exists");
    expect(r.applied).toBe(false);
    expect(banco.escritas).toHaveLength(antes);
  });

  it("[gap Q1] after a revocation, a grant whose evidence is not from the person (partner vCard) is refused and the record stays revoked", async () => {
    resposta(await registrar({ ...APLICAR, status: "revoked" }));

    const r = resposta(
      await registrar({ ...APLICAR, legal_basis: "legitimate_interest", source: "vcard_from_partner", evidence_ref: EVIDENCIA_2 }),
    );

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(consentDe(contatoA()).transactional?.revoked_at, "a later grant from a list undid the revocation").toBeTruthy();
    expect(consentDe(contatoA()).transactional?.granted_at ?? null).toBeNull();
  });

  it("[gap Q1] after a revocation, a new grant evidenced by the person (WhatsApp message) is recorded", async () => {
    resposta(await registrar({ ...APLICAR, status: "revoked" }));

    const r = resposta(await registrar({ ...APLICAR, evidence_ref: EVIDENCIA_2 }));

    expect(r.outcome).toBe("updated");
    const finalidade = consentDe(contatoA()).transactional!;
    expect(finalidade.granted_at).toBeTruthy();
    expect(finalidade.revoked_at ?? null).toBeNull();
    expect(finalidade.evidence_ref).toBe(EVIDENCIA_2);
  });
});

describe("the consent jsonb is merged, never replaced", () => {
  it("recording one purpose leaves the other purposes and unknown top-level keys deep-equal", async () => {
    const contato = contatoA();
    contato.consent = {
      ...consentPadrao(),
      profiling: { granted_at: "2026-01-01T00:00:00.000Z", source: "form", version: MARCA_VIZINHA },
      legitimate_interest: { ref: "lia-sintetica-001" },
    };
    const antes = JSON.parse(JSON.stringify(contato.consent)) as Record<string, unknown>;

    resposta(await registrar(APLICAR));

    const depois = consentDe(contato) as Record<string, unknown>;
    expect(depois.transactional).toBeDefined();
    for (const chave of ["marketing", "profiling", "legitimate_interest"]) {
      expect(depois[chave], `${chave} was changed by a call about transactional`).toEqual(antes[chave]);
    }
  });

  it("a contact whose consent is empty ({}) gets just the recorded purpose", async () => {
    contatoA().consent = {};

    resposta(await registrar(APLICAR));

    expect(Object.keys(consentDe(contatoA()))).toEqual(["transactional"]);
  });
});

describe("T9 / (e) — idempotency: the same record twice changes nothing", () => {
  it("(e) the same purpose, basis, source and evidence twice: the second is exists, writes nothing, audits nothing, and keeps granted_at", async () => {
    const primeira = resposta(await registrar(APLICAR));
    const concedidoEm = consentDe(contatoA()).transactional?.granted_at;
    const escritasAntes = banco.escritas.length;

    const segunda = resposta(await registrar(APLICAR));

    expect(primeira.outcome).toBe("updated");
    expect(segunda.outcome, "the second call did not recognize the first").toBe("exists");
    expect(segunda.applied).toBe(false);
    expect(banco.escritas, "the second call wrote").toHaveLength(escritasAntes);
    expect(consentDe(contatoA()).transactional?.granted_at, "the timestamp was rewritten").toBe(concedidoEm);
    expect(eventosDeConsentimento(), "exists was audited as a change").toHaveLength(1);
  });

  it("[gap Q5] the same grant with a different evidence_ref is a new record: updated, and the history is the two audit events", async () => {
    resposta(await registrar(APLICAR));

    const r = resposta(await registrar({ ...APLICAR, evidence_ref: EVIDENCIA_2 }));

    expect(r.outcome).toBe("updated");
    expect(consentDe(contatoA()).transactional?.evidence_ref).toBe(EVIDENCIA_2);
    expect(eventosDeConsentimento()).toHaveLength(2);
  });

  it("T9 the same call with the same idempotency_key replays the first response and keeps one write and one receipt", async () => {
    const primeira = await registrar({ ...APLICAR, idempotency_key: CHAVE });
    const segunda = await registrar({ ...APLICAR, idempotency_key: CHAVE });

    expect(resposta(segunda), "the replay is not the recorded first response").toEqual(resposta(primeira));
    expect(escritasEm("contacts")).toHaveLength(1);
    const recibos = banco.tabelas.idempotency_keys!;
    expect(recibos).toHaveLength(1);
    expect(recibos[0]?.endpoint).toBe("crm_record_consent");
    expect(recibos[0]?.organization_id).toBe(ORG);
    expect(recibos[0]?.key).toBe(CHAVE);
    expect(eventosDeConsentimento()).toHaveLength(1);
  });

  it("T9 the same idempotency_key with a different body is a conflict and writes nothing more", async () => {
    resposta(await registrar({ ...APLICAR, idempotency_key: CHAVE }));
    const escritasAntes = banco.escritas.length;

    const r = resposta(await registrar({ ...APLICAR, status: "revoked", idempotency_key: CHAVE }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("conflict");
    expect(banco.escritas).toHaveLength(escritasAntes);
  });

  it("T9 the Idempotency-Key request header works like the argument", async () => {
    const primeira = resposta(await registrar(APLICAR, MANAGER, CHAVE));
    const segunda = resposta(await registrar(APLICAR, MANAGER, CHAVE));

    expect(segunda).toEqual(primeira);
    expect(escritasEm("contacts")).toHaveLength(1);
    expect(banco.tabelas.idempotency_keys).toHaveLength(1);
  });
});

describe("blocked or opted-out contacts", () => {
  it("[gap Q6] a grant on a blocked contact is refused: contact_blocked, is_blocked untouched, nothing written", async () => {
    semearContato({ id: CONTATO_BLOQUEADO, is_blocked: true, blocked_reason: "opt_out" });

    const r = resposta(await registrar({ ...APLICAR, contact_id: CONTATO_BLOQUEADO }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toMatch(/contact_blocked/);
    expect(contatos().find((c) => c.id === CONTATO_BLOQUEADO)?.is_blocked).toBe(true);
    expect(banco.escritas).toEqual([]);
  });

  it("[gap Q6] a revocation on a blocked contact is recorded (a 'no' is always accepted), still without touching is_blocked", async () => {
    const bloqueado = semearContato({ id: CONTATO_BLOQUEADO, is_blocked: true });

    const r = resposta(await registrar({ ...APLICAR, status: "revoked", contact_id: CONTATO_BLOQUEADO }));

    expect(r.outcome).toBe("updated");
    expect(consentDe(bloqueado).transactional?.revoked_at).toBeTruthy();
    expect(bloqueado.is_blocked).toBe(true);
    expect(escritasEm("contacts")[0]?.chaves).toEqual(["consent"]);
    expect(banco.tabelas.campaign_suppressions).toHaveLength(0);
  });
});

describe("(f) — protected and foreign contacts are refused with the same shape as the task tools", () => {
  it("a personal contact is refused, writes nothing and echoes none of its fields", async () => {
    semearContato({ id: CONTATO_PESSOAL, is_personal: true });

    const r = await registrar({ ...APLICAR, contact_id: CONTATO_PESSOAL });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(false);
    expect(corpo.outcome).toBe("refused");
    expect(banco.escritas).toEqual([]);
    for (const dado of [NOME, EMAIL]) {
      expect(r.texto, "the refusal leaked a contact field").not.toContain(dado);
    }
  });

  it("an anonymized contact is refused, writes nothing and echoes none of its fields", async () => {
    semearContato({ id: CONTATO_ANONIMIZADO, is_anonymized: true });

    const r = await registrar({ ...APLICAR, contact_id: CONTATO_ANONIMIZADO });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(false);
    expect(corpo.outcome).toBe("refused");
    expect(banco.escritas).toEqual([]);
    for (const dado of [NOME, EMAIL]) {
      expect(r.texto).not.toContain(dado);
    }
  });

  it("a contact of another organization and a nonexistent contact get the same refusal (no existence oracle)", async () => {
    semearContato({ id: CONTATO_FORA, organization_id: OUTRA_ORG });

    const fora = resposta(await registrar({ ...APLICAR, contact_id: CONTATO_FORA }));
    const inexistente = resposta(await registrar({ ...APLICAR, contact_id: CONTATO_INEXISTENTE }));

    expect(fora.applied).toBe(false);
    expect(fora.outcome).toBe("refused");
    expect(inexistente.outcome).toBe("refused");
    expect(fora.reason, "the reasons differ: a uuid became an existence oracle").toBe(inexistente.reason);
    expect(banco.escritas).toEqual([]);
    expect(consentDe(contatos().find((c) => c.id === CONTATO_FORA)!).transactional?.granted_at ?? null).toBeNull();
  });

  it("[gap Q7] a contact merged into another is refused: consent belongs to the survivor, whose id the caller must use", async () => {
    semearContato({ id: CONTATO_FUNDIDO, is_merged_into: CONTATO_A });

    const r = resposta(await registrar({ ...APLICAR, contact_id: CONTATO_FUNDIDO }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(banco.escritas).toEqual([]);
    expect(consentDe(contatoA()).transactional?.granted_at ?? null).toBeNull();
  });
});

describe("audit — lgpd.consent_changed is emitted, and carries that purpose's before/after only", () => {
  it("an applied change emits exactly one lgpd.consent_changed with the contact, the token, the purpose and its before/after", async () => {
    contatoA().consent = {
      ...consentPadrao(),
      profiling: { granted_at: "2026-01-01T00:00:00.000Z", source: "form", version: MARCA_VIZINHA },
    };

    resposta(await registrar(APLICAR));

    const eventos = eventosDeConsentimento();
    expect(eventos, "no lgpd.consent_changed was emitted").toHaveLength(1);
    const evento = eventos[0]!;
    expect(evento.organizationId).toBe(ORG);
    expect(evento.actorApiTokenId).toBe(TOKEN_ID);
    expect(evento.resourceType).toBe("contact");
    expect(evento.resourceId).toBe(CONTATO_A);
    const metadados = evento.metadata as { purpose?: string; before?: Finalidade | null; after?: Finalidade };
    expect(metadados.purpose).toBe("transactional");
    expect(metadados.before?.granted_at ?? null).toBeNull();
    expect(metadados.after?.legal_basis).toBe("consent");
    expect(metadados.after?.source).toBe("whatsapp_message");
    expect(metadados.after?.evidence_ref).toBe(EVIDENCIA);
    expect(JSON.stringify(evento), "the event carries another purpose").not.toContain(MARCA_VIZINHA);
  });

  it("a revocation emits one event whose before is the granted record and whose after is the revoked one", async () => {
    resposta(await registrar(APLICAR));
    auditSpy.mockClear();

    resposta(await registrar({ ...APLICAR, status: "revoked", evidence_ref: EVIDENCIA_2 }));

    const eventos = eventosDeConsentimento();
    expect(eventos).toHaveLength(1);
    const metadados = eventos[0]!.metadata as { before?: Finalidade; after?: Finalidade };
    expect(metadados.before?.granted_at).toBeTruthy();
    expect(metadados.after?.revoked_at).toBeTruthy();
  });

  it("no consent event for a simulate, a refusal, an exists or an invalid call", async () => {
    resposta(await registrar(BASE));
    resposta(await registrar({ ...APLICAR, purpose: "marketing" }));
    resposta(await registrar(APLICAR));
    auditSpy.mockClear();
    resposta(await registrar(APLICAR));
    const invalida = await registrar({ ...BASE, mode: "apply" });
    expect(invalida.isError).toBe(true);
    expect(invalida.texto).toMatch(/invalid_input/);

    expect(eventosDeConsentimento(), "a non-change was audited as a consent change").toEqual([]);
  });

  it("mcp.tool_called carries tool, mode, reason and token — never the evidence reference (it lives in the consent event only)", async () => {
    resposta(await registrar(APLICAR));

    const chamada = eventosDeAuditoria().find((e) => e.action === "mcp.tool_called");
    expect(chamada, "no mcp.tool_called audit event").toBeDefined();
    expect(chamada!.actorApiTokenId).toBe(TOKEN_ID);
    const texto = JSON.stringify(chamada);
    expect(texto).toContain("crm_record_consent");
    expect(texto).toContain(MOTIVO);
    expect(texto).toContain('"mode":"apply"');
    expect(texto, "mcp.tool_called carries the evidence reference").not.toContain(EVIDENCIA);
    expect(JSON.stringify(eventosDeConsentimento()), "the consent event lost the evidence").toContain(EVIDENCIA);
  });

  it("a failed call (apply without reason) is audited as a failure, still without the evidence reference", async () => {
    const { reason: _semMotivo, ...semMotivo } = APLICAR;
    const r = await registrar(semMotivo);
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input/);

    const falhas = eventosDeAuditoria().filter(
      (e) => e.action === "mcp.tool_called" && (e.metadata as { success?: boolean }).success === false,
    );
    expect(falhas, "the failed call was not audited as success:false").toHaveLength(1);
    expect(JSON.stringify(eventosDeAuditoria())).not.toContain(EVIDENCIA);
  });
});

describe("scopes and roles — a legal record needs a manager with write scope", () => {
  it("a read-only manager token is refused by the missing mcp:write scope and writes nothing", async () => {
    const r = await registrar(APLICAR, SO_LEITURA);

    expect(r.isError, "a read-only token reached the write tool").toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(banco.escritas).toEqual([]);
  });

  it("an agent-role token with mcp:write is refused by the role check and writes nothing", async () => {
    const r = await chamar(token(AGENTE, "agent"), "crm_record_consent", APLICAR);

    expect(r.isError, "an agent reached a manager tool").toBe(true);
    expect(r.texto).toMatch(/Role 'agent' insufficient/);
    expect(banco.escritas).toEqual([]);
    expect(eventosDeConsentimento()).toEqual([]);
  });
});

describe("sabotage control pairs", () => {
  it("[harness control] today's scope guard on an existing write tool: read-only token refused with the same message", async () => {
    // Passa HOJE, contra uma tool que já existe, e fica vermelho se o
    // `ensureScope` for neutralizado: o instrumento enxerga a remoção da guarda.
    const r = await chamar(token(SO_LEITURA), "crm_create_lead", {
      pipeline_id: CONTATO_A,
      stage_id: CONTATO_BLOQUEADO,
      title: "Lead sintetico",
    });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(banco.escritas.filter((e) => e.tabela === "crm_leads"), "the write tool ran for a read-only token").toEqual([]);
  });

  it("[harness control] today's role guard on an existing manager tool: an agent token is refused with the same message", async () => {
    const r = await chamar(token(AGENTE, "agent"), "crm_create_stage", {
      pipeline_id: CONTATO_A,
      name: "Etapa sintetica",
    });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/Role 'agent' insufficient/);
    expect(banco.escritas.filter((e) => e.tabela === "crm_stages")).toEqual([]);
  });

  it("[control] transactional from a WhatsApp message is recorded", async () => {
    resposta(await registrar(APLICAR));

    expect(consentDe(contatoA()).transactional?.granted_at).toBeTruthy();
    expect(eventosDeConsentimento()).toHaveLength(1);
  });

  it("[counterpart] marketing, with the same evidence and source, is refused and leaves the contact untouched — red if marketing becomes recordable", async () => {
    const r = resposta(await registrar({ ...APLICAR, purpose: "marketing" }));

    expect(r.outcome).toBe("refused");
    expect(consentDe(contatoA()).marketing?.granted_at ?? null).toBeNull();
    expect(banco.escritas).toEqual([]);
  });

  it("[control] apply with a reason and an explicit mode writes exactly one UPDATE", async () => {
    resposta(await registrar(APLICAR));

    expect(escritasEm("contacts")).toHaveLength(1);
  });

  it("[counterpart] the same call with the mode omitted writes nothing — red when the default flips to apply", async () => {
    const { mode: _semMode, ...semMode } = APLICAR;
    const r = resposta(await registrar(semMode));

    expect(r.mode).toBe("simulate");
    expect(r.applied).toBe(false);
    expect(banco.escritas).toEqual([]);
  });

  it("[control] recording transactional changes the transactional purpose", async () => {
    resposta(await registrar(APLICAR));

    expect(consentDe(contatoA()).transactional?.source).toBe("whatsapp_message");
  });

  it("[counterpart] the neighbouring purpose is byte-identical afterwards — red when consent is replaced instead of merged", async () => {
    const vizinha = { granted_at: "2026-01-01T00:00:00.000Z", source: "form", version: MARCA_VIZINHA };
    contatoA().consent = { ...consentPadrao(), profiling: vizinha };

    resposta(await registrar(APLICAR));

    expect(consentDe(contatoA()).profiling).toEqual(vizinha);
  });
});

describe("harness — the instruments can go red", () => {
  it("[harness] the write log records the columns of an UPDATE through the admin client", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    await createAdminClient().from("contacts").update({ consent: {} }).eq("id", CONTATO_A);

    expect(banco.escritas).toEqual([{ tabela: "contacts", op: "update", chaves: ["consent"] }]);
  });

  it("[harness] the fake has no RLS: an unfiltered query sees another organization's contact", async () => {
    semearContato({ id: CONTATO_FORA, organization_id: OUTRA_ORG });
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { data } = await createAdminClient().from("contacts").select("id, organization_id");

    expect(data).toHaveLength(2);
  });

  it("[harness] the fake rejects a duplicate idempotency receipt with 23505", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const recibo = { organization_id: ORG, key: CHAVE, endpoint: "crm_record_consent" };
    const db = createAdminClient();
    await db.from("idempotency_keys").insert(recibo);

    const { error } = await db.from("idempotency_keys").insert(recibo);

    expect(error?.code).toBe("23505");
  });
});
