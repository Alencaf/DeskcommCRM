---
impacto: nada_mudou
secao: corrigido
titulo: A imagem do módulo de telefonia voltou a construir
---

A imagem `deskcomm-voice-agent`, que o módulo opcional de telefonia usa, não
chegava a ser criada: a receita dela não copiava o diretório `patches/`, e o
`pnpm install` morria antes de instalar qualquer dependência.

Nada muda para quem já instalou — a imagem nunca existiu, então ninguém a estava
baixando. O que isto destrava é a publicação de versões: o passo final da
publicação confere se as quatro imagens do produto estão ao alcance de qualquer
VPS, e ele não fechava enquanto uma delas não nascia.
