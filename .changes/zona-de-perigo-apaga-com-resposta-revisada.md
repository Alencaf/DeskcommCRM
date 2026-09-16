---
impacto: nada_mudou
secao: corrigido
titulo: A Zona de perigo volta a apagar os dados de atendimento em organização que já enviou resposta revisada
---
Em Configurações › Organização › Zona de perigo, apagar os dados de atendimento falhava em toda organização que já tinha enviado pelo menos uma resposta revisada — o modo em que uma pessoa aprova o texto da IA antes de ele sair. A tela mostrava erro e nada era apagado: o banco recusava apagar a mensagem enviada porque a resposta revisada ainda apontava para ela. Agora a resposta revisada apenas deixa de apontar para a mensagem apagada, e a limpeza segue até o fim. Apagar uma mensagem avulsa não leva a resposta revisada junto. A atualização aplica a correção no banco sozinha, inclusive em instalação antiga, e só mexe nessa regra uma vez; não há nada a fazer. Crédito: @gyanu2507.
