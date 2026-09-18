---
impacto: nada_mudou
secao: corrigido
titulo: O funil passa a falar a moeda que a empresa escolheu, em vez de real sempre
---

Em Configurações › Organização dá para escolher a moeda da empresa, e o funil
ignorava a escolha em dois pontos. O total no topo de cada coluna do quadro
saía sempre com `R$` na frente — o número estava certo e o símbolo mentia. E
todo negócio criado pela tela "Novo negócio" nascia em real, mesmo numa empresa
que opera em peso ou dólar: o valor cadastrado passava a ser exibido na moeda
errada em toda tela que o mostra. Agora o total sai na moeda dos negócios da
coluna, e um negócio novo nasce na moeda que a empresa declarou.
**Nada muda para quem opera em real,** e nenhum negócio já cadastrado tem a
moeda alterada — o conserto vale para o que nasce daqui em diante. Um detalhe
visível: o total da coluna passa a mostrar os centavos, porque quem os escondia
era a mesma linha que escondia a moeda. Crédito: @cabindaferreira.
