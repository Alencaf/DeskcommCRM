/**
 * Tools MCP de TAREFA INTERNA: `crm_create_task` e `crm_list_tasks`.
 *
 * `crm_tasks` já tinha tudo (inclusive `source_kind`, migration 0464), mas a
 * rota REST só aceita cookie e nenhuma tool a alcançava: um agente externo que
 * percebe algo para uma pessoa conferir não tinha onde deixar isso. Sem
 * migration — esta tool só escreve na tabela que já existe.
 *
 * ─── Como a escrita é segura ────────────────────────────────────────────────
 *  - `mode` nasce `simulate`: esquecer a flag nunca grava.
 *  - O alvo (contato, negócio, responsável) é conferido NA ORGANIZAÇÃO do
 *    token: `ctx.supabase` é service-role e não tem RLS. Id de outra
 *    organização e id inexistente recebem a MESMA recusa.
 *  - Contato pessoal ou anonimizado é recusado sem devolver campo nenhum dele.
 *  - Chave natural `(organização, contato|negócio, título)` em tarefa aberta →
 *    `exists`; `Idempotency-Key` (argumento ou header) repete a resposta.
 *  - `created_by` fica NULO: ele é FK para `auth.users`, e o ator aqui é um
 *    token, não uma pessoa (a mesma armadilha de `actor_user_id` em `audit.ts`).
 *  - O texto da tarefa nunca entra em `api_audit_log` (`redigirParaAuditoria`).
 */
import { z } from "zod";

import { comIdempotencia } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA } from "@/lib/tarefas/tipos";
import type { TaskSourceKind } from "@/lib/tarefas/vocabulario-de-origem";

import type { McpContext, McpToolDefinition } from "../types";

const ORIGEM_MCP: TaskSourceKind = "mcp_tool";
const ENDPOINT_CRIAR = "crm_create_task";
const PREFIXO_DE_REVISAO = "[Revisar] ";
const TETO_DA_LISTA = 100;

type Modo = "simulate" | "apply";
type Desfecho = "created" | "exists" | "conflict" | "refused";

interface Resultado {
  applied: boolean;
  mode: Modo;
  outcome: Desfecho;
  id?: string;
  diff?: Record<string, { from: unknown; to: unknown }>;
  reason?: string;
}

const recusa = (mode: Modo, reason: string): Resultado => ({
  applied: false,
  mode,
  outcome: "refused",
  reason,
});

// ---------------------------------------------------------------------------
// crm_create_task
// ---------------------------------------------------------------------------

const criarInputShape = {
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  due_date: z.string().datetime({ offset: true }).optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA),
  kind: z.enum(["task", "review"]),
  contact_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  evidence: z
    .object({
      source: z.string().trim().min(1).max(200),
      confidence: z.number().min(0).max(1),
      question: z.string().trim().min(1).max(500),
    })
    .optional(),
  mode: z.enum(["simulate", "apply"]).default("simulate"),
  reason: z.string().max(280).optional(),
  idempotency_key: z.string().uuid().optional(),
};

type CriarInput = z.infer<z.ZodObject<typeof criarInputShape>>;

interface TarefaAberta {
  id: string;
}

function invalido(motivo: string): Error {
  return new Error(`invalid_input: ${motivo}`);
}

function validarRegrasCruzadas(input: CriarInput): void {
  if (input.mode === "apply" && !input.reason) {
    throw invalido("reason is required when mode is apply");
  }
  if (!input.contact_id && !input.lead_id) {
    throw invalido("contact_id or lead_id is required");
  }
  if (input.kind === "review" && !input.evidence) {
    throw invalido("evidence is required when kind is review");
  }
}

function tituloFinal(input: CriarInput): string {
  return input.kind === "review" ? `${PREFIXO_DE_REVISAO}${input.title}` : input.title;
}

function descricaoFinal(input: CriarInput): string | null {
  if (input.kind !== "review" || !input.evidence) return input.description ?? null;
  const { source, confidence, question } = input.evidence;
  const bloco = [
    "Evidência",
    `Fonte: ${source}`,
    `Confiança: ${confidence}`,
    `Pergunta: ${question}`,
  ].join("\n");
  return input.description ? `${input.description}\n\n${bloco}` : bloco;
}

/** Contato existente nesta organização e elegível; `null` quando a recusa é um só caso. */
async function contatoElegivel(
  ctx: McpContext,
  contactId: string,
): Promise<"ok" | "nao_encontrado" | "indisponivel"> {
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("id, is_personal, is_anonymized")
    .eq("id", contactId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return "nao_encontrado";
  const c = data as { is_personal: boolean | null; is_anonymized: boolean | null };
  return c.is_personal === true || c.is_anonymized === true ? "indisponivel" : "ok";
}

async function conferirAlvo(
  ctx: McpContext,
  input: CriarInput,
  modo: Modo,
): Promise<Resultado | null> {
  if (input.contact_id) {
    const veredito = await contatoElegivel(ctx, input.contact_id);
    if (veredito === "nao_encontrado") return recusa(modo, "target_not_found");
    if (veredito === "indisponivel") return recusa(modo, "contact_not_eligible");
  }

  if (input.lead_id) {
    const { data, error } = await ctx.supabase
      .from("crm_leads")
      .select("id, contact_id")
      .eq("id", input.lead_id)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return recusa(modo, "target_not_found");
    const doNegocio = (data as { contact_id: string | null }).contact_id;
    if (doNegocio) {
      const veredito = await contatoElegivel(ctx, doNegocio);
      if (veredito !== "ok") return recusa(modo, "contact_not_eligible");
    }
  }

  if (input.assigned_to) {
    const { data, error } = await ctx.supabase
      .from("user_organizations")
      .select("user_id")
      .eq("user_id", input.assigned_to)
      .eq("organization_id", ctx.organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return recusa(modo, "assignee_not_member");
  }

  return null;
}

async function tarefaAbertaIgual(
  ctx: McpContext,
  input: CriarInput,
  titulo: string,
): Promise<TarefaAberta | null> {
  let consulta = ctx.supabase
    .from("crm_tasks")
    .select("id")
    .eq("organization_id", ctx.organizationId)
    .eq("title", titulo)
    .in("status", ["pending", "in_progress"]);
  if (input.contact_id) consulta = consulta.eq("contact_id", input.contact_id);
  if (input.lead_id) consulta = consulta.eq("lead_id", input.lead_id);
  const { data, error } = await consulta.order("created_at", { ascending: true }).limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0] as TarefaAberta | undefined) ?? null;
}

function diffDaCriacao(input: CriarInput, titulo: string, descricao: string | null) {
  const diff: Record<string, { from: unknown; to: unknown }> = {
    title: { from: null, to: titulo },
    priority: { from: null, to: input.priority },
    status: { from: null, to: "pending" },
  };
  if (descricao) diff.description = { from: null, to: descricao };
  if (input.due_date) diff.due_date = { from: null, to: input.due_date };
  if (input.contact_id) diff.contact_id = { from: null, to: input.contact_id };
  if (input.lead_id) diff.lead_id = { from: null, to: input.lead_id };
  if (input.assigned_to) diff.assigned_to = { from: null, to: input.assigned_to };
  return diff;
}

async function gravar(
  ctx: McpContext,
  input: CriarInput,
  titulo: string,
  descricao: string | null,
): Promise<Resultado> {
  const existente = await tarefaAbertaIgual(ctx, input, titulo);
  if (existente) return { applied: false, mode: "apply", outcome: "exists", id: existente.id };

  const { data, error } = await ctx.supabase
    .from("crm_tasks")
    .insert({
      organization_id: ctx.organizationId,
      title: titulo,
      description: descricao,
      due_date: input.due_date ?? null,
      priority: input.priority,
      status: "pending",
      lead_id: input.lead_id ?? null,
      contact_id: input.contact_id ?? null,
      assigned_to: input.assigned_to ?? null,
      created_by: null,
      source_kind: ORIGEM_MCP,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "task_insert_failed");
  const id = (data as { id: string }).id;

  await audit({
    action: "crm_task.created",
    actorUserId: null,
    actorApiTokenId: ctx.apiTokenId,
    organizationId: ctx.organizationId,
    resourceType: "crm_tasks",
    resourceId: id,
    requestId: ctx.requestId,
    metadata: {
      via: "mcp",
      kind: input.kind,
      priority: input.priority,
      due_date: input.due_date ?? null,
      lead_id: input.lead_id ?? null,
      contact_id: input.contact_id ?? null,
      assigned_to: input.assigned_to ?? null,
    },
  });

  // O laço de retorno: tarefa presa a um negócio aparece na linha do tempo dele.
  await registraAtividadeDaTarefa(ctx.supabase, {
    organizationId: ctx.organizationId,
    tarefa: {
      id,
      title: titulo,
      due_date: input.due_date ?? null,
      priority: input.priority,
      lead_id: input.lead_id ?? null,
      contact_id: input.contact_id ?? null,
    },
    tipo: "task_created",
    actor: ctx.actor,
  });

  return { applied: true, mode: "apply", outcome: "created", id };
}

export const crmCreateTask: McpToolDefinition<typeof criarInputShape> = {
  name: "crm_create_task",
  description:
    "Abre uma tarefa INTERNA (lembrete de trabalho para a equipe, nunca mensagem ao cliente) ligada a um " +
    "contato ou a um negócio. Informe `contact_id` ou `lead_id`. Nasce em `mode: \"simulate\"`: só mostra o que " +
    "aconteceria; para gravar envie `mode: \"apply\"` e um `reason` (até 280). Com `kind: \"review\"` a tarefa pede " +
    "que uma pessoa confira algo: `evidence` (fonte, confiança de 0 a 1 e a pergunta) é obrigatória, o título " +
    "ganha o prefixo \"[Revisar] \" e a evidência vai no corpo. Se já existe tarefa aberta com o mesmo título para " +
    "o mesmo contato ou negócio, devolve `exists` com o id dela, sem duplicar. `idempotency_key` repete a resposta " +
    "da primeira chamada. Recusa contato pessoal ou anonimizado e alvo de outra organização.",
  inputSchema: criarInputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  // O texto da tarefa é conteúdo do cliente: log é lugar de metadado.
  redigirParaAuditoria: (args) => ({
    mode: args.mode ?? "simulate",
    ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    kind: args.kind,
    priority: args.priority,
    contact_id: args.contact_id,
    lead_id: args.lead_id,
    assigned_to: args.assigned_to,
    due_date: args.due_date,
    has_description: typeof args.description === "string" && args.description.length > 0,
    has_evidence: args.evidence !== undefined,
    idempotency_key: args.idempotency_key,
  }),
  handler: async (input, ctx) => {
    validarRegrasCruzadas(input);
    const modo = input.mode;

    const recusado = await conferirAlvo(ctx, input, modo);
    if (recusado) return recusado;

    const titulo = tituloFinal(input);
    const descricao = descricaoFinal(input);

    if (modo === "simulate") {
      const existente = await tarefaAbertaIgual(ctx, input, titulo);
      if (existente) {
        return { applied: false, mode: modo, outcome: "exists", id: existente.id } satisfies Resultado;
      }
      return {
        applied: false,
        mode: modo,
        outcome: "created",
        diff: diffDaCriacao(input, titulo, descricao),
      } satisfies Resultado;
    }

    const chave = input.idempotency_key ?? ctx.idempotencyKey;
    if (!chave) return gravar(ctx, input, titulo, descricao);

    const { idempotency_key: _chave, ...corpo } = input;
    const desfecho = await comIdempotencia<Resultado>({
      db: ctx.supabase,
      organizationId: ctx.organizationId,
      endpoint: ENDPOINT_CRIAR,
      chave,
      corpo,
      executar: async () => ({ resposta: await gravar(ctx, input, titulo, descricao), status: 200 }),
    });
    switch (desfecho.tipo) {
      case "executou":
      case "replay":
        return desfecho.resposta;
      case "conflito":
        return {
          applied: false,
          mode: modo,
          outcome: "conflict",
          reason: "idempotency_key_reused_with_different_body",
        } satisfies Resultado;
      case "em_curso":
        throw new Error("idempotency_in_progress: a call with this key is still running; retry shortly");
    }
  },
};

// ---------------------------------------------------------------------------
// crm_list_tasks
// ---------------------------------------------------------------------------

const listarInputShape = {
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  contact_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(TETO_DA_LISTA).optional(),
};

const COLUNAS_DA_LISTA =
  "id, title, description, status, priority, due_date, contact_id, lead_id, assigned_to, created_at";

interface LinhaDaLista {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  contact_id: string | null;
  lead_id: string | null;
  assigned_to: string | null;
  created_at: string;
}

/** Contatos (entre `ids`) que a leitura não mostra: pessoais e anonimizados. */
async function contatosProtegidos(ctx: McpContext, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select("id, is_personal, is_anonymized")
    .eq("organization_id", ctx.organizationId)
    .in("id", ids);
  if (error) throw new Error(error.message);
  return new Set(
    ((data ?? []) as Array<{ id: string; is_personal: boolean | null; is_anonymized: boolean | null }>)
      .filter((c) => c.is_personal === true || c.is_anonymized === true)
      .map((c) => c.id),
  );
}

export const crmListTasks: McpToolDefinition<typeof listarInputShape> = {
  name: "crm_list_tasks",
  description:
    "Lista as tarefas internas da organização, em ordem de prazo. Filtros opcionais: `status` " +
    "(pending, in_progress, done, cancelled), `contact_id`, `lead_id` e `limit` (até 100). Não lista " +
    "tarefa de contato pessoal ou anonimizado. Só leitura.",
  inputSchema: listarInputShape,
  category: "read",
  requiresRole: "agent",
  requiresScope: "mcp:read",
  handler: async (input, ctx) => {
    // Durante um turno de conversa a leitura fica presa ao contato dela.
    const contato = ctx.contatoDoTurno ?? input.contact_id;
    if (ctx.contatoDoTurno && input.contact_id && input.contact_id !== ctx.contatoDoTurno) {
      return { tasks: [] };
    }

    let consulta = ctx.supabase
      .from("crm_tasks")
      .select(COLUNAS_DA_LISTA)
      .eq("organization_id", ctx.organizationId)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(input.limit ?? TETO_DA_LISTA);
    if (input.status) consulta = consulta.eq("status", input.status);
    if (contato) consulta = consulta.eq("contact_id", contato);
    if (input.lead_id) consulta = consulta.eq("lead_id", input.lead_id);

    const { data, error } = await consulta;
    if (error) throw new Error(error.message);
    const linhas = (data ?? []) as LinhaDaLista[];

    // O contato de uma tarefa só de negócio é o do negócio.
    const idsDeNegocio = [...new Set(linhas.filter((t) => !t.contact_id && t.lead_id).map((t) => t.lead_id!))];
    const donoDoNegocio = new Map<string, string>();
    if (idsDeNegocio.length > 0) {
      const { data: negocios, error: erroDeNegocio } = await ctx.supabase
        .from("crm_leads")
        .select("id, contact_id")
        .eq("organization_id", ctx.organizationId)
        .in("id", idsDeNegocio);
      if (erroDeNegocio) throw new Error(erroDeNegocio.message);
      for (const n of (negocios ?? []) as Array<{ id: string; contact_id: string | null }>) {
        if (n.contact_id) donoDoNegocio.set(n.id, n.contact_id);
      }
    }
    const contatoDe = (t: LinhaDaLista) => t.contact_id ?? (t.lead_id ? donoDoNegocio.get(t.lead_id) : undefined) ?? null;

    const protegidos = await contatosProtegidos(
      ctx,
      [...new Set(linhas.map(contatoDe).filter((id): id is string => id !== null))],
    );
    return { tasks: linhas.filter((t) => !protegidos.has(contatoDe(t) ?? "")) };
  },
};
