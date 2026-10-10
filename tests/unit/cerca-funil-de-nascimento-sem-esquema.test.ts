import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * CERCAS DO 5a (CENTRAL-EMPRESAS-001): o funil de nascimento por regra não pede
 * esquema novo e não pode ser apagado em silêncio.
 *
 * As três são verdes hoje e têm de continuar verdes: elas vigiam as PREMISSAS
 * da fase verde, não o comportamento.
 *
 *  F1 `crm_pipelines.settings` já é jsonb no baseline — a regra mora ali, sem
 *     migration (a fila de patches do toxfy-system veda `supabase/`).
 *  F2 salvar as configurações do funil pela tela PRESERVA chaves que a tela não
 *     conhece. Se a action passar a reconstruir `settings` só com os campos do
 *     formulário, `settings.nascimento` some no primeiro "Salvar" — e o card
 *     volta a nascer na TRIAGEM sem erro nenhum.
 *  F3 o nascimento não nomeia funil (regra do cabeçalho de
 *     `lib/leads/nascimento-do-lead.ts`): a regra é dado da organização, nunca
 *     um nome no código.
 */

const raiz = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(raiz, rel), "utf8");

describe("cercas do funil de nascimento por regra", () => {
  it("F1 crm_pipelines.settings é jsonb no baseline", () => {
    const baseline = ler("supabase/baseline.sql");
    const inicio = baseline.indexOf('CREATE TABLE IF NOT EXISTS "public"."crm_pipelines"');
    expect(inicio).toBeGreaterThan(-1);
    const corpo = baseline.slice(inicio, baseline.indexOf(");", inicio));
    expect(corpo).toMatch(/"settings"\s+"jsonb"/);
  });

  it("F2 a action das configurações do funil parte das settings atuais (preserva chaves desconhecidas)", () => {
    const action = ler("app/actions/settings/updatePipelineConfig.ts");
    expect(action).toMatch(/const nextSettings: Record<string, unknown> = \{ \.\.\.currentSettings \};/);
    expect(action).not.toMatch(/settings:\s*parsed\.data\b/);
  });

  it("F3 nascimento-do-lead.ts não nomeia funil", () => {
    const fonte = ler("lib/leads/nascimento-do-lead.ts");
    for (const nome of ["TRIAGEM", "Triagem", "Gestão de Contas", "Canais de relacionamentos", "Credenciamento"]) {
      expect(fonte, nome).not.toContain(`"${nome}`);
    }
  });
});
