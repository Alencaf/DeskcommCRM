/**
 * `crm_upsert_contact` passa `custom_fields` pela MESMA conferência do
 * `crm_create_lead` e do `crm_update_lead` (#2234: "a IA só grava o que o
 * cliente disse").
 *
 * A cerca de `criar-negocio-pela-ia-passa-pela-conferencia` já obriga toda
 * ferramenta que declara `custom_fields` a chamar `conferirCamposPersonalizados`;
 * este arquivo mede o EFEITO: o campo recusado sai da gravação e o ensino volta
 * ao modelo. Contato não tem funil que dê rótulo aos campos, então o alvo é
 * `{ semFunil: true }`. Para quem não é o agente de IA a conferência não decide
 * nada (catraca por origem) e o pedido segue intacto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/mcp/conferencia-de-campos", async (original) => ({
  ...(await original<object>()),
  conferirCamposPersonalizados: vi.fn(),
}));

import { conferirCamposPersonalizados } from "@/lib/mcp/conferencia-de-campos";
import { crmUpsertContact } from "@/lib/mcp/tools/upsert-contato";

const conferir = vi.mocked(conferirCamposPersonalizados);
const inseridos: Array<Record<string, unknown>> = [];

/** Banco mínimo: nenhum contato existe; o insert devolve um id. */
const supabase = {
  from: () => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) c[m] = () => c;
    c.insert = (linha: Record<string, unknown>) => {
      inseridos.push(linha);
      return { select: () => ({ single: async () => ({ data: { id: "contato-novo" }, error: null }) }) };
    };
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
    return c;
  },
};

const ctx = {
  organizationId: "33333333-3333-4333-8333-333333333333",
  role: "ai_operator",
  actor: { type: "ai_agent", id: "agent-1", agent_id: "agent-1", role: "ai_operator" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase,
  contatoDoTurno: "44444444-4444-4444-8444-444444444444",
} as unknown as McpContext;

const entrada = {
  phone: "+5511990000001",
  source: "triage" as const,
  mode: "apply" as const,
  reason: "sintetico",
  custom_fields: { tipo_imovel: "apartamento", quartos: 1 },
};

beforeEach(() => {
  inseridos.length = 0;
  conferir.mockReset();
});

describe("crm_upsert_contact confere custom_fields (#2234)", () => {
  it("o campo que o cliente não disse NÃO chega ao insert, e o ensino volta ao modelo", async () => {
    conferir.mockResolvedValueOnce({
      custom_fields: { tipo_imovel: "apartamento" },
      recusados: [{ campo: "quartos", motivo: "cliente_nao_disse", mensagem: "Pergunte ao cliente." }],
      estado: "decidindo",
    });

    const r = (await crmUpsertContact.handler(entrada as never, ctx)) as Record<string, unknown>;

    expect(conferir).toHaveBeenCalledWith(ctx, { semFunil: true }, entrada.custom_fields);
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]!.custom_fields).toEqual({ tipo_imovel: "apartamento" });
    expect(r.erro_de_ensino).toBe("Pergunte ao cliente.");
    expect(r.campos_nao_gravados).toHaveLength(1);
    expect(r.outcome).toBe("created");
  });

  it("sem conferência (origem não é a IA) o pedido segue intacto (controle)", async () => {
    conferir.mockResolvedValueOnce({ recusados: [], estado: "nao_conferida" });

    const r = (await crmUpsertContact.handler(entrada as never, ctx)) as Record<string, unknown>;

    expect(conferir).toHaveBeenCalledTimes(1);
    expect(inseridos[0]!.custom_fields).toEqual(entrada.custom_fields);
    expect(r.erro_de_ensino).toBeUndefined();
    expect(r.campos_nao_gravados).toBeUndefined();
  });

  it("sem custom_fields a conferência não decide nada e o contato nasce sem eles", async () => {
    conferir.mockResolvedValueOnce({ recusados: [], estado: "nao_conferida" });
    const { custom_fields: _fora, ...semCampos } = entrada;

    await crmUpsertContact.handler(semCampos as never, ctx);

    expect(conferir).toHaveBeenCalledWith(ctx, { semFunil: true }, undefined);
    expect(inseridos[0]!.custom_fields).toEqual({});
  });
});
