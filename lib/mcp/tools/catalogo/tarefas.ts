/**
 * Capacidades de TAREFA INTERNA — o lembrete de trabalho que a equipe vê na
 * tela de Tarefas e, quando há negócio, na linha do tempo dele.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente — `rotulo`,
 * `explicacao` e `oQueToca`. O texto que vai ao MODELO é a `description` do
 * HANDLER (`lib/mcp/tools/tarefas.ts`).
 */
import { declararTools } from "./tipos";

export const TOOLS_TAREFAS = declararTools([
  {
    name: "crm_list_tasks",
    category: "read",
    rotulo: "Ver as tarefas da equipe",
    explicacao:
      "Mostra as tarefas internas abertas ou concluídas da empresa, em ordem de prazo, para saber o que já foi combinado.",
    oQueToca: "Tarefas da equipe",
    risco: "seguro",
    pacotes: ["organizar"],
  },
  {
    name: "crm_create_task",
    category: "write",
    rotulo: "Criar tarefa para a equipe",
    explicacao:
      "Cria um lembrete de trabalho para a equipe sobre um cliente ou negócio, inclusive o pedido de uma pessoa conferir algo. Nunca envia mensagem ao cliente.",
    oQueToca: "Tarefas da equipe",
    risco: "atencao",
    pacotes: ["organizar"],
  },
]);
