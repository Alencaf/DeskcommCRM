import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpAuthResult } from "@/lib/mcp/auth";

/**
 * FERRAMENTA MCP `crm_upsert_contact` (PR-2).
 *
 * ─── O que se pede ──────────────────────────────────────────────────────────
 * Nenhuma rota `dsk_` chega a `contacts` com dedupe: o MCP só PROPÕE campo de
 * contato que já existe (`crm_propose_contact_field`) e a RPC
 * `fn_upsert_wa_contact` grava `source='whatsapp'` e ACRESCENTA o nono dígito.
 * Um agente externo que reconcilia uma lista de contatos precisa de um upsert
 * por telefone que (1) ache o contato existente pelas VARIANTES do número,
 * (2) nunca invente um dígito que a fonte não trouxe, (3) funda `custom_fields`
 * e `source_metadata` em vez de substituí-los (o PATCH da tela troca o jsonb
 * inteiro), (4) acrescente a `papel_historico` em vez de reescrevê-la, e
 * (5) não escreva consentimento, bloqueio nem as colunas de cliente.
 *
 * ─── Por que o teste passa pelo servidor, e não por uma função ──────────────
 * Mesma razão dos PR-1 e PR-4: as garantias são "não gravou nada", "não criou
 * um segundo contato", "a auditoria não leva o telefone". Um teste que chamasse
 * o handler direto seguiria verde se alguém deixasse de registrar a tool ou de
 * redigir a auditoria. O cliente MCP fala com `createMcpServer` em memória.
 *
 * ─── O banco de mentira ─────────────────────────────────────────────────────
 * Dublê COM ESTADO (o mesmo do PR-4, em arquivo próprio): linhas por tabela,
 * filtros do PostgREST, unicidade do recibo de idempotência, e agora também o
 * índice único PARCIAL de telefone (`uniq_contacts_org_phone`, só contato vivo),
 * a FK de `person_id`/`created_by_user_id` e a trava de mesma organização da
 * pessoa. Registra TODA escrita (`banco.escritas`): é com ele que "nada
 * gravado", "só `contacts`" e "nenhuma coluna proibida" são provados.
 *   - SEM RLS, de propósito: o cliente do MCP é service-role e é o handler quem
 *     filtra `organization_id`. Um filtro esquecido aparece como vazamento.
 *   - Método do query builder desconhecido LANÇA; chamada de RPC é anotada
 *     (`banco.rpcs`) e nunca silenciosamente executada.
 *   - Premissa: a tool NÃO usa `fn_upsert_wa_contact` (grava `source='whatsapp'`
 *     e acrescenta o nono dígito). Há um caso que a pune.
 *
 * ─── Nenhum "nada gravado" é vácuo ──────────────────────────────────────────
 * Enquanto a tool não existe, "0 escritas" é verdade por ausência. Todo teste
 * de ausência de escrita afirma ANTES uma resposta positiva da tool (JSON com
 * `applied`/`outcome`); sem a tool, `resposta()` lança e o teste fica vermelho
 * pela razão certa.
 *
 * ─── Fixtures ───────────────────────────────────────────────────────────────
 * Sintéticas: telefones de faixa de teste (`+55119000xxxx`, `+14155550100`),
 * nomes inventados, e-mails `.invalid`. Nenhum dado de pessoa, nenhuma
 * instalação real.
 *
 * ─── Sabotagens que a fase verde tem de rodar (e ver vermelho) ──────────────
 *  1. default de `mode` trocado para "apply"        → T3 default / receipt
 *  2. busca por variantes trocada por igualdade     → T6 (legado 12 dígitos)
 *  3. 9º dígito acrescentado ao gravar/buscar       → T5 / T5 control
 *  4. tirar o `eq("organization_id")` da busca      → other-org same phone
 *  5. `custom_fields` por substituição (não merge)  → merge preserves keys
 *  6. `papel_historico` por substituição            → T18 append / E16
 *  7. tirar a recusa de `person_id` diferente       → T7 conflict
 *  8. tirar a checagem de `is_personal`/anonimizado → T8
 *  9. tirar `redigirParaAuditoria`                  → audit (3 casos)
 * 10. aceitar `cliente` em `tags_add`               → T17
 * 11. escrever `consent`/`is_blocked`/`client_*`    → never-write columns
 * 12. tirar `ensureScope`/`requiresScope`           → scope pair (par provado
 *     hoje contra `crm_create_lead`, ver o commit e o relatório)
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
const PESSOA_A = "00000000-0000-4000-8000-0000000000a2";
const PESSOA_B = "00000000-0000-4000-8000-0000000000a3";
const PESSOA_FORA = "00000000-0000-4000-8000-0000000000a4";
const PESSOA_INEXISTENTE = "00000000-0000-4000-8000-0000000000aa";

const FONE_NOVO = "+5511990000001";
const FONE_NOVO_SEM_9 = "+551190000001";
const FONE_FIXO = "+551132340001";
const FONE_LEGADO = "+551190000002";
const FONE_LEGADO_COM_9 = "+5511990000002";
const FONE_SOBREVIVENTE = "+5511990000003";
const FONE_FUNDIDO = "+5511990000004";
const FONE_ESTRANGEIRO = "+14155550100";

const NOME = "SYNTH-NAME-MARKER-5b1e";
const NOME_EXIBIDO = "SYNTH-DISPLAY-MARKER-2f90";
const EMAIL = "titular.sintetico@exemplo.invalid";
const MARCA_REF = "SYNTH-REF-MARKER-8a31";
const MARCA_CAMPO = "SYNTH-FIELD-MARKER-c47d";
const MARCA_PAPEL = "SYNTH-ROLE-MARKER-19e6";
const MOTIVO = "SYNTH-REASON-batch-reconcile";

const ESCRITA = ["mcp:read", "mcp:write", "role:agent"];
const SO_LEITURA = ["mcp:read", "role:agent"];
const INVALIDO = /invalid_input|input validation error|invalid arguments/i;

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
  const server = createMcpServer(auth, "req-upsert", [], [], idempotencyKey);
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
}

/** A resposta de SUCESSO da tool; qualquer erro (inclusive "tool not found") lança. */
function resposta(r: { isError: boolean; texto: string }): Resultado {
  if (r.isError) throw new Error(`the tool call did not succeed: ${r.texto}`);
  return JSON.parse(r.texto) as Resultado;
}

const upsert = (args: Record<string, unknown>, scopes = ESCRITA, chave?: string) =>
  chamar(token(scopes), "crm_upsert_contact", args, chave);

const BASE = { phone: FONE_NOVO, name: NOME, source: "import_vcard" };
const APLICAR = { ...BASE, mode: "apply", reason: MOTIVO };
const APLICAR_COM = (phone: string) => ({ ...APLICAR, phone });

const contatos = () => banco.tabelas.contacts ?? [];
const escritasEm = (t: string) => banco.escritas.filter((e) => e.tabela === t);
const COLUNAS_PROIBIDAS = [
  "consent",
  "is_blocked",
  "blocked_reason",
  "blocked_at",
  "first_service_at",
  "client_recognized_at",
  "client_tag_by_system",
];

function semearContato(parcial: Linha): Linha {
  const linha: Linha = {
    id: novoId(),
    organization_id: ORG,
    name: NOME,
    display_name: null,
    email: null,
    phone_number: null,
    is_personal: false,
    is_anonymized: false,
    is_blocked: false,
    is_merged_into: null,
    consent: {},
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

beforeEach(() => {
  auditSpy.mockClear();
  tetoSpy.mockClear();
  banco.leituras.length = 0;
  banco.rpcs.length = 0;
  banco.escritas.length = 0;
  banco.tabelas = {
    auth_users: [],
    people: [
      { id: PESSOA_A, organization_id: ORG, full_name: "Pessoa sintetica A" },
      { id: PESSOA_B, organization_id: ORG, full_name: "Pessoa sintetica B" },
      { id: PESSOA_FORA, organization_id: OUTRA_ORG, full_name: "Pessoa sintetica fora" },
    ],
    contacts: [],
    conversations: [],
    messages: [],
    idempotency_keys: [],
  };
});

describe("registry — the tool exists with the contract's authorization", () => {
  it("R1 crm_upsert_contact is a write tool: agent role, mcp:write, with an audit redactor", () => {
    const tool = allTools.find((t) => t.name === "crm_upsert_contact");

    expect(tool, "crm_upsert_contact is not registered in allTools").toBeDefined();
    expect(tool!.category).toBe("write");
    expect(tool!.requiresScope).toBe("mcp:write");
    expect(tool!.requiresRole).toBe("agent");
    expect(typeof tool!.redigirParaAuditoria, "no redigirParaAuditoria: phone and name would reach api_audit_log").toBe("function");
  });
});

describe("T3 — mode defaults to simulate: a forgotten flag never writes", () => {
  it("T3 a call without mode reports what would be created and writes nothing anywhere", async () => {
    const r = resposta(await upsert(BASE));

    expect(r.applied).toBe(false);
    expect(r.mode).toBe("simulate");
    expect(r.outcome).toBe("created");
    expect(Object.keys(r.diff ?? {}), "the simulate report carries no diff").toContain("phone_number");
    expect(banco.escritas, "the default mode wrote").toEqual([]);
    expect(contatos()).toHaveLength(0);
  });

  it("T3 simulate against an existing contact reports the tag diff and writes nothing", async () => {
    const existente = semearContato({ phone_number: FONE_NOVO, tags: ["ctx:a"] });

    const r = resposta(await upsert({ ...BASE, tags_add: ["ctx:b"] }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("updated");
    expect(r.id).toBe(existente.id);
    expect(r.diff?.tags?.from).toEqual(["ctx:a"]);
    expect(r.diff?.tags?.to).toEqual(["ctx:a", "ctx:b"]);
    expect(banco.escritas).toEqual([]);
    expect(existente.tags).toEqual(["ctx:a"]);
  });

  it("T3 an explicit simulate with an idempotency_key leaves no receipt, so the later apply with that key creates", async () => {
    const simulado = resposta(await upsert({ ...BASE, mode: "simulate", idempotency_key: CHAVE }));
    expect(simulado.applied).toBe(false);
    expect(banco.tabelas.idempotency_keys, "simulate stored an idempotency receipt").toHaveLength(0);

    const aplicado = resposta(await upsert({ ...APLICAR, idempotency_key: CHAVE }));
    expect(aplicado.applied).toBe(true);
    expect(aplicado.outcome).toBe("created");
    expect(contatos()).toHaveLength(1);
  });
});

describe("T4 — apply requires a reason", () => {
  it("T4 apply without reason is invalid_input and writes nothing", async () => {
    const r = await upsert({ ...BASE, mode: "apply" });

    expect(r.isError, "apply without reason was accepted").toBe(true);
    expect(r.texto).toMatch(/invalid_input/);
    expect(banco.escritas).toEqual([]);
  });

  it("T4 a reason over 280 characters is refused as invalid input", async () => {
    const r = await upsert({ ...APLICAR, reason: "x".repeat(281) });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(INVALIDO);
    expect(banco.escritas).toEqual([]);
  });

  it("T4 [control] apply with a reason writes", async () => {
    const r = resposta(await upsert(APLICAR));

    expect(r.applied).toBe(true);
    expect(contatos()).toHaveLength(1);
  });
});

describe("apply creates exactly one contact, with the contract's provenance", () => {
  it("apply creates one live contact in the token's organization with the phone exactly as given", async () => {
    const r = resposta(
      await upsert({ ...APLICAR, display_name: NOME_EXIBIDO, person_id: PESSOA_A }),
    );

    expect(r.applied).toBe(true);
    expect(r.mode).toBe("apply");
    expect(r.outcome).toBe("created");
    expect(contatos()).toHaveLength(1);
    const linha = contatos()[0]!;
    expect(r.id).toBe(linha.id);
    expect(linha.organization_id).toBe(ORG);
    expect(linha.phone_number).toBe(FONE_NOVO);
    expect(linha.name).toBe(NOME);
    expect(linha.display_name).toBe(NOME_EXIBIDO);
    expect(linha.source).toBe("import_vcard");
    expect(linha.person_id).toBe(PESSOA_A);
  });

  it("created_by_user_id is never the API token id (a person column, FK to auth.users)", async () => {
    resposta(await upsert(APLICAR));

    expect(contatos(), "the insert was refused by the created_by_user_id FK").toHaveLength(1);
    expect(contatos()[0]?.created_by_user_id ?? null).toBeNull();
  });

  it("tags are stored normalized, external_refs under source_metadata, custom_fields as given", async () => {
    resposta(
      await upsert({
        ...APLICAR,
        tags_add: ["Conta:Alfa", "ctx:teste", "CTX:TESTE"],
        external_refs: { vcard_id: MARCA_REF, pcl_id: "12" },
        custom_fields: { papel_atual: MARCA_CAMPO },
      }),
    );

    const linha = contatos()[0]!;
    expect(linha.tags).toEqual(["conta:alfa", "ctx:teste"]);
    expect((linha.source_metadata as { external_refs?: unknown }).external_refs).toEqual({
      vcard_id: MARCA_REF,
      pcl_id: "12",
    });
    expect(linha.custom_fields).toEqual({ papel_atual: MARCA_CAMPO });
  });

  it("[gap Q3] batch_tag is stored under source_metadata.batch_tag next to external_refs", async () => {
    resposta(
      await upsert({
        ...APLICAR,
        batch_tag: "lote-sintetico-20261007-1",
        external_refs: { vcard_id: MARCA_REF },
      }),
    );

    const metadados = contatos()[0]!.source_metadata as { batch_tag?: string; external_refs?: unknown };
    expect(metadados.batch_tag).toBe("lote-sintetico-20261007-1");
    expect(metadados.external_refs).toEqual({ vcard_id: MARCA_REF });
  });

  it("a source outside the closed list is refused as invalid input", async () => {
    const r = await upsert({ ...APLICAR, source: "whatsapp" });

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(INVALIDO);
    expect(banco.escritas).toEqual([]);
  });

  it("a foreign (non-BR) E.164 number is created exactly as given", async () => {
    const r = resposta(await upsert({ ...APLICAR, phone: FONE_ESTRANGEIRO }));

    expect(r.outcome).toBe("created");
    expect(contatos()[0]?.phone_number).toBe(FONE_ESTRANGEIRO);
  });

  it("writes only contacts (and the receipt): no conversation, no message, no fn_upsert_wa_contact", async () => {
    resposta(await upsert({ ...APLICAR, idempotency_key: CHAVE }));

    const tabelas = new Set(banco.escritas.map((e) => e.tabela));
    expect([...tabelas].sort()).toEqual(["contacts", "idempotency_keys"]);
    expect(banco.rpcs, "the tool went through fn_upsert_wa_contact").not.toContain("fn_upsert_wa_contact");
  });

  it("never writes consent, blocking or client columns — not even when the caller sends them", async () => {
    resposta(
      await upsert({
        ...APLICAR,
        consent: { marketing: { granted_at: "2026-01-01T00:00:00Z" } },
        is_blocked: true,
        first_service_at: "2026-01-01T00:00:00Z",
        client_recognized_at: "2026-01-01T00:00:00Z",
      }),
    );
    const existente = semearContato({ phone_number: FONE_LEGADO });
    resposta(await upsert({ ...APLICAR, phone: FONE_LEGADO_COM_9, tags_add: ["ctx:x"] }));

    const gravadas = escritasEm("contacts").flatMap((e) => e.chaves);
    for (const coluna of COLUNAS_PROIBIDAS) {
      expect(gravadas, `the tool wrote ${coluna}`).not.toContain(coluna);
    }
    expect(contatos()).toHaveLength(2);
    expect(existente.is_blocked).toBe(false);
  });
});

describe("T5 / T6 — the phone is never 'corrected'; existing contacts are found by variants", () => {
  it("T5 a mobile number missing its 9th digit is refused with invalid_phone and nothing is written", async () => {
    const r = resposta(await upsert(APLICAR_COM(FONE_NOVO_SEM_9)));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(r.reason).toMatch(/invalid_phone/);
    expect(banco.escritas).toEqual([]);
    expect(contatos().some((c) => c.phone_number === FONE_NOVO), "the number was 'corrected'").toBe(false);
  });

  it("T5 [control] a landline (8 local digits starting 2-5) is accepted unchanged", async () => {
    const r = resposta(await upsert(APLICAR_COM(FONE_FIXO)));

    expect(r.outcome).toBe("created");
    expect(contatos()[0]?.phone_number).toBe(FONE_FIXO);
  });

  it("T5 a malformed phone is refused (invalid phone or invalid input) and writes nothing", async () => {
    const r = await upsert(APLICAR_COM("11 99000-0001"));

    if (r.isError) expect(r.texto).toMatch(INVALIDO);
    else expect((JSON.parse(r.texto) as Resultado).outcome).toBe("refused");
    expect(banco.escritas).toEqual([]);
  });

  it("T6 a contact stored without the 9th digit is found by the 13-digit spelling: same contact, no second one, stored phone untouched", async () => {
    const legado = semearContato({ phone_number: FONE_LEGADO });

    const r = resposta(await upsert(APLICAR_COM(FONE_LEGADO_COM_9)));

    expect(r.id, "a second contact was created instead of reusing the legacy one").toBe(legado.id);
    expect(r.outcome).toBe("exists");
    expect(contatos()).toHaveLength(1);
    expect(legado.phone_number).toBe(FONE_LEGADO);
    expect(banco.escritas).toEqual([]);
  });

  it("T6 the variant match still applies the update (tags) to the existing contact, never touching its phone", async () => {
    const legado = semearContato({ phone_number: FONE_LEGADO });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_LEGADO_COM_9), tags_add: ["ctx:lote"] }));

    expect(r.outcome).toBe("updated");
    expect(r.id).toBe(legado.id);
    expect(legado.tags).toEqual(["ctx:lote"]);
    expect(legado.phone_number).toBe(FONE_LEGADO);
    expect(escritasEm("contacts").flatMap((e) => e.chaves)).not.toContain("phone_number");
  });

  it("T6 a contact stored in the 13-digit form is found by the same spelling (exists)", async () => {
    const atual = semearContato({ phone_number: FONE_NOVO });

    const r = resposta(await upsert(APLICAR));

    expect(r.outcome).toBe("exists");
    expect(r.id).toBe(atual.id);
    expect(contatos()).toHaveLength(1);
  });

  it("two live contacts matching the variants is a conflict: nothing is written and none is chosen", async () => {
    semearContato({ phone_number: FONE_LEGADO });
    semearContato({ phone_number: FONE_LEGADO_COM_9 });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_LEGADO_COM_9), tags_add: ["ctx:lote"] }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("conflict");
    expect(banco.escritas).toEqual([]);
    expect(contatos().every((c) => (c.tags as string[]).length === 0)).toBe(true);
  });

  it("a merged contact is followed to its survivor: the survivor is updated, no new contact appears", async () => {
    const sobrevivente = semearContato({ phone_number: FONE_SOBREVIVENTE });
    semearContato({ phone_number: FONE_FUNDIDO, is_merged_into: sobrevivente.id });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_FUNDIDO), tags_add: ["ctx:lote"] }));

    expect(r.id, "the merged contact was matched, not its survivor").toBe(sobrevivente.id);
    expect(r.outcome).toBe("updated");
    expect(contatos()).toHaveLength(2);
    expect(sobrevivente.tags).toEqual(["ctx:lote"]);
  });

  it("the same phone in another organization is a different contact: a new one is created here and the other is untouched", async () => {
    const alheio = semearContato({
      organization_id: OUTRA_ORG,
      phone_number: FONE_NOVO,
      name: "Contato de outra org",
      tags: ["ctx:alheia"],
    });

    const r = resposta(await upsert({ ...APLICAR, tags_add: ["ctx:lote"] }));

    expect(r.outcome).toBe("created");
    expect(r.id).not.toBe(alheio.id);
    expect(contatos()).toHaveLength(2);
    expect(alheio.tags).toEqual(["ctx:alheia"]);
    expect(alheio.name).toBe("Contato de outra org");
  });
});

describe("T7 — person_id is set only when empty", () => {
  it("T7 an existing contact without person_id gets it set", async () => {
    const existente = semearContato({ phone_number: FONE_NOVO });

    const r = resposta(await upsert({ ...APLICAR, person_id: PESSOA_A }));

    expect(r.outcome).toBe("updated");
    expect(existente.person_id).toBe(PESSOA_A);
  });

  it("T7 a different person_id is a conflict: person_id untouched and nothing else of the call applied", async () => {
    const existente = semearContato({ phone_number: FONE_NOVO, person_id: PESSOA_A });

    const r = resposta(await upsert({ ...APLICAR, person_id: PESSOA_B, tags_add: ["ctx:lote"] }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("conflict");
    expect(existente.person_id).toBe(PESSOA_A);
    expect(existente.tags, "the rest of the call was applied despite the conflict").toEqual([]);
    expect(banco.escritas).toEqual([]);
  });

  it("T7 the same person_id is not a conflict (nothing to change)", async () => {
    semearContato({ phone_number: FONE_NOVO, person_id: PESSOA_A });

    const r = resposta(await upsert({ ...APLICAR, person_id: PESSOA_A }));

    expect(r.outcome).toBe("exists");
    expect(banco.escritas).toEqual([]);
  });

  it("a person of another organization and a nonexistent person get the same refusal, and nothing is written", async () => {
    const fora = resposta(await upsert({ ...APLICAR, person_id: PESSOA_FORA }));
    const inexistente = resposta(await upsert({ ...APLICAR, person_id: PESSOA_INEXISTENTE }));

    expect(fora.applied).toBe(false);
    expect(fora.outcome).toBe("refused");
    expect(inexistente.outcome).toBe("refused");
    expect(fora.reason, "the reasons differ: a uuid became an existence oracle").toBe(inexistente.reason);
    expect(banco.escritas).toEqual([]);
  });
});

describe("T8 — protected contacts are refused without revealing anything", () => {
  it("T8 a personal contact is refused, writes nothing and echoes none of its fields", async () => {
    semearContato({ phone_number: FONE_NOVO, name: NOME, display_name: NOME_EXIBIDO, email: EMAIL, is_personal: true });

    const r = await upsert({ ...APLICAR_COM(FONE_NOVO), tags_add: ["ctx:lote"] });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(false);
    expect(corpo.outcome).toBe("refused");
    expect(banco.escritas).toEqual([]);
    for (const dado of [NOME, NOME_EXIBIDO, EMAIL]) {
      expect(r.texto, "the refusal leaked a contact field").not.toContain(dado);
    }
  });

  it("T8 an anonymized contact is refused, writes nothing and echoes none of its fields", async () => {
    semearContato({ phone_number: FONE_NOVO, name: NOME, display_name: NOME_EXIBIDO, email: EMAIL, is_anonymized: true });

    const r = await upsert({ ...APLICAR_COM(FONE_NOVO), tags_add: ["ctx:lote"] });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(false);
    expect(corpo.outcome).toBe("refused");
    expect(banco.escritas).toEqual([]);
    for (const dado of [NOME, NOME_EXIBIDO, EMAIL]) {
      expect(r.texto).not.toContain(dado);
    }
  });
});

describe("T17 — tags: normalized, merged, and the system-owned one is never written", () => {
  it("T17 'cliente' in tags_add (any case) is not written and is named in the response; the other tags are applied", async () => {
    const existente = semearContato({ phone_number: FONE_NOVO, tags: ["ctx:antiga"] });

    const r = await upsert({ ...APLICAR_COM(FONE_NOVO), tags_add: ["Cliente", "ctx:nova"] });
    const corpo = resposta(r);

    expect(corpo.applied).toBe(true);
    expect(existente.tags).toEqual(["ctx:antiga", "ctx:nova"]);
    expect(r.texto, "the response does not name the refused tag").toMatch(/system_owned_tag/);
  });

  it("existing tags survive and a tag already present is not repeated", async () => {
    const existente = semearContato({ phone_number: FONE_NOVO, tags: ["ctx:a", "ctx:b"] });

    resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), tags_add: ["CTX:B", "ctx:c"] }));

    expect(existente.tags).toEqual(["ctx:a", "ctx:b", "ctx:c"]);
  });

  it("[gap Q5] more than 20 tags in total is refused and nothing is written", async () => {
    const vinte = Array.from({ length: 20 }, (_, i) => `ctx:t${i}`);
    const existente = semearContato({ phone_number: FONE_NOVO, tags: vinte });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), tags_add: ["ctx:extra"] }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect(existente.tags).toEqual(vinte);
    expect(banco.escritas).toEqual([]);
  });
});

describe("T18 / E16 — custom_fields merge, papel_historico append-only", () => {
  const PAPEL_1 = { papel: "recepcao", desde: "2026-01", fonte: "sintetica" };
  const PAPEL_2 = { papel: "gerente", desde: "2026-04", fonte: "sintetica" };
  const PAPEL_3 = { papel: "dono", desde: "2026-09", fonte: MARCA_PAPEL };

  it("custom_fields is a shallow merge: unsent keys survive, sent keys are overwritten, nested objects are replaced whole", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { a: 1, b: 2, aninhado: { x: 1, y: 2 } },
    });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { b: 3, c: 4, aninhado: { z: 9 } } }));

    expect(r.outcome).toBe("updated");
    expect(existente.custom_fields, "custom_fields was replaced, not merged").toEqual({
      a: 1,
      b: 3,
      c: 4,
      aninhado: { z: 9 },
    });
  });

  it("T18 papel_historico with 2 entries and one new entry sent: the array ends with 3, the old two intact and in order", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_atual: "gerente", papel_historico: [PAPEL_1, PAPEL_2] },
    });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: [PAPEL_3] } }));

    expect(r.outcome).toBe("updated");
    const cf = existente.custom_fields as { papel_atual: string; papel_historico: unknown[] };
    expect(cf.papel_historico, "the history was overwritten instead of appended").toEqual([PAPEL_1, PAPEL_2, PAPEL_3]);
    expect(cf.papel_atual, "an unsent key was lost").toBe("gerente");
  });

  it("E16 sending the whole history plus the new entry also ends with 3 (entries already there are not repeated)", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_historico: [PAPEL_1, PAPEL_2] },
    });

    resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: [PAPEL_1, PAPEL_2, PAPEL_3] } }));

    expect((existente.custom_fields as { papel_historico: unknown[] }).papel_historico).toEqual([PAPEL_1, PAPEL_2, PAPEL_3]);
  });

  it("E9 / T18 applying the same new entry again is exists and the array stays at 3", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_historico: [PAPEL_1, PAPEL_2] },
    });
    const args = { ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: [PAPEL_3] } };

    const primeira = resposta(await upsert(args));
    const escritasAntes = banco.escritas.length;
    const segunda = resposta(await upsert(args));

    expect(primeira.outcome).toBe("updated");
    expect(segunda.outcome).toBe("exists");
    expect(banco.escritas, "the second call wrote").toHaveLength(escritasAntes);
    expect((existente.custom_fields as { papel_historico: unknown[] }).papel_historico).toHaveLength(3);
  });

  it("E16 an overwrite attempt (papel_historico: null) is refused and the history is untouched", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_historico: [PAPEL_1, PAPEL_2] },
    });

    const r = resposta(
      await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: null }, tags_add: ["ctx:lote"] }),
    );

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect((existente.custom_fields as { papel_historico: unknown[] }).papel_historico).toEqual([PAPEL_1, PAPEL_2]);
    expect(existente.tags, "the rest of the call was applied despite the refusal").toEqual([]);
    expect(banco.escritas).toEqual([]);
  });

  it("E16 a papel_historico that is not an array is refused and the history is untouched", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_historico: [PAPEL_1, PAPEL_2] },
    });

    const r = resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: "gerente" } }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("refused");
    expect((existente.custom_fields as { papel_historico: unknown[] }).papel_historico).toEqual([PAPEL_1, PAPEL_2]);
  });

  it("papel_historico on a brand-new contact is stored as the given array", async () => {
    resposta(await upsert({ ...APLICAR, custom_fields: { papel_historico: [PAPEL_1] } }));

    expect((contatos()[0]!.custom_fields as { papel_historico: unknown[] }).papel_historico).toEqual([PAPEL_1]);
  });
});

describe("E1 / E12 — an existing contact is enriched, never rewritten", () => {
  it("E1 the original source is never changed on an existing contact", async () => {
    const existente = semearContato({ phone_number: FONE_NOVO, source: "etl_sintetico" });

    resposta(await upsert({ ...APLICAR, tags_add: ["ctx:lote"] }));

    expect(existente.source).toBe("etl_sintetico");
    expect(escritasEm("contacts").flatMap((e) => e.chaves)).not.toContain("source");
  });

  it("[gap Q4] an empty name is filled; a non-empty name is preserved and the response warns", async () => {
    const vazio = semearContato({ phone_number: FONE_NOVO, name: null });
    const cheio = semearContato({ phone_number: FONE_LEGADO_COM_9, name: "Nome existente" });

    const preenchido = resposta(await upsert(APLICAR));
    const preservado = resposta(await upsert({ ...APLICAR, phone: FONE_LEGADO_COM_9 }));

    expect(preenchido.outcome).toBe("updated");
    expect(vazio.name).toBe(NOME);
    expect(cheio.name, "an existing name was overwritten").toBe("Nome existente");
    expect(preservado.warnings?.length, "the divergent name was not reported").toBeGreaterThan(0);
  });

  it("E12 external_refs merges by key: a new key is added, other keys and other source_metadata keys survive", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      source_metadata: { waha_lid: "lid-sintetico", external_refs: { pcl_id: "12" } },
    });

    const r = resposta(await upsert({ ...APLICAR, external_refs: { ex_contato: MARCA_REF } }));

    expect(r.outcome).toBe("updated");
    expect(existente.source_metadata).toEqual({
      waha_lid: "lid-sintetico",
      external_refs: { pcl_id: "12", ex_contato: MARCA_REF },
    });
  });

  it("[gap Q6] an existing external_ref key with a different value is a conflict and nothing is written", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      source_metadata: { external_refs: { pcl_id: "12" } },
    });

    const r = resposta(await upsert({ ...APLICAR, external_refs: { pcl_id: "99" }, tags_add: ["ctx:lote"] }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("conflict");
    expect(existente.source_metadata).toEqual({ external_refs: { pcl_id: "12" } });
    expect(existente.tags).toEqual([]);
  });
});

describe("T9 / E9 — idempotency: the same batch twice changes nothing", () => {
  const COMPLETO = {
    ...APLICAR,
    display_name: NOME_EXIBIDO,
    tags_add: ["ctx:lote"],
    external_refs: { vcard_id: MARCA_REF },
    custom_fields: { papel_atual: "gerente", papel_historico: [{ papel: "gerente", desde: "2026-04" }] },
  };

  it("E9 the same full apply twice: the second is exists, with zero writes and one contact", async () => {
    const primeira = resposta(await upsert(COMPLETO));
    const escritasAntes = banco.escritas.length;
    const segunda = resposta(await upsert(COMPLETO));

    expect(primeira.outcome).toBe("created");
    expect(segunda.outcome, "the second call did not find the first").toBe("exists");
    expect(segunda.applied).toBe(false);
    expect(segunda.id).toBe(primeira.id);
    expect(banco.escritas, "the second call wrote").toHaveLength(escritasAntes);
    expect(contatos()).toHaveLength(1);
  });

  it("T9 the same call with the same idempotency_key replays the first response and keeps one contact and one receipt", async () => {
    const primeira = await upsert({ ...COMPLETO, idempotency_key: CHAVE });
    const segunda = await upsert({ ...COMPLETO, idempotency_key: CHAVE });

    expect(resposta(primeira).outcome).toBe("created");
    expect(resposta(segunda), "the replay is not the recorded first response").toEqual(resposta(primeira));
    expect(contatos()).toHaveLength(1);
    const recibos = banco.tabelas.idempotency_keys!;
    expect(recibos).toHaveLength(1);
    expect(recibos[0]?.endpoint).toBe("crm_upsert_contact");
    expect(recibos[0]?.organization_id).toBe(ORG);
    expect(recibos[0]?.key).toBe(CHAVE);
  });

  it("T9 the same idempotency_key with a different body is a conflict and writes nothing more", async () => {
    resposta(await upsert({ ...COMPLETO, idempotency_key: CHAVE }));
    const escritasAntes = banco.escritas.length;

    const r = resposta(await upsert({ ...COMPLETO, tags_add: ["ctx:outra"], idempotency_key: CHAVE }));

    expect(r.applied).toBe(false);
    expect(r.outcome).toBe("conflict");
    expect(banco.escritas).toHaveLength(escritasAntes);
  });

  it("T9 the Idempotency-Key request header works like the argument", async () => {
    const primeira = resposta(await upsert(COMPLETO, ESCRITA, CHAVE));
    const segunda = resposta(await upsert(COMPLETO, ESCRITA, CHAVE));

    expect(segunda).toEqual(primeira);
    expect(contatos()).toHaveLength(1);
    expect(banco.tabelas.idempotency_keys).toHaveLength(1);
  });
});

describe("audit — the record carries the call's metadata, never the person's data", () => {
  const SENSIVEIS = [FONE_NOVO.slice(1), NOME, NOME_EXIBIDO, MARCA_REF, MARCA_CAMPO, MARCA_PAPEL];
  const COM_DADOS = {
    ...APLICAR,
    display_name: NOME_EXIBIDO,
    external_refs: { vcard_id: MARCA_REF },
    custom_fields: { papel_atual: MARCA_CAMPO, papel_historico: [{ papel: "dono", fonte: MARCA_PAPEL }] },
  };

  it("an applied call is audited with tool, mode, reason and token — and no phone, name or custom data", async () => {
    resposta(await upsert(COM_DADOS));

    const eventos = eventosDeAuditoria();
    const chamada = eventos.find((e) => e.action === "mcp.tool_called");
    expect(chamada, "no mcp.tool_called audit event").toBeDefined();
    expect(chamada!.actorApiTokenId).toBe(TOKEN_ID);
    expect(chamada!.organizationId).toBe(ORG);
    const texto = JSON.stringify(eventos);
    expect(texto).toContain("crm_upsert_contact");
    expect(texto).toContain(MOTIVO);
    expect(texto).toContain('"mode":"apply"');
    for (const dado of SENSIVEIS) {
      expect(texto, `audit carries personal data: ${dado}`).not.toContain(dado);
    }
  });

  it("a simulate call is audited as simulate, also without the personal data", async () => {
    resposta(await upsert({ ...COM_DADOS, mode: "simulate" }));

    const texto = JSON.stringify(eventosDeAuditoria());
    expect(texto).toContain("crm_upsert_contact");
    expect(texto).toContain('"mode":"simulate"');
    for (const dado of SENSIVEIS) {
      expect(texto).not.toContain(dado);
    }
  });

  it("a refused call (apply without reason) is audited as a failure, and still without the personal data", async () => {
    const { reason: _semMotivo, ...semMotivo } = COM_DADOS;
    const r = await upsert(semMotivo);
    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/invalid_input/);

    const falhas = eventosDeAuditoria().filter(
      (e) => e.action === "mcp.tool_called" && (e.metadata as { success?: boolean }).success === false,
    );
    expect(falhas, "the failed call was not audited as success:false").toHaveLength(1);
    const texto = JSON.stringify(eventosDeAuditoria());
    for (const dado of SENSIVEIS) {
      expect(texto, `audit of the failure carries personal data: ${dado}`).not.toContain(dado);
    }
  });
});

describe("scopes — a read-only token never writes", () => {
  it("a read-only token calling crm_upsert_contact is refused by the missing mcp:write scope and writes nothing", async () => {
    const r = await upsert(APLICAR, SO_LEITURA);

    expect(r.isError, "a read-only token reached the write tool").toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(banco.escritas).toEqual([]);
  });
});

describe("sabotage control pairs", () => {
  it("[harness control] today's scope guard on an existing write tool: read-only token refused with the same message", async () => {
    // Passa HOJE, contra uma tool que já existe, e fica vermelho se o
    // `ensureScope` for neutralizado: prova que o instrumento (dublê + asserção
    // + mensagem) enxerga a remoção da guarda, com a tool nova ainda ausente.
    banco.tabelas.crm_leads = [];
    const r = await chamar(
      token(SO_LEITURA),
      "crm_create_lead",
      { pipeline_id: PESSOA_A, stage_id: PESSOA_B, title: "Lead sintetico" },
    );

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(banco.escritas.filter((e) => e.tabela === "crm_leads"), "the write tool ran for a read-only token").toEqual([]);
  });

  it("[control] a 13-digit mobile number is created exactly as given", async () => {
    resposta(await upsert(APLICAR));

    expect(contatos()[0]?.phone_number).toBe(FONE_NOVO);
  });

  it("[counterpart] the 12-digit spelling of the same mobile is refused and never turned into the 13-digit one — red if a 9th digit is derived", async () => {
    const r = resposta(await upsert(APLICAR_COM(FONE_NOVO_SEM_9)));

    expect(r.outcome).toBe("refused");
    expect(contatos()).toHaveLength(0);
  });

  it("[control] apply with a reason and an explicit mode writes exactly one contact", async () => {
    resposta(await upsert(APLICAR));

    expect(escritasEm("contacts")).toHaveLength(1);
  });

  it("[counterpart] the same call with the mode omitted writes nothing — red when the default flips to apply", async () => {
    const { mode: _semMode, ...semMode } = APLICAR;
    const r = resposta(await upsert(semMode));

    expect(r.mode).toBe("simulate");
    expect(r.applied).toBe(false);
    expect(banco.escritas).toEqual([]);
  });

  it("[control] history append: one new entry grows the array from 1 to 2", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_historico: [{ papel: "a" }] },
    });

    resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: [{ papel: "b" }] } }));

    expect((existente.custom_fields as { papel_historico: unknown[] }).papel_historico).toHaveLength(2);
  });

  it("[counterpart] the first entry is still there after the append — red when papel_historico is replaced", async () => {
    const existente = semearContato({
      phone_number: FONE_NOVO,
      custom_fields: { papel_historico: [{ papel: "a" }] },
    });

    resposta(await upsert({ ...APLICAR_COM(FONE_NOVO), custom_fields: { papel_historico: [{ papel: "b" }] } }));

    expect((existente.custom_fields as { papel_historico: Array<{ papel: string }> }).papel_historico[0]?.papel).toBe("a");
  });
});

describe("harness — the instruments can go red", () => {
  it("[harness] the write log records an insert and an update made through the admin client", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const db = createAdminClient();
    await db.from("contacts").insert({ organization_id: ORG, phone_number: FONE_NOVO, name: "x" });
    await db.from("contacts").update({ name: "y" }).eq("phone_number", FONE_NOVO);

    expect(banco.escritas.map((e) => `${e.op}:${e.tabela}`)).toEqual(["insert:contacts", "update:contacts"]);
    expect(banco.escritas[1]?.chaves).toEqual(["name"]);
  });

  it("[harness] the fake has no RLS: an unfiltered query sees another organization's contact", async () => {
    semearContato({ organization_id: OUTRA_ORG, phone_number: FONE_NOVO });
    const { createAdminClient } = await import("@/lib/supabase/admin");

    const { data } = await createAdminClient().from("contacts").select("id, organization_id");

    expect(data).toHaveLength(1);
  });

  it("[harness] the partial unique index on phone ignores merged contacts and rejects two live ones", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const db = createAdminClient();
    const base = { organization_id: ORG, phone_number: FONE_NOVO };
    const primeiro = await db.from("contacts").insert(base).select("id").single();
    const vivo = await db.from("contacts").insert(base);
    const fundido = await db.from("contacts").insert({ ...base, is_merged_into: (primeiro.data as { id: string }).id });

    expect(vivo.error?.code).toBe("23505");
    expect(fundido.error).toBeNull();
  });

  it("[harness] the fake enforces the person same-organization trigger and the created_by_user_id FK", async () => {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const db = createAdminClient();

    const pessoaDeFora = await db.from("contacts").insert({ organization_id: ORG, phone_number: FONE_NOVO, person_id: PESSOA_FORA });
    const autorInexistente = await db.from("contacts").insert({ organization_id: ORG, phone_number: FONE_FIXO, created_by_user_id: TOKEN_ID });

    expect(pessoaDeFora.error?.code).toBe("P0001");
    expect(autorInexistente.error?.code).toBe("23503");
  });
});
