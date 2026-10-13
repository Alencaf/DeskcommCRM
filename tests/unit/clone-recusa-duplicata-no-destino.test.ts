import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

/**
 * "LEVAR PARA OUTRO FUNIL" NÃO PODE CRIAR O SEGUNDO NEGÓCIO ABERTO DO CONTATO NO DESTINO
 * (CENTRAL-EMPRESAS-001, 5a — cenários PB-25/PB-26 pela tela).
 *
 * A tela (`components/kanban/MoveToOtherPipelineDialog.tsx`, desde a v1.48)
 * chama `POST /api/v1/leads/[id]/clone`. A rota recusa o mesmo funil, origem
 * fechada e campos exigidos — mas NÃO olha se o contato já tem negócio aberto
 * no funil de destino. Caso real: o card nasceu na TRIAGEM porque o anterior
 * tinha fechado; alguém já tinha recriado o negócio em Gestão de Contas; levar
 * o da TRIAGEM para lá deixa DOIS abertos do mesmo contato no mesmo funil.
 *
 * O harness é o do `route.test.ts` vizinho da rota (fake com estado, gatilho de
 * etapa emulado), copiado para fora de `app/` de propósito: arquivo de teste em
 * `app/` conta no teto de 12 arquivos do núcleo (toxfy-system ceiling.mjs).
 *
 * Sabotagem que a fase verde tem de rodar: tirar a consulta de "aberto do
 * contato no destino" → PB-25 volta a 201.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ error: null }) }),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  observeServiceOrigin: vi.fn(async () => "api"),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/activity-emitter", () => ({
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
  stageChangeReason: () => ({ source: "user", reason: "clone_cross_pipeline" }),
}));
vi.mock("@/lib/leads/activity-write-failure", () => ({
  registraFalhaDeAtividade: vi.fn(async () => undefined),
}));

const USER_ID = "5a111111-1111-4111-8111-111111111111";
const ORG_ID = "5a222222-2222-4222-8222-222222222222";
const LEAD_ID = "5a333333-3333-4333-8333-333333333333";
const LEAD_NO_DESTINO = "5a333333-3333-4333-8333-3333333333dd";
const CONTATO = "5a333333-3333-4333-8333-3333333333c1";
const OUTRO_CONTATO = "5a333333-3333-4333-8333-3333333333c2";
const P1 = "5a444444-4444-4444-8444-444444444444";
const P2 = "5a555555-5555-4555-8555-555555555555";
const S1_A = "5a666666-6666-4666-8666-666666666666";
const S1_LOST = "5a777777-7777-4777-8777-777777777777";
const S2_A = "5a888888-8888-4888-8888-888888888888";
const S2_LOST = "5aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables = seed;

  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    const orders: [string, boolean][] = [];
    let limit = Number.POSITIVE_INFINITY;
    let operation: "select" | "insert" | "update" = "select";
    let patch: Row | null = null;
    let pending: Row | null = null;

    const rows = (): Row[] => (tables[table] ??= []);
    const matches = () => rows().filter((row) => filters.every((f) => f(row)));

    function selectRows(): Row[] {
      return matches()
        .sort((a, b) => {
          for (const [column, ascending] of orders) {
            const diff = Number(a[column] ?? 0) - Number(b[column] ?? 0);
            if (diff !== 0) return ascending ? diff : -diff;
          }
          return 0;
        })
        .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit);
    }

    function resolveOne(required: boolean) {
      if (operation === "insert" && pending) {
        rows().push(pending);
        return { data: pending, error: null };
      }
      if (operation === "update" && patch) {
        let updated: Row | null = null;
        for (const row of matches()) {
          Object.assign(row, patch);
          const etapa = (tables.crm_stages ?? []).find((candidate) => candidate.id === row.stage_id);
          if (etapa?.is_won === true) {
            row.status = "won";
            row.closed_at ??= "2026-10-09T10:05:00.000Z";
          } else if (etapa?.is_lost === true) {
            row.status = "lost";
            row.closed_at ??= "2026-10-09T10:05:00.000Z";
          }
          updated = row;
        }
        if (!updated) return { data: null, error: null };
        return { data: updated, error: null };
      }
      const row = selectRows()[0] ?? null;
      if (!row && required) return { data: null, error: { message: "row not found" } };
      return { data: row, error: null };
    }

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      neq: (column: string, value: unknown) => {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        orders.push([column, options?.ascending ?? true]);
        return builder;
      },
      limit: (value: number) => {
        limit = value;
        return builder;
      },
      insert: (row: Row) => {
        operation = "insert";
        pending = { id: `novo-${rows().length + 1}`, ...row };
        return builder;
      },
      update: (value: Row) => {
        operation = "update";
        patch = value;
        return builder;
      },
      maybeSingle: async () => resolveOne(false),
      single: async () => resolveOne(true),
      then: async (resolve: (value: unknown) => unknown) =>
        resolve(operation === "select" ? { data: selectRows(), error: null } : resolveOne(false)),
    };

    return builder;
  }

  return { client: { from } as never, tables };
}

function lead(id: string, extra: Row): Row {
  return {
    id,
    organization_id: ORG_ID,
    status: "open",
    position_in_stage: 1000,
    title: "Negócio sintético",
    description: null,
    value_cents: 0,
    currency: "BRL",
    owner_user_id: null,
    owner_agent_id: null,
    owner_kind: null,
    expected_close_date: null,
    tags: [],
    source: "whatsapp",
    source_metadata: {},
    custom_fields: {},
    external_id: null,
    lost_reason: null,
    closed_at: null,
    updated_at: "2026-10-09T10:00:00.000Z",
    ...extra,
  };
}

function seed(contatoDoNegocioNoDestino: string) {
  return {
    contacts: [
      { id: CONTATO, organization_id: ORG_ID, is_personal: false },
      { id: OUTRO_CONTATO, organization_id: ORG_ID, is_personal: false },
    ],
    crm_pipelines: [
      { id: P1, organization_id: ORG_ID, name: "TRIAGEM", position: 1000, is_archived: false, settings: {} },
      { id: P2, organization_id: ORG_ID, name: "Gestão de Contas", position: 2000, is_archived: false, settings: {} },
    ],
    crm_stages: [
      { id: S1_A, organization_id: ORG_ID, pipeline_id: P1, name: "Novo", position: 1000, is_won: false, is_lost: false, is_archived: false },
      { id: S1_LOST, organization_id: ORG_ID, pipeline_id: P1, name: "Arquivamento", position: 9000, is_won: false, is_lost: true, is_archived: false },
      { id: S2_A, organization_id: ORG_ID, pipeline_id: P2, name: "Mapeada", position: 1000, is_won: false, is_lost: false, is_archived: false },
      { id: S2_LOST, organization_id: ORG_ID, pipeline_id: P2, name: "Encerrado", position: 9000, is_won: false, is_lost: true, is_archived: false },
    ],
    crm_leads: [
      lead(LEAD_ID, { pipeline_id: P1, stage_id: S1_A, contact_id: CONTATO }),
      lead(LEAD_NO_DESTINO, { pipeline_id: P2, stage_id: S2_A, contact_id: contatoDoNegocioNoDestino }),
    ],
  } as Record<string, Row[]>;
}

let db: ReturnType<typeof fakeDb>;

function preparar(contatoDoNegocioNoDestino: string) {
  db = fakeDb(seed(contatoDoNegocioNoDestino));
  vi.mocked(createClient).mockResolvedValue(db.client);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID, idioma: "pt-BR" },
    org: { orgId: ORG_ID },
  } as never);
});

function cloneRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/leads/${LEAD_ID}/clone`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const params = { params: Promise.resolve({ id: LEAD_ID }) };

function abertosDoContatoEm(pipeline: string): Row[] {
  return (db.tables.crm_leads ?? []).filter(
    (l) => l.contact_id === CONTATO && l.pipeline_id === pipeline && l.status === "open",
  );
}

describe("PB-25 (tela) levar para outro funil recusa duplicar o contato no destino", () => {
  it("PB-25 o contato já tem negócio aberto no destino: 409, nada é criado nem fechado", async () => {
    preparar(CONTATO);
    const { POST } = await import("@/app/api/v1/leads/[id]/clone/route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("destino_ja_tem_negocio_do_contato");
    expect(body.error.details).toMatchObject({ lead_id: LEAD_NO_DESTINO });
    expect(abertosDoContatoEm(P2)).toHaveLength(1);
    const origem = db.tables.crm_leads!.find((l) => l.id === LEAD_ID)!;
    expect(origem.status).toBe("open");
    expect(db.tables.crm_leads).toHaveLength(2);
  });

  it("PB-25b CONTROLE o negócio aberto no destino é de OUTRO contato: o clone segue (201)", async () => {
    preparar(OUTRO_CONTATO);
    const { POST } = await import("@/app/api/v1/leads/[id]/clone/route");

    const response = await POST(cloneRequest({ pipeline_id: P2 }), params);

    expect(response.status).toBe(201);
    expect(abertosDoContatoEm(P2)).toHaveLength(1);
    const origem = db.tables.crm_leads!.find((l) => l.id === LEAD_ID)!;
    expect(origem.status).toBe("lost");
    expect(origem.lost_reason).toBe("moved_to_another_pipeline");
  });
});
