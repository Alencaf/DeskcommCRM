/**
 * Tool MCP `crm_record_consent`: registra ou revoga o consentimento de um
 * contato, por finalidade, e emite a auditoria `lgpd.consent_changed`.
 *
 * O consentimento mora em `contacts.consent` (jsonb por finalidade, sem
 * tabela). A ação `lgpd.consent_changed` está declarada em
 * `lib/audit/actions.ts` e nenhum código a emitia: quem gravava por SQL
 * destruía a prova, porque a linha de auditoria É a evidência da base legal.
 *
 * ─── O que a tool garante ───────────────────────────────────────────────────
 *  - Grava SÓ a coluna `consent`, fundindo a finalidade no jsonb: as outras
 *    finalidades e as chaves que não são dela ficam como estavam.
 *  - Revogar é a mesma porta e nunca apaga a chave. A revogação de `marketing`
 *    grava também `declined_at`, a chave que a guarda de automação lê
 *    (`lib/automation/guarda-do-contato.ts`): um opt-out nunca é recusado.
 *  - Nunca concede `marketing`, de nenhuma origem. Lista importada (e vCard de
 *    parceiro) não é consentimento da pessoa.
 *  - Nunca limpa `is_blocked`, nunca mexe em `campaign_suppressions`.
 *  - `mode` nasce `simulate`; contato de outra organização e contato
 *    inexistente recebem a MESMA recusa; pessoal, anonimizado e fundido são
 *    recusados sem devolver campo nenhum deles.
 *  - A referência da evidência vive no evento `lgpd.consent_changed`; o
 *    `mcp.tool_called` não a leva (`redigirParaAuditoria`).
 */
import { z } from "zod";

import { comIdempotencia } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";

import type { McpContext, McpToolDefinition } from "../types";

const ENDPOINT = "crm_record_consent";
const FINALIDADES = ["transactional", "marketing", "profiling"] as const;
const BASES_LEGAIS = ["consent", "legitimate_interest", "contract"] as const;
const ORIGENS = ["ui", "whatsapp_message", "form", "vcard_from_partner", "import"] as const;
/** Origens em que a PESSOA é quem dá a prova (e não uma lista de terceiros). */
const ORIGENS_DA_PESSOA: ReadonlyArray<(typeof ORIGENS)[number]> = ["ui", "form", "whatsapp_message"];

type Modo = "simulate" | "apply";
type Desfecho = "updated" | "exists" | "conflict" | "refused";

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
  mode: Modo;
  outcome: Desfecho;
  id?: string;
  diff?: { consent: { from: Finalidade | null; to: Finalidade } };
  reason?: string;
}

interface ContatoDoConsentimento {
  id: string;
  is_personal: boolean | null;
  is_anonymized: boolean | null;
  is_blocked: boolean | null;
  is_merged_into: string | null;
  consent: Record<string, unknown> | null;
}

const inputShape = {
  contact_id: z.string().uuid(),
  purpose: z.enum(FINALIDADES),
  status: z.enum(["granted", "revoked"]),
  legal_basis: z.enum(BASES_LEGAIS),
  source: z.enum(ORIGENS),
  evidence_ref: z.string().trim().min(1).max(200),
  version: z.string().max(60).optional(),
  mode: z.enum(["simulate", "apply"]).default("simulate"),
  reason: z.string().max(280).optional(),
  idempotency_key: z.string().uuid().optional(),
};

type Input = z.infer<z.ZodObject<typeof inputShape>>;

const recusa = (mode: Modo, reason: string): Resultado => ({ applied: false, mode, outcome: "refused", reason });

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function estadoDe(f: Finalidade | null, finalidade: string): "granted" | "revoked" | "none" {
  if (!f) return "none";
  if (f.revoked_at || (finalidade === "marketing" && f.declined_at)) return "revoked";
  return f.granted_at ? "granted" : "none";
}

/** A política da tool, antes de olhar o estado da finalidade. `null` = liberado. */
function recusaDaPolitica(input: Input, contato: ContatoDoConsentimento): string | null {
  if (input.status === "revoked") return null; // um "não" nunca é recusado
  if (input.purpose === "marketing") {
    return input.source === "import" ? "imported_list_is_not_consent" : "marketing_not_recordable";
  }
  if (input.legal_basis === "consent" && input.source === "import") return "imported_list_is_not_consent";
  if (input.legal_basis === "consent" && input.source === "vcard_from_partner") return "partner_list_is_not_consent";
  if (contato.is_blocked === true) return "contact_blocked";
  return null;
}

async function carregarContato(ctx: McpContext, contactId: string): Promise<ContatoDoConsentimento | null> {
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("id, is_personal, is_anonymized, is_blocked, is_merged_into, consent")
    .eq("id", contactId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ContatoDoConsentimento | null) ?? null;
}

function novoRegistro(input: Input, ctx: McpContext, agora: string): Finalidade {
  const base = {
    source: input.source,
    version: input.version ?? null,
    legal_basis: input.legal_basis,
    evidence_ref: input.evidence_ref,
    actor: { type: ctx.actor.type, id: ctx.actor.id },
  };
  if (input.status === "granted") return { granted_at: agora, ...base };
  return {
    granted_at: null,
    revoked_at: agora,
    // A chave que a guarda de automação lê: sem ela o opt-out não seria honrado.
    ...(input.purpose === "marketing" ? { declined_at: agora } : {}),
    ...base,
  };
}

function mesmoRegistro(atual: Finalidade, input: Input): boolean {
  return (
    estadoDe(atual, input.purpose) === input.status &&
    atual.legal_basis === input.legal_basis &&
    atual.source === input.source &&
    atual.evidence_ref === input.evidence_ref &&
    (atual.version ?? null) === (input.version ?? null)
  );
}

async function avaliarEGravar(ctx: McpContext, input: Input): Promise<Resultado> {
  const modo = input.mode;
  const contato = await carregarContato(ctx, input.contact_id);
  if (!contato) return recusa(modo, "target_not_found");
  if (contato.is_personal === true || contato.is_anonymized === true) return recusa(modo, "contact_not_eligible");
  if (contato.is_merged_into) return recusa(modo, "contact_merged");

  const politica = recusaDaPolitica(input, contato);
  if (politica) return recusa(modo, politica);

  const consent = ehObjeto(contato.consent) ? contato.consent : {};
  const atual = ehObjeto(consent[input.purpose]) ? (consent[input.purpose] as Finalidade) : null;

  // Depois de uma revogação, só a prova que vem da PESSOA concede de novo: uma
  // lista de parceiro não desfaz o "não" do titular.
  if (
    input.status === "granted" &&
    estadoDe(atual, input.purpose) === "revoked" &&
    !ORIGENS_DA_PESSOA.includes(input.source)
  ) {
    return recusa(modo, "purpose_revoked");
  }

  if (atual && mesmoRegistro(atual, input)) {
    return { applied: false, mode: modo, outcome: "exists", id: contato.id };
  }

  const registro = novoRegistro(input, ctx, new Date().toISOString());
  if (modo === "simulate") {
    return {
      applied: false,
      mode: modo,
      outcome: "updated",
      id: contato.id,
      diff: { consent: { from: atual, to: registro } },
    };
  }

  const { error } = await ctx.supabase
    .from("contacts")
    .update({ consent: { ...consent, [input.purpose]: registro } })
    .eq("id", contato.id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw new Error(error.message);

  await audit({
    action: "lgpd.consent_changed",
    actorUserId: null,
    actorApiTokenId: ctx.apiTokenId,
    organizationId: ctx.organizationId,
    resourceType: "contact",
    resourceId: contato.id,
    requestId: ctx.requestId,
    metadata: {
      via: "mcp",
      purpose: input.purpose,
      status: input.status,
      reason: input.reason ?? null,
      before: atual,
      after: registro,
    },
  });

  return { applied: true, mode: modo, outcome: "updated", id: contato.id };
}

export const crmRecordConsent: McpToolDefinition<typeof inputShape> = {
  name: "crm_record_consent",
  description:
    "Registra ou revoga o consentimento de um contato por finalidade (transactional, marketing, profiling), com " +
    "a base legal (consent, legitimate_interest, contract), a origem da prova (`source`) e uma referência da " +
    "evidência (`evidence_ref`, até 200: um id ou nome de documento, NUNCA o texto da mensagem). Nasce em " +
    "`mode: \"simulate\"`: para gravar envie `mode: \"apply\"` e um `reason` (até 280). Grava só `contacts.consent`, " +
    "sem tocar nas outras finalidades, e emite a auditoria `lgpd.consent_changed`. Revogar (`status: \"revoked\"`) " +
    "nunca é recusado e nunca apaga; a revogação de marketing vale como opt-out. Nesta versão NÃO concede " +
    "`marketing`, e lista importada ou vCard de parceiro não vale como consentimento. Depois de uma revogação, só " +
    "prova vinda da pessoa (ui, form, whatsapp_message) concede de novo. Recusa contato pessoal, anonimizado, " +
    "fundido, bloqueado (para conceder) ou de outra organização. Repetir o mesmo registro devolve `exists`; " +
    "`idempotency_key` repete a resposta da primeira chamada.",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "manager",
  requiresScope: "mcp:write",
  // A referência da evidência vai só para o evento de consentimento.
  redigirParaAuditoria: (args) => ({
    mode: args.mode ?? "simulate",
    ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    contact_id: args.contact_id,
    purpose: args.purpose,
    status: args.status,
    legal_basis: args.legal_basis,
    source: args.source,
    idempotency_key: args.idempotency_key,
  }),
  handler: async (input, ctx) => {
    if (input.mode === "apply" && !input.reason) {
      throw new Error("invalid_input: reason is required when mode is apply");
    }
    if (input.mode === "simulate") return avaliarEGravar(ctx, input);

    const chave = input.idempotency_key ?? ctx.idempotencyKey;
    if (!chave) return avaliarEGravar(ctx, input);

    const { idempotency_key: _chave, ...corpo } = input;
    const desfecho = await comIdempotencia<Resultado>({
      db: ctx.supabase,
      organizationId: ctx.organizationId,
      endpoint: ENDPOINT,
      chave,
      corpo,
      executar: async () => ({ resposta: await avaliarEGravar(ctx, input), status: 200 }),
    });
    switch (desfecho.tipo) {
      case "executou":
      case "replay":
        return desfecho.resposta;
      case "conflito":
        return {
          applied: false,
          mode: input.mode,
          outcome: "conflict",
          reason: "idempotency_key_reused_with_different_body",
        } satisfies Resultado;
      case "em_curso":
        throw new Error("idempotency_in_progress: a call with this key is still running; retry shortly");
    }
  },
};
