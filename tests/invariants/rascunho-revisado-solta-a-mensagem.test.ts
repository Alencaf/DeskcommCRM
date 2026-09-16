/**
 * A RESPOSTA REVISADA ENVIADA NÃO TRAVA A ZONA DE PERIGO (issue #949, PR #976).
 *
 * `ai_reply_drafts.message_id` nasceu na 0227 sem `on delete` (NO ACTION). A
 * Zona de perigo (`lib/settings/apagar-dados-operacionais.ts`) apaga `messages`
 * PRIMEIRO, e o rascunho só cairia depois, na cascata de `conversations`. Numa
 * organização que já enviou uma resposta revisada, o primeiro DELETE tomava
 * 23503 e a ação parava em `falhou_em: messages`. A 0266 troca a FK para SET NULL.
 *
 * O que este arquivo cobra, no banco:
 *   - o CONTROLE: com a FK da 0227 reconstruída, o DELETE é recusado — sem ele,
 *     um verde abaixo não distingue "o conserto funciona" de "o cenário não
 *     reproduz o defeito";
 *   - a instalação nova solta a mensagem, e o rascunho continua existindo;
 *   - o caminho do `update.sh`: o bloco do baseline, aplicado sobre um clone da
 *     0227, troca a FK — é o único caminho que chega a quem já instalou;
 *   - uma passada já convergida do bloco não pede trava em `messages` (o
 *     `update.sh` roda com o app atendendo).
 *
 * As linhas nascem com `session_replication_role = replica`, que desliga as
 * FKs das OUTRAS colunas e os gatilhos de `messages` só durante o insert: o que
 * se mede é a FK de `message_id`, e montar organização, conversa, agente e
 * versão reais aqui mediria o fixture. Elas são GRAVADAS numa transação própria,
 * e o DELETE roda em outra, desfeita, com as FKs ligadas. Na mesma transação não
 * serve: o Postgres confere TODAS as FKs de uma linha que a própria transação
 * inseriu quando o SET NULL a atualiza (medido — `ai_reply_drafts_organization_id_fkey`
 * reprovava), e o teste mediria o atalho do fixture em vez da FK.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});

afterAll(() => pool.end());

const ROTULO = "-- ---- rascunho revisado solta a mensagem (migration 0266) ----";

function blocoDoBaseline(): string {
  const sql = readFileSync("supabase/baseline.sql", "utf8");
  const inicio = sql.indexOf(ROTULO);
  if (inicio < 0) throw new Error("o bloco da 0266 não está no baseline — instrumento cego");
  const fim = sql.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim < 0) throw new Error("não achei o fim do bloco da 0266 no baseline");
  return sql.slice(inicio, fim);
}

async function emTransacaoDesfeita<T>(corpo: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    return await corpo(c);
  } finally {
    await c.query("rollback");
    c.release();
  }
}

/** A ação de exclusão de cada FK de `message_id`: `a` = NO ACTION, `n` = SET NULL. */
async function acoesDaFkDeMessageId(c: pg.PoolClient): Promise<string[]> {
  const { rows } = await c.query<{ acao: string }>(`
    select c.confdeltype::text as acao
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.conrelid = 'public.ai_reply_drafts'::regclass
       and c.contype = 'f'
       and a.attname = 'message_id'`);
  return rows.map((r) => r.acao).sort();
}

/** O clone que instalou entre a 0227 e a 0266. */
async function voltarParaA0227(c: pg.PoolClient): Promise<void> {
  await c.query(`
    do $$
    declare v_nome text;
    begin
      for v_nome in
        select c.conname
          from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.conrelid = 'public.ai_reply_drafts'::regclass
           and c.contype = 'f'
           and a.attname = 'message_id'
      loop
        execute format('alter table public.ai_reply_drafts drop constraint %I', v_nome);
      end loop;
    end $$`);
  await c.query(`
    alter table public.ai_reply_drafts
      add constraint ai_reply_drafts_message_id_fkey
      foreign key (message_id) references public.messages(id)`);
  expect(await acoesDaFkDeMessageId(c), "o controle não reconstruiu a FK da 0227").toEqual(["a"]);
}

/**
 * Grava uma mensagem enviada e a resposta revisada que aponta para ela, roda
 * `corpo` numa transação desfeita e apaga as duas linhas no fim.
 */
async function comRespostaRevisadaEnviada(
  corpo: (c: pg.PoolClient, linhas: { organizacao: string; rascunho: string }) => Promise<void>,
): Promise<void> {
  const organizacao = randomUUID();
  const mensagem = randomUUID();
  const rascunho = randomUUID();
  const semFks = async (sql: string, params: unknown[]) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local session_replication_role = replica");
      await c.query(sql, params);
      await c.query("commit");
    } catch (erro) {
      await c.query("rollback");
      throw erro;
    } finally {
      c.release();
    }
  };
  await semFks(
    `insert into public.messages
       (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
     values ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'text', 'outbound', 'resposta revisada')`,
    [mensagem, organizacao],
  );
  try {
    await semFks(
      `insert into public.ai_reply_drafts
         (id, organization_id, conversation_id, contact_id, agent_id, agent_version_id,
          channel_session_id, service_boundary, context_revision, operation_revision,
          status, approved_body, message_id)
       values ($1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          gen_random_uuid(), '{}'::jsonb, 1, 1, 'sent', 'resposta revisada', $3)`,
      [rascunho, organizacao, mensagem],
    );
    await emTransacaoDesfeita((c) => corpo(c, { organizacao, rascunho }));
  } finally {
    await semFks("delete from public.ai_reply_drafts where id = $1", [rascunho]);
    await semFks("delete from public.messages where id = $1", [mensagem]);
  }
}

/** O primeiro passo da Zona de perigo, com o mesmo filtro. */
function apagarMensagensDaOrganizacao(c: pg.PoolClient, organizacao: string) {
  return c.query("delete from public.messages where organization_id = $1", [organizacao]);
}

describe("resposta revisada enviada × Zona de perigo (0266)", () => {
  it("controle: com a FK da 0227, apagar as mensagens é recusado com 23503", async () => {
    await comRespostaRevisadaEnviada(async (c, { organizacao }) => {
      await voltarParaA0227(c);
      await expect(apagarMensagensDaOrganizacao(c, organizacao)).rejects.toMatchObject({
        code: "23503",
      });
    });
  });

  it("instalação: a FK de message_id é SET NULL, e apagar a mensagem mantém o rascunho", async () => {
    await comRespostaRevisadaEnviada(async (c, { organizacao, rascunho }) => {
      expect(await acoesDaFkDeMessageId(c)).toEqual(["n"]);
      const apagadas = await apagarMensagensDaOrganizacao(c, organizacao);
      expect(apagadas.rowCount).toBe(1);
      const { rows } = await c.query<{ message_id: string | null }>(
        "select message_id from public.ai_reply_drafts where id = $1",
        [rascunho],
      );
      expect(rows, "o rascunho foi junto com a mensagem — isso seria CASCADE").toHaveLength(1);
      expect(rows[0]?.message_id).toBeNull();
    });
  });

  it("update.sh num clone da 0227: o bloco do baseline troca a FK, e a Zona de perigo passa", async () => {
    await comRespostaRevisadaEnviada(async (c, { organizacao }) => {
      await voltarParaA0227(c);
      await c.query(blocoDoBaseline());
      expect(await acoesDaFkDeMessageId(c)).toEqual(["n"]);
      const apagadas = await apagarMensagensDaOrganizacao(c, organizacao);
      expect(apagadas.rowCount).toBe(1);
    });
  });

  it("clone sem FK nenhuma em message_id: o bloco a cria em SET NULL", async () => {
    await emTransacaoDesfeita(async (c) => {
      await voltarParaA0227(c);
      await c.query("alter table public.ai_reply_drafts drop constraint ai_reply_drafts_message_id_fkey");
      expect(await acoesDaFkDeMessageId(c)).toEqual([]);
      await c.query(blocoDoBaseline());
      expect(await acoesDaFkDeMessageId(c)).toEqual(["n"]);
    });
  });

  it("passada já convergida não pede trava forte em messages nem em ai_reply_drafts", async () => {
    await emTransacaoDesfeita(async (c) => {
      expect(await acoesDaFkDeMessageId(c)).toEqual(["n"]);
      await c.query(blocoDoBaseline());
      const { rows } = await c.query<{ trava: string }>(`
        select relation::regclass::text || ':' || mode as trava
          from pg_locks
         where pid = pg_backend_pid()
           and locktype = 'relation'
           and relation in ('public.messages'::regclass, 'public.ai_reply_drafts'::regclass)
           and mode in ('ShareRowExclusiveLock', 'AccessExclusiveLock')`);
      expect(rows.map((r) => r.trava)).toEqual([]);
    });
  });
});
