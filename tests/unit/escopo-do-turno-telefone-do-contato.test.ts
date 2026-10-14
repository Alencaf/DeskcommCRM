import { describe, expect, it } from "vitest";

import { ESCOPO_DAS_ESCRITAS, escritaCabeNoTurno } from "@/lib/ai/runtime/escopo-das-escritas";

/**
 * A ESCRITA POR TELEFONE DURANTE UM TURNO SÓ ALCANÇA O CONTATO DA CONVERSA.
 *
 * `crm_upsert_contact` identifica o alvo pelo TELEFONE, não por um id. A ponte
 * do turno (`escritaCabeNoTurno`) só sabia conferir identificadores de registro:
 * entrada com o telefone declarado "sem dono" deixaria um agente, no meio de uma
 * conversa, criar ou completar QUALQUER contato da organização. O dono novo
 * `telefone_do_contato` confere que o número enviado é o do contato do turno,
 * pelas duas grafias do nono dígito, e recusa com a mesma resposta de
 * `fora_da_conversa` que os outros donos dão — para número alheio e para contato
 * inexistente, sem distinguir os dois.
 *
 * Um dublê de banco mínimo: `from().select().eq()...maybeSingle()` devolve a
 * linha combinada, e anota as tabelas consultadas.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const TURNO = "22222222-2222-4222-8222-222222222222";
const SEU_NUMERO = "+5511990000001";
const LEGADO_DO_TURNO = "+551190000002";
const LEGADO_COM_NONO = "+5511990000002";
const NUMERO_ALHEIO = "+5511990000009";

function bancoCom(telefone: string | null | undefined) {
  const tabelas: string[] = [];
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) cadeia[m] = () => cadeia;
  cadeia.maybeSingle = async () => ({
    data: telefone === undefined ? null : { phone_number: telefone },
    error: null,
  });
  return { tabelas, supabase: { from: (t: string) => (tabelas.push(t), cadeia) } as never };
}

const veredito = (telefone: string | null | undefined, enviado: string) => {
  const { supabase, tabelas } = bancoCom(telefone);
  return escritaCabeNoTurno(supabase, ORG, TURNO, "crm_upsert_contact", { phone: enviado }).then((v) => ({ v, tabelas }));
};

describe("escopo do turno para a escrita por telefone", () => {
  it("crm_upsert_contact declara o telefone como do contato do turno e a pessoa como configuração", () => {
    expect(ESCOPO_DAS_ESCRITAS.crm_upsert_contact).toEqual({
      phone: "telefone_do_contato",
      person_id: "configuracao",
    });
  });

  it("[control] o número do próprio contato do turno passa", async () => {
    const { v, tabelas } = await veredito(SEU_NUMERO, SEU_NUMERO);

    expect(v).toEqual({ permitido: true });
    expect(tabelas).toEqual(["contacts"]);
  });

  it("o mesmo número em outra grafia do nono dígito também é o do contato do turno", async () => {
    expect(await veredito(LEGADO_DO_TURNO, LEGADO_COM_NONO).then((r) => r.v)).toEqual({ permitido: true });
    expect(await veredito(LEGADO_COM_NONO, LEGADO_DO_TURNO).then((r) => r.v)).toEqual({ permitido: true });
  });

  it("[counterpart] o número de outra pessoa é recusado como fora da conversa", async () => {
    const { v } = await veredito(SEU_NUMERO, NUMERO_ALHEIO);

    expect(v).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
  });

  it("contato do turno sem telefone e contato do turno inexistente recebem a mesma recusa do número alheio", async () => {
    const alheio = await veredito(SEU_NUMERO, NUMERO_ALHEIO).then((r) => r.v);
    const semTelefone = await veredito(null, SEU_NUMERO).then((r) => r.v);
    const inexistente = await veredito(undefined, SEU_NUMERO).then((r) => r.v);

    expect(alheio).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
    expect(semTelefone).toEqual(alheio);
    expect(inexistente).toEqual(alheio);
  });

  it("telefone que não é texto é recusado, nunca pulado", async () => {
    const { supabase } = bancoCom(SEU_NUMERO);

    const v = await escritaCabeNoTurno(supabase, ORG, TURNO, "crm_upsert_contact", { phone: [SEU_NUMERO] });

    expect(v).toMatchObject({ permitido: false, motivo: "fora_da_conversa" });
  });

  it("falha de leitura é indisponível, não fora da conversa", async () => {
    const quebrado = { from: () => { throw new Error("banco fora do ar"); } } as never;

    const v = await escritaCabeNoTurno(quebrado, ORG, TURNO, "crm_upsert_contact", { phone: SEU_NUMERO });

    expect(v).toMatchObject({ permitido: false, motivo: "indisponivel" });
  });
});
