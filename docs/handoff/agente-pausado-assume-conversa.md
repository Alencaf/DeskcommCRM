# Handoff — "agente pausado continua assumindo conversa"

> Doc VIVO. Mantido até a tarefa terminar. Toda sessão que retomar isto lê daqui primeiro.

## Relato do dono (2026-08-28)

Na VPS (`ssh hg-vps`, `deskcommcrm-app-1` @ `1.9.1`):

- O agente **publicado** é o **Suporte Deskcomm**.
- Quem **pega as conversas para atender** é o **Atendente Clínica Vitalis**, que está **PAUSADO**.
- Antes, quem estava ativo era o Vitalis. Hipótese do dono: ele "impregnou" — o agente que
  um dia esteve publicado continua assumindo mesmo depois de desativado.
- Suspeita de que o defeito seja **geral**, alcançando o roteador de intenção e a
  **prioridade** entre agentes.

**Resultado esperado:** agente publicado assume a conversa; agente pausado NÃO assume;
o que a UI diz é o que acontece na execução.

## Estado

| Etapa | Status |
|---|---|
| Mapear caminhos de seleção de agente | feito |
| Medir estado real do banco da VPS | feito |
| Causa raiz identificada | **SIM — não é o seletor** |
| Teste que reprova o defeito | — |
| Correção | — |
| Prova em tela (Playwright) | — |

## O que já se sabe do código (SHA 481c24c4, working tree limpo)

- `lib/agent-engine/agent/agent-config.ts`
  - `loadPublishedAgentConfig(db, org, channelSessionId)` — join `ai_agents` ⋈
    `ai_agent_versions ON v.id = a.published_version_id`, com
    `archived_at is null`, `v.status='published'`, `v.channel_session_id = $2`,
    `order by a.priority desc, a.created_at asc limit 1`.
  - `loadPublishedAgentConfigById(db, org, agentId)` — mesma coisa **sem** o filtro de
    `channel_session_id` (usada pelos membros do Intent Router).
- `app/api/v1/ai/agents/[id]/pause/route.ts` — pausar limpa `published_version_id` e
  marca a versão como `superseded`. Ou seja, no papel, pausar deveria bastar.
- Memória `project_inbox_quem_manda`: existe atribuição de conversa
  (`assignee_kind='ai_agent'`) e o motor já teve o defeito de não lê-la.

## Hipóteses abertas

1. **Atribuição grudada** — a conversa foi atribuída ao Vitalis quando ele era publicado;
   algum caminho do motor honra `conversations.assignee_id` sem reconferir se aquele
   agente ainda está publicado.
2. **Outro seletor** — o dispatcher do CRM (`lib/ai/dispatcher/`) ou o worker
   (`workers/ai-response-worker.ts`) selecionam por critério diferente do loader acima.
3. **Router com membro morto** — `ai_router_members` aponta para agente despublicado e
   `loadPublishedAgentConfigById` (ou o fallback do router) não reprova.
4. **Job antigo na fila** — o turno carrega `agent_id`/`version_id` congelado no payload
   do job em vez de resolver no início do turno.

## Impedimentos registrados

(nada ainda)


---

## MEDIÇÃO NA VPS (2026-08-28, banco `aws-1-us-west-2.pooler.supabase.com`)

Org medida: `988371bf-b118-4090-b4f3-dc07ae9366c9` (Deskcomm Administracao Ltda).
Sessão de canal VIVA: `66491066-1b9f-4e8e-ad9e-91052db0e66b` ("Lia", `WORKING`).

### 1. O seletor de agente está CERTO. Medido, não inferido.

`ai_agents` na org:

| agente | priority | `published_version_id` | arquivado |
|---|---|---|---|
| Suporte DeskcommCRM (`13858061`) | 1000 | **preenchido** (`99ad9c50`, v5) | não |
| Vitoria - Atendente Clinica Vitalis (`726a3eb6`) | 999 | **NULL** | não |

O pause fez o que promete: `published_version_id = null` + versão `superseded`.

Log do worker no turno de hoje (job `bce692bd-1261-450f-a09a-bba834651d6b`):

```
"config do agente publicada em uso" agent_id=13858061-... agent_version_id=99ad9c50-...
                                    model=gpt-5.6-terra router_outcome=no_match
"llm: chamada concluída" purpose=agent_turn origem_da_escolha="agente_publicado"
                         inputTokens=22270
```

**O agente escolhido foi o publicado.** `loadPublishedAgentConfig` e
`loadPublishedAgentConfigById` ambos filtram `published_version_id` + `v.status='published'`
+ `archived_at is null` — um agente pausado não é carregável por nenhum dos dois.

### 2. O sintoma é REAL, e a causa é outra: as camadas por-ORG do prompt

Mesma conversa, mesmo turno, resposta que saiu no WhatsApp às 18:32:52:

> "Oi, Rafael! **Sou a assistente virtual da Vitalis.** Como posso te ajudar hoje?"

Numa conversa **nova** (primeira inbound "i" às 18:32:05) — logo, não é histórico.

`lib/agent-engine/agent/inbound-turn.ts:1317-1340` monta o system prompt de TRÊS camadas:

```ts
const playbook = await loadPlaybook(pool, tenantId,
  agentConfig !== null ? { agentLayer: agentConfig.systemPrompt } : undefined);  // ← POR AGENTE
const skills    = await loadSkills(pool, tenantId);                              // ← POR ORG
const orgMemory = await loadOrgMemory(pool, tenantId);                           // ← POR ORG
const systemWithMemory = composeSystemPrompt({
  playbookPrompt: playbook.prompt, orgMemoryBlock: renderOrgMemory(orgMemory), skillIndex });
```

Trocar o agente publicado troca **uma** das três. As outras duas seguem intactas — e na
VPS as duas são da Clínica Vitalis:

- `org_memory_pointers.version_id = 50c3ce89` → conteúdo em vigor abre com
  *"A Vitalis é uma clínica odontológica especializada em Divinópolis/MG"* e
  *"Quem escreve é chamado de PACIENTE, nunca de cliente ou lead"*.
  O bloco é renderizado com o rótulo **"valem para TODO atendimento"**
  (`org-memory.ts:43`).
- `skill_versions.body` (`e4660130`) → *"Currículo: e-mail contato@clinicavitalis.com.br,
  aos cuidados da Aline"*, *"Este contato NÃO entra no funil comercial"*.

Varredura do banco por `ilike '%vitalis%'` achou resíduo em 25 pares tabela/coluna,
entre eles `skill_versions.body`, `org_memory_versions.content`, `crm_pipelines.name`,
`lead_checkpoints.rolling_summary` (13 linhas).

**É a "impregnação" que o dono descreveu — só que o portador não é o seletor de agente,
são as camadas de contexto que o seletor nem toca.**

### 3. Dois defeitos adjacentes, medidos no mesmo banco

- **`conversations.active_ai_agent_id` fica apontando para agente despublicado.**
  3 conversas seguem com `active_ai_agent_id = 726a3eb6` (Vitalis, despublicado em
  26/08 17:56). Nada limpa esse ponteiro no pause. Ele só é reescrito se a conversa
  receber nova mensagem **e** houver router ativo (`inbound-turn.ts:1263`).
- **Router ATIVO com ZERO membros e sem fallback na sessão viva.**
  `ai_routers 60bebc5a` ("Roteador - CLinica X"), `is_active=t`, 0 membros,
  `fallback_agent_id` NULL. Toda decisão sai `no_match` (15/15 em
  `ai_router_decisions`). Hoje é inócuo — a regra 5 de `resolve-turn-agent.ts` faz
  cair no agente publicado da sessão — mas gasta **uma chamada de classificador por
  turno** (`purpose=intent_router`, medido no log) para não classificar nada.

---

## A CAUSA RAIZ (medida no código, SHA 481c24c4)

O dono estava certo sobre o efeito e a intuição ("impregnou"). O portador não é o
resolvedor do turno — é **`ai_agents.is_active`, uma coluna que a pausa não desliga e
que dois workers ainda usam como critério de "quem atende"**.

### A cadeia, sítio por sítio

1. **Pausar um `mcp_agent` não desliga `is_active`.**
   `app/app/ai/agents/_actions.ts:77`
   ```ts
   // Legacy rag_bot: também flip is_active para refletir no badge.
   if (existing.kind !== "mcp_agent") updates.is_active = false;
   ```
   E a rota REST `app/api/v1/ai/agents/[id]/pause/route.ts` **nunca** escreve
   `is_active`, para nenhum `kind`.

2. **O badge ignora `is_active` para `mcp_agent` — e está certo.**
   `AgentStatusBadge.tsx:27` devolve `published` por `published_version_id`. A tela
   diz a verdade sobre o engine. O problema é que `is_active` continua ligado embaixo,
   sem nada na tela apontando para ele.

3. **O worker legado escolhe agente por `is_active`.**
   `workers/ai-response-worker.ts:642-654`
   ```ts
   .from("ai_agents").select("id, ..., is_active, is_default")
     .eq("organization_id", input.organizationId)
     .eq("is_active", true)
     .order("is_default", { ascending: false })
     .order("created_at", { ascending: true }).limit(1)
   ```
   Sem `archived_at`, sem `published_version_id`, sem `kind`. O mesmo padrão em
   `workers/ai-sentiment-worker.ts:120-128`.

4. **A trava que segura o worker legado é ORG-WIDE.**
   `workers/ai-response-worker.ts:677`: ele só desiste (`skip("engine_owns_reply")`) se
   existir **algum** agente com `published_version_id` na organização inteira.

### O que isso produz

> **Pausar o único agente publicado da organização faz um agente que a tela chama de
> "Rascunho" voltar a responder no WhatsApp** — pelo caminho legado, com o
> `system_prompt` da tabela `ai_agents` (o do cadastro, não o da versão), sem as
> ferramentas, sem os funis e sem os guardrails da versão publicada.

Na VPS isso está armado agora: a org tem `is_active=true` em **dois** agentes —
`13858061` (Suporte DeskcommCRM, publicado) e `fceb2e33` ("Atendente IA", `rag_bot`,
`is_default=true`, **não publicado, tela diz "Rascunho"**). Pausar o Suporte
DeskcommCRM entrega o atendimento ao "Atendente IA".

Prova de que o worker legado está vivo em produção — log de hoje:
```
[ai-response-worker] skip reason=engine_owns_reply conversation_id=ed439beb-...
```
Ele roda em todo inbound. A única coisa que o segura é a existência de um publicado.

### E a tela também mente sobre isso

`app/api/v1/ai/automatico-ativo/route.ts:42` responde "automático ativo" contando
`is_active=true` — a régua que **nenhum** dos dois motores usa. Depois de pausar o
publicado, ela continua dizendo que a IA está atendendo.

### O sintoma que o dono viu (persona da Vitalis) tem causa PRÓPRIA

Ver a seção de medição acima: memória da org + skills são **por organização**, o
prompt do agente é **por agente**, e trocar o publicado troca só a terceira camada.
Os dois defeitos são independentes e os dois precisam de conserto.
