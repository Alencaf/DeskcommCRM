---
impacto: nada_mudou
secao: corrigido
titulo: Quando o Google recusa um compromisso, o detalhe dele passa a mostrar o motivo
---
Desde a v1.17.0, quando o Google Agenda recusava a publicação de um compromisso, o detalhe do compromisso e o registro da sincronização mostravam só "Google HTTP 400" (ou outro número), sem dizer o que o Google tinha recusado — e sem o motivo não há como saber o que consertar. Agora aparece também a mensagem de erro que o próprio Google devolve, em inglês, por exemplo "Google HTTP 400: The specified time range is empty.". Só essa mensagem é guardada, cortada em 180 caracteres; o restante da resposta do Google continua fora. Crédito: @gyanu2507.
