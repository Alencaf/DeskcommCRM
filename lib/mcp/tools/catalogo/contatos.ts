/**
 * Capacidades de CONTATO — criar ou completar a ficha de quem fala com a empresa.
 *
 * ESTE ARQUIVO FALA COM O HUMANO que configura o agente — `rotulo`,
 * `explicacao` e `oQueToca`. O texto que vai ao MODELO é a `description` do
 * HANDLER (`lib/mcp/tools/upsert-contato.ts`).
 */
import { declararTools } from "./tipos";

export const TOOLS_CONTATOS = declararTools([
  {
    name: "crm_upsert_contact",
    category: "write",
    rotulo: "Criar ou completar um contato pelo telefone",
    explicacao:
      "Cria o cliente a partir do telefone ou completa a ficha de quem já existe, sem trocar o que já está preenchido e sem inventar números. Mexe em dados pessoais, por isso você liga esta capacidade uma a uma.",
    oQueToca: "Fichas de clientes",
    risco: "critico",
    pacotes: ["organizar"],
  },
]);
