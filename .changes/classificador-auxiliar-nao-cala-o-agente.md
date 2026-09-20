---
impacto: nada_mudou
secao: corrigido
titulo: Uma falha nos classificadores auxiliares não cala mais o agente
---

Antes de responder, o agente consulta dois auxiliares baratos: um chuta em que
etapa do funil a conversa está, e o outro olha se a mensagem do cliente é uma
tentativa de manipular o assistente. Os dois são conselheiros — quem decide é o
modelo do agente, e nenhum dos dois nunca teve poder de barrar um atendimento.

Mesmo assim, se um deles falhasse, o atendimento inteiro parava: o cliente ficava
sem resposta. E o caso comum não era o provedor cair — era o modelo desses dois
pontos, em **Configurações › Provedores de IA**, apontar para algo que não existe
mais ou para uma chave revogada. O modelo do agente estava de pé, a conversa não
andava, e nada na tela explicava por quê.

Agora a falha do conselheiro é só a falha do conselheiro: o agente responde do
mesmo jeito, apenas sem o palpite de etapa daquele turno. A falha não some — a
chamada frustrada fica registrada em **Uso de IA**, como qualquer outra.

Uma coisa segue interrompendo o atendimento de propósito: o teto de gasto do mês.
Quando é ele que barra a chamada, a conversa continua sendo passada para uma
pessoa, que é o que já acontecia.

Trabalho de @betoarts, recortado do #714.
