---
impacto: nada_mudou
secao: corrigido
titulo: A catraca do espanhol passa a cobrar a chave que vem de tabela de outro módulo
---
O teste que garante que toda frase de tela tem espanhol resolvia a chave quando a tabela de rótulos era declarada no MESMO arquivo. Quando a tabela morava noutro módulo — o caso de `TRIGGER_LABELS` e `ACTION_LABELS` (rótulos do construtor de fluxo), `SEVERITY_LABEL` (inbox da IA) e `ROTULO_DO_PAPEL` (convite de equipe) —, a chamada passava batida e ninguém era avisado. Agora a catraca atravessa o `import` e cobra cada valor possível da tabela no dicionário, nas áreas de produto, `lib/` inclusive.

Medido na `main` de 18/08/2026: 103 chamadas resolvidas, 196 valores exigidos do dicionário e 9 valores faltando, em 3 arquivos. Esses 9 ficam numa lista de dívida congelada dentro do próprio teste: a lista só encolhe, e traduzir um deles deixa o teste vermelho pedindo a remoção da linha. O que o `t()` recebe de dado de runtime — identificador solto, `algo.campo` — segue fora do alcance de propósito: cobrar isso é o passo seguinte da mesma issue. Nada muda na tela de quem opera.
