/**
 * Capacidades de CONSENTIMENTO — o registro de que o cliente concedeu ou
 * retirou a autorização para um tipo de contato.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente — `rotulo`,
 * `explicacao` e `oQueToca`. O texto que vai ao MODELO é a `description` do
 * HANDLER (`lib/mcp/tools/consentimento.ts`).
 */
import { declararTools } from "./tipos";

export const TOOLS_CONSENTIMENTO = declararTools([
  {
    name: "crm_record_consent",
    category: "write",
    rotulo: "Registrar ou retirar o consentimento do cliente",
    explicacao:
      "Anota que o cliente concedeu ou retirou a autorização para um tipo de contato, com a base legal e a prova, e deixa o registro na auditoria. É uma ação de gente da equipe, nunca do assistente.",
    oQueToca: "Privacidade do cliente",
    risco: "critico",
    pacotes: ["organizar"],
    apenasHumano: true,
  },
]);
