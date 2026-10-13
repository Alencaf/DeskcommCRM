/**
 * De onde uma `crm_tasks` nasceu — vocabulário ABERTO (sem CHECK no banco,
 * CLAUDE.md doutrina de Migrations). `null`/ausente = criada à mão.
 */
export type TaskSourceKind = "promised_proposal" | "promised_followup" | "mcp_tool";

export const TASK_SOURCE_LABELS: Record<TaskSourceKind, string> = {
  promised_proposal: "Promessa de proposta detectada pelo assistente",
  promised_followup: "Compromisso detectado pelo assistente",
  mcp_tool: "Criada por um agente externo pelo MCP",
};
