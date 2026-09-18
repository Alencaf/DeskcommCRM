---
impacto: capacidade_nova
secao: adicionado
titulo: Um acompanhamento pode esperar semanas sem morrer quando o cliente fala
---

Até agora não dava para montar um acompanhamento de retorno — "volte a falar com
esta cliente daqui a 28 dias" — dentro de um fluxo. Qualquer espera era
interrompida assim que o cliente mandasse qualquer mensagem: ou o acompanhamento
era cancelado, ou o relógio era cortado e a mensagem de retorno saía na hora
errada. Para uma cliente de manutenção, que conversa com o estúdio várias vezes
no mês, os dois desfechos estavam errados — e por isso essa regra só existia
escrita no prompt do agente, onde não dá para editar o prazo, ver quem está
esperando nem medir o resultado.

Agora a espera de um fluxo tem uma opção nova.
**A resposta do cliente não encurta mais a espera.**
Ela vale só para esperas de 24 horas ou mais (numa espera curta
seria um tiro no pé: prenderia alguém no meio da conversa) e o acompanhamento
fica visível na fila como "Aguardando a data do retorno", com a data em que volta
a falar. Enquanto ele dorme, o cliente continua podendo entrar em outros
acompanhamentos — antes, um só já ocupava a vaga dele por todo o período.

Quem pede silêncio continua sendo respeitado: um "pare de me mandar mensagem"
cancela também o retorno que estava dormindo.

Junto vem uma capacidade nova para os agentes de IA,
**"Iniciar um acompanhamento configurado"**,
que deixa o agente pôr o cliente num fluxo que você montou na tela. É o que tira do texto do agente as decisões de quando falar, o que dizer
e quando parar, deixando com ele só o que ele realmente sabe: que o atendimento
terminou e ainda há motivo para voltar.

Há um limite conhecido, e ele importa antes de você armar um retorno longo: se o
atendimento que originou o acompanhamento for encerrado ou substituído durante a
espera, o envio é cancelado. Isso já acontecia com o retorno agendado pelo agente
e não é novo — a diferença é que agora **você fica sabendo**: abre um aviso na
Central dizendo qual fluxo era e que o retorno não saiu. Nada a fazer na VPS além
de atualizar.
