---
impacto: capacidade_nova
secao: adicionado
titulo: Agentes externos podem abrir e listar tarefas internas pelo MCP
---

O servidor MCP ganha duas ferramentas: `crm_create_task`, que abre uma tarefa interna de um contato ou de um negócio (inclusive a tarefa de revisão, que pede uma pessoa para conferir algo e carrega a evidência no corpo), e `crm_list_tasks`, que lista as tarefas da organização. A criação nasce em modo `simulate`: sem pedir `mode: "apply"` e informar o motivo, nada é gravado e a resposta só mostra o que aconteceria. Chamar de novo a mesma tarefa em aberto devolve a existente em vez de duplicá-la, e a `Idempotency-Key` repete a resposta da primeira chamada. A auditoria registra a ferramenta, o modo e o motivo, sem o texto da tarefa. Contatos pessoais e anonimizados são recusados, e a lista nunca traz tarefa de outra organização. Não há mudança de esquema. Crédito: @Alencaf.
