---
impacto: nada_mudou
secao: corrigido
titulo: O aviso de inicialização sobre a chave de IA deixa de afirmar que o agente vai ficar mudo
---
Numa instalação sem `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY` e `OPENROUTER_API_KEY` no `.env`, o log do app dizia a cada inicialização que "o agente vai pular toda resposta". Isso é falso quando a chave foi cadastrada pela tela, em IA › Credenciais — que é o caminho normal —, porque o agente usa essa chave antes de procurar a do `.env`. Quem lia o log ia atrás de um problema que não existia. O aviso agora diz só o que o app sabe na inicialização: que essas variáveis são a última opção, que a chave cadastrada pela tela continua valendo, e que sem chave em lugar nenhum as respostas ficam paradas até alguém cadastrar uma. Nada muda no funcionamento. Crédito: @gyanu2507.
