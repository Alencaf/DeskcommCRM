---
impacto: capacidade_nova
secao: adicionado
titulo: Agentes externos podem criar ou completar um contato pelo telefone no MCP
---

O servidor MCP ganha a ferramenta `crm_upsert_contact`, que cria o contato ou completa o que já existe a partir do telefone em formato E.164, sem nunca inventar o nono dígito: um celular brasileiro sem ele é recusado, e um contato já gravado com 12 ou 13 dígitos é encontrado pelas duas grafias, em vez de nascer um segundo. Ao completar um contato existente, a ferramenta funde os campos personalizados e os metadados de origem em vez de substituí-los, acrescenta ao histórico de papéis sem reescrevê-lo, só preenche a pessoa vinculada quando está vazia, preserva o nome e a origem já gravados e recusa a etiqueta `cliente`, que é do sistema. Ela nunca grava consentimento, bloqueio nem as colunas de cliente, e recusa contatos pessoais e anonimizados. A chamada nasce em modo `simulate`: sem pedir `mode: "apply"` e informar o motivo, nada é gravado e a resposta só mostra a diferença. Repetir a mesma chamada, com ou sem `Idempotency-Key`, não duplica nada, e a auditoria registra a ferramenta, o modo e o motivo, sem o telefone nem os dados da pessoa. Não há mudança de esquema. Crédito: @Alencaf.
