---
impacto: nada_mudou
secao: corrigido
titulo: A limpeza diária do banco volta a terminar, e os registros de conexão com o Google passam a ser apagados
---
Desde a v1.10.0, a limpeza que roda toda madrugada terminava em erro todos os dias, com `[data-retention] poda falhou` no log do app. A quarta etapa dela — apagar os registros de uso único que a conexão com o Google Agenda deixa a cada tentativa — chamava a função do banco com nomes de argumento diferentes dos que a função tinha, e o banco recusava. As três etapas anteriores (fila de tarefas, auditoria vencida e cópia da agenda) seguiam rodando; o que parava era o que vem depois: esses registros nunca eram apagados, a rodada ficava marcada como falha na auditoria, e a etapa seguinte da mesma rodada, que termina anonimizações de contato que ficaram pela metade, não chegava a rodar. Agora a função aceita os mesmos nomes das outras três etapas, e a limpeza vai até o fim. A atualização aplica a correção no banco sozinha, inclusive em instalação antiga; não há nada a fazer. Crédito: @gyanu2507.
