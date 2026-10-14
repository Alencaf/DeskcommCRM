import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpAuthResult } from "@/lib/mcp/auth";

/**
 * ALLOWLIST DE FERRAMENTAS POR TOKEN: escopos `tool:<nome>` (PR-1).
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 * Se o token carrega ao menos um escopo `tool:<nome>`, ele só pode chamar as
 * ferramentas listadas (mais `tools/list`). Sem nenhum `tool:*`, nada muda:
 * a allowlist é aditiva e retrocompatível. `tool:` só ESTREITA — nunca concede
 * o `mcp:write` nem o papel que a ferramenta já cobra.
 *
 * ─── Por que o teste passa pelo servidor, e não por uma função ──────────────
 * A garantia é "a ferramenta fora da lista NÃO RODA". Um teste que chamasse um
 * helper de decisão provaria o helper, e seguiria verde se alguém deixasse de
 * chamá-lo em `server.ts`. Aqui o cliente MCP fala com `createMcpServer` por
 * transporte em memória e o banco é um dublê que anota tudo o que é tocado:
 * "a tool rodou" é "o dublê foi tocado".
 *
 * ─── Fixtures ───────────────────────────────────────────────────────────────
 * Sintéticas: ids zerados, nenhum dado de pessoa, nenhuma instalação real.
 */
const auditSpy = vi.fn();
const tetoSpy = vi.fn(async () => undefined);
const tocado: string[] = [];

vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));
vi.mock("@/lib/mcp/rate-limit", () => ({
  verificarTetoMcp: (...a: unknown[]) => tetoSpy(...(a as [])),
}));
vi.mock("@/lib/supabase/admin", () => {
  // Qualquer método do cliente (`from`, `rpc`, ...) anota o nome e devolve uma
  // cadeia que resolve vazia: o handler que chegar aqui deixa rastro, e o
  // resultado vazio não derruba a leitura.
  const cadeia = (): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) =>
        prop === "then"
          ? (ok: (v: unknown) => unknown) => ok({ data: [], error: null, count: 0 })
          : cadeia(),
      apply: () => cadeia(),
    });
  const cliente = new Proxy(
    {},
    {
      get: (_t, metodo: string) => (alvo?: unknown) => {
        tocado.push(typeof alvo === "string" ? `${metodo}:${alvo}` : metodo);
        return cadeia();
      },
    },
  );
  return { createAdminClient: () => cliente };
});

const { createMcpServer } = await import("@/lib/mcp/server");

const ORG = "00000000-0000-4000-8000-00000000000b";
const TOKEN_ID = "00000000-0000-4000-8000-0000000000a1";
const PIPELINE = "00000000-0000-4000-8000-0000000000c1";
const STAGE = "00000000-0000-4000-8000-0000000000c2";
const MARCADOR_DE_PAYLOAD = "SYNTH-PAYLOAD-MARKER-7f3a";

type Papel = McpAuthResult["role"];

function token(scopes: string[], role: Papel): McpAuthResult {
  return {
    organizationId: ORG,
    role,
    actor: { type: "api_token", id: TOKEN_ID, role },
    apiTokenId: TOKEN_ID,
    scopes,
  };
}

async function conectar(auth: McpAuthResult) {
  const server = createMcpServer(auth, "req-allowlist");
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await server.connect(servidor);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(cliente);
  return client;
}

async function chamar(auth: McpAuthResult, name: string, args: Record<string, unknown>) {
  const client = await conectar(auth);
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  await client.close();
  return { isError: r.isError === true, texto: r.content[0]?.text ?? "" };
}

const CRIAR_LEAD = {
  pipeline_id: PIPELINE,
  stage_id: STAGE,
  title: `Lead ${MARCADOR_DE_PAYLOAD}`,
  description: MARCADOR_DE_PAYLOAD,
};

const SEM_TOOL = ["mcp:read", "mcp:write", "role:manager"];
const SO_BUSCA = ["mcp:read", "mcp:write", "role:manager", "tool:crm_search_contacts"];

function eventosDeAuditoria(action: string) {
  return auditSpy.mock.calls
    .map((c) => c[0] as { action: string; [k: string]: unknown })
    .filter((e) => e.action === action);
}

beforeEach(() => {
  auditSpy.mockClear();
  tetoSpy.mockClear();
  tocado.length = 0;
});

describe("T1 — token com tool:* só chama o que está na lista", () => {
  it("T1 a token whose tool: scopes do not list the tool gets tool_not_allowed", async () => {
    const r = await chamar(token(SO_BUSCA, "manager"), "crm_create_lead", CRIAR_LEAD);

    expect(r.isError, "a ferramenta fora da lista respondeu").toBe(true);
    expect(r.texto).toMatch(/tool_not_allowed/);
  });

  it("T1 the denied tool's handler never runs (nothing is touched) — and the same call does run without a tool: scope", async () => {
    // O controle DENTRO do teste: sem ele, "nada tocado" seria vácuo — uma
    // chamada que morresse por outro motivo (validação, papel) também não
    // toca o banco, e o teste passaria sem provar a allowlist.
    await chamar(token(SEM_TOOL, "manager"), "crm_create_lead", CRIAR_LEAD);
    expect(tocado.length, "o controle não chegou ao handler: o teste seria vácuo").toBeGreaterThan(0);

    tocado.length = 0;
    await chamar(token(SO_BUSCA, "manager"), "crm_create_lead", CRIAR_LEAD);
    expect(tocado, "a ferramenta fora da lista rodou").toEqual([]);
  });

  it("T1 a read tool outside the list is denied too, not only writes", async () => {
    const r = await chamar(token(["mcp:read", "tool:crm_search_contacts"], "agent"), "crm_list_leads", {});

    expect(r.isError, "a leitura fora da lista respondeu").toBe(true);
    expect(r.texto).toMatch(/tool_not_allowed/);
  });

  it("T1 with several tool: scopes, every listed tool passes and an unlisted one is denied", async () => {
    const auth = token(["mcp:read", "tool:crm_search_contacts", "tool:crm_list_pipelines"], "agent");

    const naLista = await chamar(auth, "crm_list_pipelines", {});
    expect(naLista.texto).not.toMatch(/tool_not_allowed/);

    const foraDaLista = await chamar(auth, "crm_list_leads", {});
    expect(foraDaLista.isError, "a ferramenta fora da lista respondeu").toBe(true);
    expect(foraDaLista.texto).toMatch(/tool_not_allowed/);
  });

  it("T1 a tool: scope only narrows — it does not grant mcp:write", async () => {
    // `tool:crm_create_lead` sem `mcp:write`: a lista não é concessão. Uma
    // implementação que pulasse o `ensureScope` para a ferramenta listada
    // abriria escrita para um token de leitura.
    const r = await chamar(token(["mcp:read", "tool:crm_create_lead"], "agent"), "crm_create_lead", CRIAR_LEAD);

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/mcp:write/);
    expect(tocado, "a escrita rodou sem mcp:write").toEqual([]);
  });

  it("T1 tools/list still answers for an allowlisted token", async () => {
    const client = await conectar(token(SO_BUSCA, "manager"));
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((t) => t.name)).toContain("crm_search_contacts");
  });
});

describe("T1 — par de sabotagem (controle + contraparte)", () => {
  it("[control] the listed tool is NOT denied — passes with and without the allowlist branch", async () => {
    const r = await chamar(token(SO_BUSCA, "manager"), "crm_search_contacts", { query: "ana" });

    expect(r.texto).not.toMatch(/tool_not_allowed/);
    expect(tocado.some((t) => t.includes("contacts")), "o handler da ferramenta listada não rodou").toBe(true);
  });

  it("[counterpart] the unlisted tool IS denied — fails when the allowlist branch is removed or neutralised", async () => {
    const r = await chamar(token(SO_BUSCA, "manager"), "crm_create_lead", CRIAR_LEAD);

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/tool_not_allowed/);
    expect(tocado).toEqual([]);
  });
});

describe("T2 — regressão zero: token sem tool:* se comporta como hoje", () => {
  it("T2 a read token without tool: scopes reaches a read tool", async () => {
    const r = await chamar(token(["mcp:read"], "agent"), "crm_search_contacts", { query: "ana" });

    expect(r.texto).not.toMatch(/tool_not_allowed/);
    expect(tocado.some((t) => t.includes("contacts"))).toBe(true);
  });

  it("T2 a write token without tool: scopes reaches a write tool", async () => {
    const r = await chamar(token(SEM_TOOL, "manager"), "crm_create_lead", CRIAR_LEAD);

    expect(r.texto).not.toMatch(/tool_not_allowed/);
    expect(tocado.length, "a escrita não chegou ao handler").toBeGreaterThan(0);
  });

  it("T2 a read-only token is still refused on a write tool by the missing scope", async () => {
    const r = await chamar(token(["mcp:read", "role:manager"], "manager"), "crm_create_lead", CRIAR_LEAD);

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/missing required scope 'mcp:write'/i);
    expect(r.texto).not.toMatch(/tool_not_allowed/);
    expect(tocado).toEqual([]);
  });

  it("T2 a role below the tool's minimum is still refused by the role check", async () => {
    const r = await chamar(
      token(["mcp:read", "mcp:write", "role:agent"], "agent"),
      "crm_create_stage",
      { pipeline_id: PIPELINE, name: "Etapa sintetica" },
    );

    expect(r.isError).toBe(true);
    expect(r.texto).toMatch(/Role 'agent' insufficient/);
    expect(r.texto).not.toMatch(/tool_not_allowed/);
    expect(tocado).toEqual([]);
  });

  it("T2 only the exact tool: prefix activates the allowlist (a lookalike scope does not)", async () => {
    const r = await chamar(
      token([...SEM_TOOL, "toolbox:crm_search_contacts"], "manager"),
      "crm_create_lead",
      CRIAR_LEAD,
    );

    expect(r.texto).not.toMatch(/tool_not_allowed/);
    expect(tocado.length, "o escopo parecido ativou a allowlist").toBeGreaterThan(0);
  });
});

describe("auditoria da recusa — mcp.tool_denied", () => {
  it("a denied call is audited as mcp.tool_denied with the tool name and the token id", async () => {
    await chamar(token(SO_BUSCA, "manager"), "crm_create_lead", CRIAR_LEAD);

    const [negada] = eventosDeAuditoria("mcp.tool_denied");
    expect(negada, "nenhum evento mcp.tool_denied foi gravado").toBeDefined();
    expect(negada!.actorApiTokenId).toBe(TOKEN_ID);
    expect(negada!.organizationId).toBe(ORG);
    expect((negada!.metadata as { tool_name?: string }).tool_name).toBe("crm_create_lead");
  });

  it("the mcp.tool_denied record carries no payload of the refused call", async () => {
    await chamar(token(SO_BUSCA, "manager"), "crm_create_lead", CRIAR_LEAD);

    const [negada] = eventosDeAuditoria("mcp.tool_denied");
    expect(negada, "nenhum evento mcp.tool_denied foi gravado").toBeDefined();
    expect(JSON.stringify(negada)).not.toContain(MARCADOR_DE_PAYLOAD);
  });

  it("a denied call is never audited as a successful mcp.tool_called", async () => {
    // Leitura, e não `crm_create_lead`: com o dublê vazio a escrita morre em
    // "etapa não encontrada" e já seria `success: false` sem allowlist nenhuma
    // — o teste passaria sem provar a recusa. A leitura vazia termina em
    // `success: true`, que é o que a recusa não pode produzir.
    await chamar(token(["mcp:read", "tool:crm_search_contacts"], "agent"), "crm_list_leads", {});

    const comoSucesso = eventosDeAuditoria("mcp.tool_called").filter(
      (e) => (e.metadata as { success?: boolean }).success === true,
    );
    expect(comoSucesso, "a recusa foi contada como chamada bem-sucedida").toEqual([]);
  });

  it("control: an allowed call is audited as mcp.tool_called and never as mcp.tool_denied", async () => {
    await chamar(token(SO_BUSCA, "manager"), "crm_search_contacts", { query: "ana" });

    expect(eventosDeAuditoria("mcp.tool_called")).toHaveLength(1);
    expect(eventosDeAuditoria("mcp.tool_denied")).toEqual([]);
  });
});
