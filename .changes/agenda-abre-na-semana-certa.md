---
impacto: nada_mudou
secao: corrigido
titulo: A Agenda abre na semana certa, mesmo à noite de sábado
---

No fim da noite de sábado, a Agenda piscava a semana seguinte antes de se
corrigir sozinha: o servidor calculava a semana pelo relógio dele, em UTC.

Agora ela usa o fuso configurado — o da pessoa em **Configurações › Perfil**,
o da empresa quando a pessoa não escolheu. Fuso inválido não derruba a tela.
