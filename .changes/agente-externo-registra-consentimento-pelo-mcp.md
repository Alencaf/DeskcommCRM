---
impacto: capacidade_nova
secao: adicionado
titulo: Agentes externos podem registrar ou revogar o consentimento de um contato pelo MCP
---

O servidor MCP ganha a ferramenta `crm_record_consent`, que registra, por finalidade (`transactional`, `profiling` ou `marketing`), que um contato concedeu ou revogou o consentimento, com a base legal, a origem da prova e uma referência da evidência (nunca o texto da mensagem). Cada mudança grava a ação `lgpd.consent_changed` na auditoria, com o estado anterior e o novo daquela finalidade, e a revogação usa a mesma ferramenta e nunca apaga o registro. Esta versão não concede `marketing` por nenhuma origem, mas a revogação de `marketing` é sempre aceita e vale como opt-out que as automações respeitam. Lista importada ou vCard de parceiro nunca vale como consentimento da pessoa, e depois de uma revogação só uma prova vinda da pessoa concede de novo. A ferramenta grava só a coluna de consentimento, funde as finalidades em vez de substituí-las, não limpa o bloqueio do contato, recusa contatos pessoais, anonimizados, fundidos ou de outra organização, e exige papel de gerente com o escopo `mcp:write`. A chamada nasce em modo `simulate`: sem pedir `mode: "apply"` e informar o motivo, nada é gravado. Repetir o mesmo registro, com ou sem `Idempotency-Key`, não duplica nada. Não há mudança de esquema. Crédito: @Alencaf.
