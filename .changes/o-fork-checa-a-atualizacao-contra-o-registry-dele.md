---
impacto: nada_mudou
secao: corrigido
titulo: Quem publica o sistema com a própria marca passa a checar a atualização no lugar certo
---

Se você mantém uma cópia própria do projeto e publica as imagens do sistema com
o seu próprio endereço, o comando de atualização olhava para o endereço do
projeto original — e não para o seu — quando a configuração do servidor não
dizia explicitamente qual imagem usar. Ele então comparava a versão instalada
com a de outra pessoa, e podia anunciar que havia atualização quando não havia,
ou o contrário.

O endereço agora é lido de um ponto único do próprio kit, o mesmo que o resto
da instalação usa. Quem opera com o projeto original não percebe diferença: o
endereço lido é exatamente o que já estava escrito antes.
