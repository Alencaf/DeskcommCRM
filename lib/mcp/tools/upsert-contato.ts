/**
 * Tool MCP `crm_upsert_contact`: cria o contato ou completa o que já existe, a
 * partir do TELEFONE.
 *
 * Nenhuma porta `dsk_` chegava a `contacts` com dedupe: o MCP só PROPÕE campo
 * (`crm_propose_contact_field`), a rota REST aceita cookie e grava o telefone
 * por `canonicalPhoneBR` (que ACRESCENTA o nono dígito), e `fn_upsert_wa_contact`
 * grava `source='whatsapp'` e também acrescenta o dígito. Esta tool serve a quem
 * reconcilia uma lista: acha o contato pelas variantes do número, nunca inventa
 * dígito, funde em vez de substituir e não escreve o que não é dela.
 *
 * ─── O que a tool garante ───────────────────────────────────────────────────
 *  - O telefone gravado é EXATAMENTE o enviado. Celular brasileiro sem o nono
 *    dígito é recusado (`invalid_phone`), nunca "corrigido". O telefone de um
 *    contato existente achado por variante NUNCA é reescrito.
 *  - O contato existente é achado pelas duas grafias do número, seguindo
 *    `is_merged_into` até o sobrevivente. Dois contatos vivos casando = `conflict`.
 *  - Em contato existente nada é substituído: `custom_fields` e `source_metadata`
 *    fundem por chave, `papel_historico` só recebe acréscimo (o que já está lá é
 *    pulado), `person_id` só é preenchido se vazio, o nome já preenchido e a
 *    origem (`source`) ficam como estão, e a etiqueta `cliente` (do sistema) é
 *    descartada.
 *  - Só escreve em `contacts` (e no recibo de idempotência): nunca consentimento,
 *    bloqueio, colunas de cliente, conversa ou mensagem. Não emite `contact.created`
 *    (uma carga em lote não deve disparar automação).
 *  - `mode` nasce `simulate`; contato pessoal ou anonimizado é recusado sem
 *    devolver campo dele; o texto da pessoa nunca entra em `api_audit_log`.
 *  - `created_by_user_id` fica NULO: o ator é um token, não uma pessoa.
 */
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { comIdempotencia } from "@/lib/api/idempotency";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { normalizarTags } from "@/lib/contacts/tag-normalizada";
import { conferirCamposPersonalizados } from "../conferencia-de-campos";

import type { McpContext, McpToolDefinition } from "../types";

const ENDPOINT = "crm_upsert_contact";
const ORIGENS = ["import_vcard", "import_sheet", "datalake", "triage", "manual"] as const;
const TETO_DE_TAGS = 20;
const TAG_DO_SISTEMA = "cliente";
const HISTORICO = "papel_historico";
const MAX_SALTOS_DE_FUSAO = 5;
const COLUNAS =
  "id, phone_number, name, display_name, tags, source, source_metadata, custom_fields, person_id, is_personal, is_anonymized, is_merged_into";

type Modo = "simulate" | "apply";
type Desfecho = "created" | "updated" | "exists" | "conflict" | "refused";
type Diff = Record<string, { from: unknown; to: unknown }>;

interface Resultado {
  applied: boolean;
  mode: Modo;
  outcome: Desfecho;
  id?: string;
  diff?: Diff;
  reason?: string;
  warnings?: string[];
  /** Campos que a conferência (#2234) não deixou gravar, e o ensino para o modelo. */
  campos_nao_gravados?: unknown[];
  erro_de_ensino?: string;
}

interface Contato {
  id: string;
  phone_number: string | null;
  name: string | null;
  display_name: string | null;
  tags: string[] | null;
  source: string;
  source_metadata: Record<string, unknown> | null;
  custom_fields: Record<string, unknown> | null;
  person_id: string | null;
  is_personal: boolean | null;
  is_anonymized: boolean | null;
  is_merged_into: string | null;
}

const inputShape = {
  phone: z.string().regex(/^\+\d{8,15}$/, "phone must be E.164, e.g. +5511999990000"),
  name: z.string().trim().min(1).max(200).optional(),
  display_name: z.string().trim().min(1).max(200).optional(),
  source: z.enum(ORIGENS),
  external_refs: z.record(z.string().min(1).max(80), z.string().max(200)).optional(),
  person_id: z.string().uuid().optional(),
  custom_fields: z.record(z.string().min(1).max(80), z.unknown()).optional(),
  tags_add: z.array(z.string()).max(TETO_DE_TAGS).optional(),
  batch_tag: z.string().trim().min(1).max(80).optional(),
  mode: z.enum(["simulate", "apply"]).default("simulate"),
  reason: z.string().max(280).optional(),
  idempotency_key: z.string().uuid().optional(),
};

type Input = z.infer<z.ZodObject<typeof inputShape>>;

const recusa = (mode: Modo, reason: string): Resultado => ({ applied: false, mode, outcome: "refused", reason });
const conflito = (mode: Modo, reason: string): Resultado => ({ applied: false, mode, outcome: "conflict", reason });

const nuloSeAusente = (v: string | undefined): string | null => (v === undefined ? null : v);

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Celular brasileiro sem o nono dígito (12 dígitos, local de 8 começando em 6-9). */
function celularSemONono(phone: string): boolean {
  const d = phone.replace(/\D/g, "");
  if (!d.startsWith("55") || d.length !== 12) return false;
  return /^[1-9][0-9]$/.test(d.slice(2, 4)) && /^[6-9]/.test(d.slice(4));
}

async function acharContato(
  ctx: McpContext,
  phone: string,
): Promise<{ ok: true; contato: Contato | null } | { ok: false; motivo: string }> {
  const { data, error } = await ctx.supabase
    .from("contacts")
    .select(COLUNAS)
    .eq("organization_id", ctx.organizationId)
    .in("phone_number", phoneLookupVariants(phone));
  if (error) throw new Error(error.message);

  const vivos = new Map<string, Contato>();
  for (const candidato of (data ?? []) as Contato[]) {
    let atual: Contato | null = candidato;
    for (let salto = 0; atual?.is_merged_into && salto < MAX_SALTOS_DE_FUSAO; salto++) {
      const idDoSobrevivente: string = atual.is_merged_into;
      const resposta = await ctx.supabase
        .from("contacts")
        .select(COLUNAS)
        .eq("id", idDoSobrevivente)
        .eq("organization_id", ctx.organizationId)
        .maybeSingle();
      if (resposta.error) throw new Error(resposta.error.message);
      atual = (resposta.data as Contato | null) ?? null;
    }
    if (!atual || atual.is_merged_into) return { ok: false, motivo: "merged_survivor_not_found" };
    vivos.set(atual.id, atual);
  }
  if (vivos.size > 1) return { ok: false, motivo: "ambiguous_phone" };
  return { ok: true, contato: [...vivos.values()][0] ?? null };
}

async function pessoaDaOrganizacao(ctx: McpContext, personId: string): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from("people")
    .select("id")
    .eq("id", personId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data !== null;
}

/** Etiquetas pedidas, normalizadas e sem a do sistema. */
function etiquetasPedidas(input: Input): { adicionar: string[]; avisos: string[] } {
  const normalizadas = normalizarTags(input.tags_add ?? []);
  const avisos = normalizadas.includes(TAG_DO_SISTEMA) ? ["system_owned_tag: cliente"] : [];
  return { adicionar: normalizadas.filter((t) => t !== TAG_DO_SISTEMA), avisos };
}

function acrescentarAoHistorico(atual: unknown, enviado: unknown[]): { valor: unknown[]; mudou: boolean } {
  const base = Array.isArray(atual) ? atual : [];
  const novas: unknown[] = [];
  for (const entrada of enviado) {
    const jaTem = [...base, ...novas].some((e) => isDeepStrictEqual(e, entrada));
    if (!jaTem) novas.push(entrada);
  }
  return { valor: [...base, ...novas], mudou: novas.length > 0 };
}

async function avaliar(
  ctx: McpContext,
  input: Input,
  gravar: boolean,
): Promise<Resultado> {
  const modo = input.mode;
  if (celularSemONono(input.phone)) return recusa(modo, "invalid_phone");

  const cf = input.custom_fields ?? {};
  if (HISTORICO in cf && !Array.isArray(cf[HISTORICO])) return recusa(modo, "papel_historico_is_append_only");

  const { adicionar, avisos } = etiquetasPedidas(input);

  if (input.person_id && !(await pessoaDaOrganizacao(ctx, input.person_id))) {
    return recusa(modo, "person_not_found");
  }

  const achado = await acharContato(ctx, input.phone);
  if (!achado.ok) return conflito(modo, achado.motivo);

  // ── Criação ──────────────────────────────────────────────────────────────
  if (!achado.contato) {
    if (adicionar.length > TETO_DE_TAGS) return recusa(modo, "too_many_tags");
    const metadados: Record<string, unknown> = {
      ...(input.external_refs ? { external_refs: input.external_refs } : {}),
      ...(input.batch_tag ? { batch_tag: input.batch_tag } : {}),
    };
    const linha = {
      organization_id: ctx.organizationId,
      phone_number: input.phone,
      name: input.name ?? null,
      display_name: nuloSeAusente(input.display_name),
      source: input.source,
      source_metadata: metadados,
      custom_fields: cf,
      tags: adicionar,
      person_id: input.person_id ?? null,
      created_by_user_id: null,
    };
    const avisosDaCriacao = avisos.length > 0 ? { warnings: avisos } : {};
    if (!gravar) {
      const diff: Diff = {
        phone_number: { from: null, to: linha.phone_number },
        source: { from: null, to: linha.source },
      };
      for (const campo of ["name", "display_name", "tags", "person_id", "source_metadata", "custom_fields"] as const) {
        const alvo = linha[campo];
        const vazio = alvo === null || (Array.isArray(alvo) && alvo.length === 0) || (ehObjeto(alvo) && Object.keys(alvo).length === 0);
        if (!vazio) diff[campo] = { from: null, to: alvo };
      }
      return { applied: false, mode: modo, outcome: "created", diff, ...avisosDaCriacao };
    }
    const { data, error } = await ctx.supabase.from("contacts").insert(linha).select("id").single();
    if (error) {
      // Outro chamador criou o mesmo telefone entre a busca e a gravação.
      if ((error as { code?: string }).code === "23505") return conflito(modo, "phone_taken_concurrently");
      throw new Error(error.message);
    }
    return { applied: true, mode: modo, outcome: "created", id: (data as { id: string }).id, ...avisosDaCriacao };
  }

  // ── Contato existente ────────────────────────────────────────────────────
  const existente = achado.contato;
  if (existente.is_personal === true || existente.is_anonymized === true) {
    return recusa(modo, "contact_not_eligible");
  }

  const patch: Record<string, unknown> = {};
  const diff: Diff = {};
  const registrar = (campo: string, de: unknown, para: unknown) => {
    patch[campo] = para;
    diff[campo] = { from: de, to: para };
  };
  const avisosDoUpdate = [...avisos];
  let recusado: string | null = null;
  let conflitante: string | null = null;

  for (const campo of ["name", "display_name"] as const) {
    const enviado = input[campo];
    if (!enviado) continue;
    const atual = existente[campo];
    if (!atual || atual.trim() === "") registrar(campo, atual, enviado);
    else if (atual !== enviado) avisosDoUpdate.push(`${campo}_differs`);
  }

  if (input.person_id) {
    if (existente.person_id === null) registrar("person_id", null, input.person_id);
    else if (existente.person_id !== input.person_id) conflitante = "person_id_differs";
  }

  const metadadosAtuais = ehObjeto(existente.source_metadata) ? existente.source_metadata : {};
  const metadados = { ...metadadosAtuais };
  let metadadosMudaram = false;
  if (input.external_refs) {
    const refsAtuais = ehObjeto(metadadosAtuais.external_refs) ? (metadadosAtuais.external_refs as Record<string, unknown>) : {};
    const refs = { ...refsAtuais };
    for (const [chave, valor] of Object.entries(input.external_refs)) {
      if (chave in refsAtuais) {
        if (refsAtuais[chave] !== valor) conflitante = "external_ref_differs";
      } else {
        refs[chave] = valor;
        metadadosMudaram = true;
      }
    }
    metadados.external_refs = refs;
  }
  if (input.batch_tag && metadadosAtuais.batch_tag === undefined) {
    metadados.batch_tag = input.batch_tag;
    metadadosMudaram = true;
  }
  if (metadadosMudaram) registrar("source_metadata", existente.source_metadata ?? {}, metadados);

  const camposAtuais = ehObjeto(existente.custom_fields) ? existente.custom_fields : {};
  const campos = { ...camposAtuais };
  let camposMudaram = false;
  for (const [chave, valor] of Object.entries(cf)) {
    if (chave === HISTORICO) {
      if (camposAtuais[HISTORICO] != null && !Array.isArray(camposAtuais[HISTORICO])) {
        conflitante = "papel_historico_malformed";
        continue;
      }
      const { valor: historico, mudou } = acrescentarAoHistorico(camposAtuais[HISTORICO], valor as unknown[]);
      if (mudou) {
        campos[HISTORICO] = historico;
        camposMudaram = true;
      }
    } else if (!isDeepStrictEqual(camposAtuais[chave], valor)) {
      campos[chave] = valor;
      camposMudaram = true;
    }
  }
  if (camposMudaram) registrar("custom_fields", existente.custom_fields ?? {}, campos);

  const tagsAtuais = existente.tags ?? [];
  const jaNormalizadas = normalizarTags(tagsAtuais);
  if (adicionar.some((t) => !jaNormalizadas.includes(t))) {
    const todas = normalizarTags([...tagsAtuais, ...adicionar]);
    if (todas.length > TETO_DE_TAGS) recusado = "too_many_tags";
    else registrar("tags", tagsAtuais, todas);
  }

  if (recusado) return recusa(modo, recusado);
  if (conflitante) return conflito(modo, conflitante);

  const comAvisos = avisosDoUpdate.length > 0 ? { warnings: avisosDoUpdate } : {};
  if (Object.keys(patch).length === 0) {
    return { applied: false, mode: modo, outcome: "exists", id: existente.id, ...comAvisos };
  }
  if (!gravar) return { applied: false, mode: modo, outcome: "updated", id: existente.id, diff, ...comAvisos };

  const { error } = await ctx.supabase
    .from("contacts")
    .update(patch)
    .eq("id", existente.id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw new Error(error.message);
  return { applied: true, mode: modo, outcome: "updated", id: existente.id, ...comAvisos };
}

export const crmUpsertContact: McpToolDefinition<typeof inputShape> = {
  name: "crm_upsert_contact",
  description:
    "Cria o contato ou completa o que já existe a partir do telefone em E.164 (+55DDDNNNNNNNNN). NUNCA inventa o " +
    "nono dígito: celular brasileiro sem ele é recusado (`invalid_phone`), e um contato já gravado em outra grafia " +
    "do número é encontrado e reaproveitado, sem mexer no telefone dele. Nasce em `mode: \"simulate\"`: só mostra o " +
    "que aconteceria; para gravar envie `mode: \"apply\"` e um `reason` (até 280). Em contato existente nada é " +
    "substituído: `custom_fields` e `external_refs` fundem por chave, `custom_fields.papel_historico` só recebe " +
    "acréscimo (as entradas enviadas são acrescentadas, as que já existem são puladas; null ou não-lista é " +
    "recusado), `person_id` só preenche se vazio (senão `conflict`), nome e origem já gravados ficam (a diferença " +
    "vai em `warnings`) e a etiqueta `cliente` é do sistema e descartada. `batch_tag` (opcional) marca o lote em " +
    "`source_metadata`. Nunca grava consentimento, bloqueio nem dado de cliente, e não abre conversa. Recusa contato " +
    "pessoal ou anonimizado. Dois contatos vivos com o número = `conflict`. Repetir a mesma chamada devolve " +
    "`exists`; `idempotency_key` repete a resposta da primeira.",
  inputSchema: inputShape,
  category: "write",
  requiresRole: "agent",
  requiresScope: "mcp:write",
  // Telefone, nome e dados personalizados são da pessoa: log é lugar de metadado.
  redigirParaAuditoria: (args) => ({
    mode: args.mode ?? "simulate",
    ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    source: args.source,
    person_id: args.person_id,
    batch_tag: args.batch_tag,
    tags_count: Array.isArray(args.tags_add) ? args.tags_add.length : 0,
    has_external_refs: args.external_refs !== undefined,
    has_custom_fields: args.custom_fields !== undefined,
    idempotency_key: args.idempotency_key,
  }),
  handler: async (input, ctx) => {
    if (input.mode === "apply" && !input.reason) {
      throw new Error("invalid_input: reason is required when mode is apply");
    }
    // #2234: a mesma conferência do `crm_create_lead`/`crm_update_lead`. Só decide
    // para o agente de IA num turno (campo que o cliente não disse não é gravado e
    // o ensino volta ao modelo); para tela, token de terceiro e automação é no-op.
    // Roda DENTRO de cada execução, para o replay de uma chave não chamar de novo.
    const avaliarConferindo = async (gravar: boolean): Promise<Resultado> => {
      const conferencia = await conferirCamposPersonalizados(ctx, { semFunil: true }, input.custom_fields);
      const efetivo =
        conferencia.custom_fields === undefined ? input : { ...input, custom_fields: conferencia.custom_fields };
      const resultado = await avaliar(ctx, efetivo, gravar);
      if (conferencia.recusados.length === 0) return resultado;
      return {
        ...resultado,
        campos_nao_gravados: conferencia.recusados,
        erro_de_ensino: conferencia.recusados.map((r) => r.mensagem).join(" "),
      };
    };
    if (input.mode === "simulate") return avaliarConferindo(false);

    const chave = input.idempotency_key ?? ctx.idempotencyKey;
    if (!chave) return avaliarConferindo(true);

    const { idempotency_key: _chave, ...corpo } = input;
    const desfecho = await comIdempotencia<Resultado>({
      db: ctx.supabase,
      organizationId: ctx.organizationId,
      endpoint: ENDPOINT,
      chave,
      corpo,
      executar: async () => ({ resposta: await avaliarConferindo(true), status: 200 }),
    });
    switch (desfecho.tipo) {
      case "executou":
      case "replay":
        return desfecho.resposta;
      case "conflito":
        return conflito(input.mode, "idempotency_key_reused_with_different_body");
      case "em_curso":
        throw new Error("idempotency_in_progress: a call with this key is still running; retry shortly");
    }
  },
};
