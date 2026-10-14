---
impacto: capacidade_nova
secao: adicionado
titulo: Um token de API pode listar as ferramentas do MCP que está autorizado a chamar
---

Quem entrega um token a uma integração ou a um agente de terceiro agora pode restringi-lo a ferramentas específicas, acrescentando à lista de escopos do token um escopo `tool:<nome>` para cada ferramenta permitida (por exemplo `tool:crm_search_contacts`). Um token com pelo menos um escopo `tool:` só consegue chamar as ferramentas listadas: qualquer outra é recusada com `tool_not_allowed` antes de rodar, e a recusa fica registrada na auditoria como `mcp.tool_denied`, com o nome da ferramenta e o token, sem o conteúdo da chamada. O escopo `tool:` só estreita: não concede `mcp:write` nem o papel que a ferramenta já exige. Tokens sem nenhum escopo `tool:` continuam funcionando exatamente como antes, e o operador não precisa fazer nada. Crédito: @Alencaf.
