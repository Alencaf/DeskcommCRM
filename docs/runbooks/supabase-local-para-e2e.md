# Subir Supabase local para rodar e2e

> Medido em 19/09/2026, numa máquina limpa. Três tentativas, três falhas
> diferentes — **nenhuma delas ligada ao teste que eu queria rodar**. Este
> arquivo existe para que a próxima pessoa gaste minutos onde eu gastei 33.

## A receita, e ela não é `supabase start`

O caminho óbvio **não funciona**: a cadeia de `supabase/migrations/` não sobe
do zero — ela usa objetos criados por migrations posteriores, e por isso
`install.sh`, `test:db` e o e2e aplicam o `baseline.sql`, nunca a cadeia. O `supabase start` tenta aplicá-la e
morre no meio:

```
Skipping migration MANIFEST.md... (file name must match pattern "<timestamp>_name.sql")
...
alter table public.contacts
  add column if not exists force_human boolean not null default false
Try rerunning the command with --debug to troubleshoot the error.
```

Quem monta banco local aplica o **`baseline.sql`**, que é o mesmo que o
`install.sh` do kit aplica. A receita canônica **já existe e está no CI** —
copie de lá em vez de improvisar:

```bash
grep -n -A6 "Subir Supabase local" .github/workflows/e2e.yml
```

Em resumo, o que o CI faz:

```bash
mv supabase/migrations /tmp/migrations-off      # a cadeia sai do caminho
mkdir -p supabase/migrations
supabase start
# extensões que o baseline exige (uuid-ossp, pgcrypto, vector, citext, pg_trgm)
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -q -f supabase/baseline.sql
rm -rf supabase/migrations && mv /tmp/migrations-off supabase/migrations
```

## ⚠️ A janela em que isso parece sabotagem

Entre o `mv` e o `mv` de volta, `supabase/migrations/` fica **vazio** e o
`MANIFEST.md` **não existe**. Quem olhar `git status` nesse intervalo vê
**287 arquivos versionados apagados** e lê como estrago.

Foi o que aconteceu em 19/09: um segundo terminal viu o estado no meio, leu como
sabotagem e rodou `git restore supabase/migrations/` às cegas. Nada se perdeu
(eram arquivos versionados), mas o susto é real e o reflexo é o certo — **num
diretório não versionado, o mesmo reflexo apagaria trabalho de verdade**.

**Deixe um sentinela enquanto o diretório estiver movido:**

```bash
mv supabase/migrations /tmp/migrations-off
mkdir -p supabase/migrations
echo "movida por $0 (pid $$) para o supabase start; restaurada no fim" \
  > "supabase/migrations/.MOVIDA-PELO-SCRIPT-$$"
```

Custa uma linha e transforma "287 arquivos sumiram" em uma frase que se lê em
dois segundos.

## As três falhas que eu encontrei — e o padrão é mais útil que a lista

| # | serviço que caiu | mensagem |
|---|---|---|
| 1 | `kong` | `supabase_kong_… Exited (127)` |
| 2 | `storage` | `supabase_storage_… container is not ready: unhealthy` |
| 3 | `realtime` | `supabase_realtime_… container is not ready: unhealthy` |

**O padrão, que vale mais que os três nomes: qualquer serviço que não fique
saudável derruba o conjunto inteiro.** Nas três tentativas o CLI respondeu
`Stopping containers...` e voltou ao zero — inclusive quando o serviço que caiu
não tinha relação nenhuma com o que eu ia testar.

### ⚠️ O contorno abaixo NÃO está provado

O caminho óbvio é pular os serviços que você não usa:

```bash
supabase start -x storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor
```

**Medido: não resolveu.** Foi exatamente a minha terceira tentativa, e ela morreu
em `realtime unhealthy` — um serviço que o `-x` acima não exclui. Os containers
chegaram a subir (`realtime inbucket auth kong db`, **sem o `rest`**) e o CLI
derrubou tudo em seguida.

Fica registrado como **hipótese não confirmada**, e não como receita: excluir o
serviço que caiu na SUA rodada pode funcionar, mas na minha o serviço que caiu
mudou a cada tentativa. **Não dá para afirmar, com o que eu medi, que existe um
conjunto de exclusões que faz o ambiente subir nesta máquina.**

Se você conseguir subir, corrija este bloco com o comando que funcionou — é a
informação que falta aqui.

## Antes de subir, pergunte se precisa

Medido no mesmo dia, e é o conselho que eu daria a mim mesmo às 19h: o
ambiente local compra **uma observação** (o trace, o estado da tela no instante).
Se a pergunta que você tem já é respondida pelos **artefatos do CI** —
`playwright-report-*` traz `error-context.md` e a screenshot do instante da
falha —, baixe o artefato em vez de montar ambiente:

```bash
gh api repos/<owner>/<repo>/actions/runs/<run>/artifacts --jq '.artifacts[] | "\(.id) \(.name)"'
gh api repos/<owner>/<repo>/actions/artifacts/<id>/zip > a.zip && unzip -q a.zip
```

O log dá o **sintoma** ("o clique falhou"); o artefato dá o **estado** ("o menu
está fechado"). Só o segundo tem causa investigável.
