/**
 * "Este agente está no ar?" — a pergunta com UMA resposta.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * A pergunta tinha TRÊS respostas, e as três discordavam sobre o mesmo agente:
 *
 *   1. `AgentStatusBadge.deriveAgentStatus` — o que a TELA escreve: arquivado,
 *      senão `published_version_id`, e `is_active` só para o `rag_bot` legado.
 *   2. `lib/agent-engine/agent/agent-config.ts` — o que o ENGINE executa:
 *      `join ai_agent_versions on v.id = a.published_version_id` + não
 *      arquivado + `v.status = 'published'`.
 *   3. `workers/ai-response-worker.ts` — o que o worker LEGADO executa:
 *      `.eq("is_active", true)`, e nada mais. Sem `archived_at`, sem
 *      `published_version_id`, sem `kind`.
 *
 * (1) e (2) concordam. (3) discorda dos dois — e é o que respondia ao cliente
 * sempre que a organização ficava sem nenhum agente publicado, porque a trava
 * que o segura (`skip("engine_owns_reply")`) é ORG-WIDE.
 *
 * Medido na VPS de produção em 2026-08-28: pausar o único `mcp_agent` publicado
 * desarma essa trava e devolve o atendimento ao worker legado — que continua
 * enxergando o agente recém-pausado, porque `pauseAgentAction` só desligava
 * `is_active` quando `kind !== "mcp_agent"`. O dono pausa, a tela escreve
 * **Rascunho**, e o agente responde no WhatsApp com o `system_prompt` do
 * CADASTRO (não o da versão), sem ferramentas, funis nem guardrails.
 *
 * ## Por que uma função pura, e não mais um filtro no SQL
 *
 * Um quarto `.eq()` espalhado seria a quarta régua. A doutrina DIRC manda
 * **C**alcular antes de duplicar, e aqui não nasce estado novo: é uma função
 * sobre colunas que as consultas JÁ trazem. Quem chama filtra no SQL o que é
 * barato e estreito (`organization_id`, `archived_at`) e decide aqui.
 *
 * ## O caso que NÃO é coberto, dito por escrito
 *
 * `rag_bot` ativo e nunca publicado responde — é o caminho que o worker legado
 * existe para servir, e a instalação que nunca publicou versão nenhuma depende
 * dele. Este arquivo o chama de `no_ar_legado`, um estado próprio: ele está no
 * ar, mas por outro motor e com outra config. A TELA ainda o rotula "Rascunho"
 * (ver `deriveAgentStatus`), e isso continua sendo uma divergência — menor que
 * a que este arquivo fecha, e deliberadamente fora deste conserto para não
 * mexer no rótulo de instalações antigas no mesmo PR. Quem for fechá-la começa
 * por aqui.
 */

/** As colunas de que a régua precisa — nada além. */
export interface FatosDoAgente {
  kind: string | null;
  is_active: boolean | null;
  published_version_id: string | null;
  archived_at: string | null;
}

export type EstadoDoAgente =
  /** Arquivado. Não atende por caminho nenhum. */
  | "arquivado"
  /** Tem versão publicada: o agent-engine é o dono da resposta. */
  | "no_ar"
  /**
   * `rag_bot` legado, ativo, sem versão publicada: quem o atende é
   * `workers/ai-response-worker.ts`, com a config da própria linha de
   * `ai_agents`. Está no ar — por outro motor.
   */
  | "no_ar_legado"
  /** Existe e não responde: nem versão publicada, nem `is_active` legado. */
  | "parado";

export function estadoDoAgente(a: FatosDoAgente): EstadoDoAgente {
  if (a.archived_at !== null) return "arquivado";
  if (a.published_version_id !== null) return "no_ar";
  // Sem versão publicada, só o legado tem para onde ir. Um `mcp_agent` sem
  // ponteiro não é executável por motor nenhum: a config dele (prompt, tools,
  // funis, guardrails) vive em `ai_agent_versions`, não na linha do agente.
  if (a.kind === "mcp_agent") return "parado";
  return a.is_active === true ? "no_ar_legado" : "parado";
}

/**
 * O agente responde a mensagem de cliente por ALGUM motor?
 *
 * Inclui o legado de propósito: a pergunta é "o cliente recebe resposta deste
 * agente?", e para quem nunca publicou a resposta é sim.
 */
export function agenteAtende(a: FatosDoAgente): boolean {
  const estado = estadoDoAgente(a);
  return estado === "no_ar" || estado === "no_ar_legado";
}

/**
 * Este agente é elegível para o worker LEGADO responder por ele?
 *
 * É a régua que faltava em `workers/ai-response-worker.ts`. `no_ar` fica de
 * fora porque, quando existe versão publicada, o dono da resposta é o
 * agent-engine e o worker já cede por `engine_owns_reply` — deixá-lo aqui
 * abriria a porta para os dois responderem a mesma mensagem, que é o defeito
 * que a issue #129 fechou.
 */
export function elegivelParaWorkerLegado(a: FatosDoAgente): boolean {
  return estadoDoAgente(a) === "no_ar_legado";
}
