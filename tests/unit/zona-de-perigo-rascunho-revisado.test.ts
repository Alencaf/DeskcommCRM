import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RAIZES_DO_APAGAMENTO } from "@/lib/settings/apagar-dados-operacionais";

/**
 * Issue #949: a Zona de perigo começa por `messages`. Com uma resposta
 * revisada enviada, `ai_reply_drafts.message_id` (NO ACTION) recusava o
 * DELETE. SET NULL solta a mensagem; o rascunho some depois, no CASCADE
 * de `conversations`.
 */
const MIGRATION = join(
  process.cwd(),
  "supabase/migrations/20260916090000_0266_rascunho_revisado_solta_a_mensagem.sql",
);
const BASELINE = join(process.cwd(), "supabase/baseline.sql");

describe("zona de perigo — rascunho revisado não trava messages (#949)", () => {
  it("ainda apaga messages antes de contacts (as três RESTRICT continuam na frente)", () => {
    const tabelas = RAIZES_DO_APAGAMENTO.map((r) => r.tabela);
    expect(tabelas.indexOf("messages")).toBeLessThan(tabelas.indexOf("contacts"));
    expect(tabelas[0]).toBe("messages");
  });

  it("a 0266 recria a FK com ON DELETE SET NULL", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(/ai_reply_drafts_message_id_fkey/);
    expect(sql).toMatch(/on delete set null/i);
    expect(sql).not.toMatch(/on delete cascade/i);
  });

  it("o baseline da tabela e o alter de clone antigo batem com a migration", () => {
    const sql = readFileSync(BASELINE, "utf8");
    const bloco = sql.slice(sql.indexOf("create table if not exists public.ai_reply_drafts"));
    expect(bloco).toContain("message_id uuid references public.messages(id) on delete set null");
    expect(bloco).toContain("add constraint ai_reply_drafts_message_id_fkey");
    expect(bloco).toMatch(/on delete set null/);
  });
});

describe("o update.sh não derruba a FK de message_id a cada passada (0266)", () => {
  it("nenhum drop solto da FK no baseline: a troca mora num bloco que confere antes", () => {
    const sql = readFileSync(BASELINE, "utf8");
    // O `update.sh` reaplica o baseline inteiro com o app atendendo. Um `alter
    // table … drop constraint` solto, no início da linha, roda em toda passada e
    // pede trava em `messages` — a forma que este teste recusa.
    expect(sql).not.toMatch(/^alter table public\.ai_reply_drafts drop constraint/im);
    const inicio = sql.indexOf("-- ---- rascunho revisado solta a mensagem (migration 0266) ----");
    expect(inicio, "o bloco rotulado da 0266 sumiu do baseline").toBeGreaterThan(-1);
    const bloco = sql.slice(inicio, sql.indexOf("\n-- ---- ", inicio + 10));
    expect(bloco).toMatch(/confdeltype = 'n'/);
    expect(bloco).toMatch(/on delete set null/i);
  });
});
