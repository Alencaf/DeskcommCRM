# Handoff — o caso 131 do `filtro-por-marcador-pela-tela` só fica vermelho no PR #963

> Doc VIVO. Toda sessão que retomar isto lê daqui primeiro. Escrito em 2026-09-19,
> quando o terminal que coordenava a investigação morreu (`app_reopened`) com o
> resultado já medido e não entregue.

## O defeito, em uma linha

`tests/e2e/filtro-por-marcador-pela-tela.spec.ts:131` (Inbox #1206) estoura os 300 s no
clique da opção de marcador. **A spec não mudou**: ela passa na base e na main, e só
falha no PR #963 (`saraivabr:saraiva/social-native`).

## O que está MEDIDO (com a régua junto)

Só o **caso 131** compara entre os três SHAs — o total da parte 5 muda por SHA (50 / 53 /
52+1) e não é régua.

| SHA | run / job | caso 131 |
|---|---|---|
| base `92390306e` | 35452412529 / job 105921757650 | ✓ **11.1 s** |
| main `2b58c47a9` | 35462322078 / job 105948275435 | ✓ **8.1 s** |
| PR `63361d78c` | 35465018832 / job 105955670039 | ✘ **300 s** (1 failed / 52 passed) |

Verde **com relógio** nos dois primeiros — não é skip.

E a spec e o helper são idênticos nos três:

```bash
git diff 92390306e 63361d78c -- tests/e2e/filtro-por-marcador-pela-tela.spec.ts tests/e2e/qa-l12-comum.ts   # vazio
```

**Conclusão que isso sustenta:** a causa é o que a branch ADICIONA. Não é infra, não é o
teste, não é a base.

## A cronologia exata (trace do run vermelho)

Âncora do trace: `wallTime 1789847185632 ↔ monotonicTime 114891.375`.

| mono | o que aconteceu |
|---|---|
| 122159-122161 | `/contacts`, `/conversations?limit=50`, `/contact-tags` → invalidação do PATCH da tag, **querida** |
| 122164 | clique que ABRE o seletor |
| 122297 | começa a esperar a opção `vip-…` |
| **122506** | `locator resolved to <div role="option" …>` — apareceu **209 ms tarde** |
| 122510-122514 | `captura()` = `page.screenshot({ fullPage: true })` |
| **122591** | clique começa → `waiting for …` e **nunca resolve**, 300 s |

O call log tem **uma linha só**. O Playwright não chegou a tentar clicar: não é elemento
coberto, nem instável, nem fora da viewport — é elemento **ausente da árvore**. A
screenshot da falha confirma o estado final: seletor **fechado** ("Todas as tags"), sem
overlay. Dentro do caso são ~7 s até ali, contra 8,1 s na main: **carga de máquina não
explica**.

### O dado que mais estreita a busca

**Zero chamadas de API entre mono 122200 e 123200** — a janela em que a opção sai do DOM.
157 chamadas no caso inteiro, **nenhuma** com status >= 400. Logo:

1. nada veio do servidor para trocar os dados naquele instante;
2. a árvore de `<Providers>` **não** remontou (remontagem refaria as queries, e não há rede);
3. o que fechou o menu é efeito **puramente de cliente**.

E entre o locator resolver e o clique roda **uma coisa só**: o screenshot `fullPage`, que
redimensiona a viewport para a **altura do documento**.

## Candidatos, e o estado de cada um

| candidato | veredito | artefato |
|---|---|---|
| refetch de 30 s do `InboxFilters` | **morto** | experimento no run 35465018832 falhou igual; e `InboxFilters.tsx` não muda na branch |
| `FloatingInbox.tsx` (+359, novo) | **morto p/ este caso** | `components/inbox/FloatingInbox.tsx:40` → `if (rota?.startsWith("/app/inbox")) return null;` |
| `ChannelLogo.tsx` (+27, novo) | **morto** | `<span>` com ícone; zero rede, zero efeito |
| embed `social_platform:metadata->>…` em `_handler.ts:95` | **fraco** | coluna existe (`baseline.sql` → `"metadata" "jsonb" NOT NULL`); `/api/v1/conversations` respondeu **200 seis vezes** no run vermelho |
| laço de `draft-reply` (72 chamadas, 1 a cada ~4,1 s, não para) | **não é da branch** | `ReplyReviewPanel.tsx` tem `refetchInterval: 4000` e **não muda** no diff |
| `activeOrg` piscando → `AuthProvider.tsx:89` remonta tudo | **enfraquecido** | remontagem exigiria rede na janela, e não há |
| **`LeadEnrichment` (+131, novo) deixa a página mais ALTA → o resize do `fullPage` é maior** | **vivo, não medido** | visível na screenshot como "Sobre a empresa"; é o único que explica base-verde/PR-vermelho com spec idêntica |

## O próximo passo (instrumentação, já escrita)

Commit de experimento na branch, **para reverter depois**. Mede o mecanismo, não um bit:

- `MutationObserver` em `documentElement` grava cada entrada/saída de `[role=listbox]` e
  `[role=option]` com `performance.now()`, contagem, **`scrollHeight` e `innerHeight`**,
  mais `resize` e `focusin`. Observer **em vez de** amostrar a cada 100 ms: a janela é de
  85 ms e a amostra erraria.
- `olha()` **antes e depois** do `captura()` — é o que separa "o screenshot é o gatilho"
  de "a opção já tinha saído antes dele".
- `page.on('console' | 'response' >= 400 | 'requestfailed')`.
- clique com `timeout: 15_000` no lugar de 300 s: economiza ~285 s de CI, e o valor está
  no filme.

## Armadilhas de instrumento pagas nesta investigação

1. **`frame-snapshot` do trace é INCREMENTAL.** Presença é dado; **ausência não é**. Um
   deles marca o menu como fechado num instante em que ele comprovadamente estava aberto.
   Uma tabela inteira de "a lista oscila 2→1→0" foi montada com isso e descartada.
2. **O trace guardou `content.text` com 0 bytes** em todas as respostas — não dá para
   afirmar o que voltou no corpo, só o status.
3. **Run verde não sobe artifact**, então não há trace do verde para comparar.
4. **Sonda cega dá zero plausível**: `awk '/CREATE TABLE (public\.)?channel_sessions/'` deu
   zero porque o baseline escreve `CREATE TABLE IF NOT EXISTS "public"."channel_sessions"`.
   O controle positivo (contar as linhas que o `awk` devolve) acusou antes de o zero virar
   afirmação.

## Higiene desta branch

`cb/963` é cópia local de `refs/pull/963/head` — de um **fork**. O push vai para
`https://github.com/saraivabr/DeskcommCRM.git HEAD:saraiva/social-native`, nunca para
`origin` (lá ele cria uma branch nova e o trabalho não chega ao PR). Um experimento
anterior já foi revertido (`eb86b07d0`); `InboxFilters.tsx` bate byte a byte com a base.

---

# Continuação — o #963 depois do diagnóstico (2026-09-20)

> Escrito porque o terminal que coordenava morreu **duas vezes** com resultado
> não entregue. Se você está retomando isto, leia daqui.

## O caso 131 está resolvido, e a hipótese que o resolveu não era a certa

A ablação do `captura()` rodou: **A e B verdes, diferença ZERO**. O
`page.screenshot({fullPage:true})` **não** era o gatilho — a hipótese (5) morreu.
O que explicava era um defeito de produto determinístico, achado no caminho:

**O `pb-20` reservava o rodapé em TODA rota, e no Inbox o atalho que ele reserva
nem monta.** O grid de lá descontava 48px, o `<main>` gastava 104px: 56px de
rolagem morta, com o campo de envio abaixo da dobra, em toda instalação. A guarda
de rota tirava o aside e **deixava o padding**.

Hipótese que morre apontando a causa certa vale mais que hipótese que sobrevive
sem apontar nada.

## O conserto NÃO foi o que eu tinha escrito primeiro

A primeira versão criava uma fonte única para a regra de **rota**
(`lib/layout/atalho-de-mensagens.ts`). Ela foi **descartada**: a main já tinha
`lib/ui/rodape-ocupado.tsx`, uma fonte única para a **ocupação** — e ocupação é a
grandeza certa, rota era proxy dela. Duas fontes para "quanto o rodapé ocupa"
seria reproduzir a doença ao curá-la.

O conserto vigente: o `FloatingInbox` declara `ATALHO_DE_MENSAGENS` e chama
`usePecaDoRodape` (molde: `components/voice/ActiveCallPanel.tsx`). O hook
desregistra ao desmontar — quem tira o atalho tira a reserva no MESMO ato.

**E havia um segundo defeito, que só aparece depois do primeiro ser consertado:**
o `calc` do Inbox continuava certo só enquanto nenhuma peça se registra. Com o
painel de chamada de voz aberto (80px), os mesmos 56px voltam — agora
intermitentes. O grid passou a espelhar o que a casca aplica.

## O que o CI pegou e eu não

**A cascata de LGPD quebrou por minha causa.** `create or replace` troca o corpo
INTEIRO: o apêndice desta branch redefinia `fn_lgpd_cascade_redact_contact` a
partir de uma versão anterior e, entrando depois da main, apagou em silêncio o
passo `sales`. Anonimizar devolveria SUCESSO com o texto da comanda legível.

Eu tinha somado as duas tabelas na **lista** do invariante e achei resolvido. A
lista é declaração; o corpo da função é o que executa.

**A conferência que faltou, e que agora é obrigatória a cada merge da main:**

```bash
u=$(grep -n 'CREATE OR REPLACE FUNCTION "public"."fn_lgpd_cascade_redact_contact"' <baseline> | cut -d: -f1 | tail -1)
awk -v i="$u" 'NR>=i' <baseline> | awk '/^\$\$;/{exit} {print}' \
  | grep -oE "v_counts \|\| jsonb_build_object\('[a-z_]+'" | sort -u
```

Compare main × merge: **"só na main" tem de ser vazio**.

## Numeração: ela envelhece entre medir e aplicar

0359-0362 → **0368-0371**, carimbos a partir de `20260921030000`. O teto mudou
**três vezes em poucas horas** (0365 → 0366 → 0367). Quem mesclar, re-derive.

**Armadilha que um `sed` teria estragado:** "0359" também é a cascata da comanda,
que é da main. Troque por **par completo** (`carimbo_NNNN_slug`) e, nas menções
soltas, uma a uma por contexto. No MANIFEST o carimbo e o nome estão em colunas
separadas — lá o discriminador é o slug.

## O que está ABERTO

**Duplicação de nó.** Cinco testids de telas diferentes resolvem a dois
elementos (`tela-agenda`, `flow-builder-shell`, `abrir-novo-tipo`,
`opcao-modo-manual`, `opcao-modo-round_robin`) — é a **página inteira** duas
vezes no DOM. O diff desta branch no `AppShell` é de DUAS linhas (o import e
`<FloatingInbox />`), o PR não toca o layout, e nenhum desses testids existe
dentro de `components/inbox/`. A causa está na MONTAGEM.

Há um **commit de experimento** com o `<FloatingInbox />` desligado, para
decidir por diferença. **Reverta-o junto com a ablação do caso 131** quando o
resto fechar.

Explicação que eu tentei e que **não se sustenta**: "o painel se esconde com
`hidden` e mantém `ChatThread`/`Composer` (`dynamic`) montados". A `DockList` já
é condicional a `open`, e o `DockConversation` só monta com conversa
selecionada. Mecanismo plausível não é mecanismo medido.

## Armadilhas de instrumento pagas nesta segunda metade

5. **`--log-failed` traz o job inteiro.** Um `grep` por `spec.ts:N` casa toda
   MENÇÃO e devolveu **200 casos** como se fossem falhas. A âncora que separa é
   `✘ +[0-9]+ \[chromium\]`.
6. **`✘` sai em run VERDE.** `degradacao-silenciosa.spec.ts:117` é catraca de
   lacuna conhecida (`test.fail`) e o Playwright usa o mesmo símbolo. A
   autoridade é o rodapé `N failed`; o símbolo só lista candidatos.
7. **`grep -A N` pega a PRIMEIRA ocorrência**, não a que você procura. Abri o
   erro de `tela-agenda` achando que era de `opcao-modo-round_robin`.
8. **Regex não fecha parêntese aninhado.** Um extrator meu truncou
   `max(var(),var())` no primeiro `)` e reprovou o arquivo que eu tinha acabado
   de consertar. Conte parênteses.
