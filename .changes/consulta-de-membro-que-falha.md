---
impacto: nada_mudou
secao: corrigido
titulo: Uma consulta de membro que não volta não acusa mais o responsável de estar fora da organização
---

Quando uma regra de automação ia atribuir um responsável a um negócio e a
consulta que confere se aquela pessoa é membro da organização não voltava — rede
fora, banco fora —, a regra terminava dizendo `user_not_in_org`, como se o
responsável escolhido tivesse saído da organização. O aviso mandava o operador
mexer justamente no que estava certo: quem ele havia escolhido para atender.

Agora a ação separa "não é membro" de "não deu para saber". O responsável que
realmente não é membro continua sendo recusado do mesmo jeito, com
`user_not_in_org`. Quando a consulta falha, a execução fica marcada como falha
com o código `membro_indeterminado` e o histórico da regra mostra a mensagem do
erro da consulta, apontando o problema onde ele está: na infraestrutura, não na
configuração da automação.
