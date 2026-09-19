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

## As três falhas que eu encontrei, em ordem

| # | sintoma | o que era |
|---|---|---|
| 1 | `supabase_kong_… Exited (127)` | o gateway não sobe; sem ele a API de `54321` não responde e o app não fala com o banco |
| 2 | `supabase_storage_… container is not ready: unhealthy` — e o CLI **derruba tudo** | um serviço que o e2e desta spec nem usa impede o conjunto inteiro |
| 3 | sobe `realtime/inbucket/auth/kong/db` mas **sem `rest`** | sem PostgREST não há API de dados; o app carrega e não lê nada |

Contorno para (1) e (2): suba só o que a sua spec precisa.

```bash
supabase start -x storage-api,imgproxy,studio,edge-runtime,logflare,vector,supavisor
```

> Antes de culpar a receita: `docker info` responde na hora enquanto
> `docker ps` pode levar minutos — se o daemon acabou de subir, espere ele
> estabilizar. `open -a Docker` e um laço de `until docker info >/dev/null`.

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
