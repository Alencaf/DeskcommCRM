import { describe, expect, it } from "vitest";

import { McpAuthError, ToolNotAllowedError, ensureToolAllowed } from "./auth";

/**
 * `ensureToolAllowed` — o contrato de erro da allowlist por token, que o cliente
 * MCP só enxerga como texto (ver `tests/unit/mcp-tool-allowlist.test.ts`): aqui
 * se mede o par que o texto esconde, `-32002` e 403, e que a recusa é distinguível
 * de uma recusa de escopo ou de papel.
 */
describe("ensureToolAllowed", () => {
  it("refuses an unlisted tool with MCP -32002 / HTTP 403 and the tool_not_allowed code", () => {
    let erro: unknown;
    try {
      ensureToolAllowed(["mcp:write", "tool:crm_search_contacts"], "crm_create_lead");
    } catch (e) {
      erro = e;
    }

    expect(erro, "a ferramenta fora da lista não foi recusada").toBeInstanceOf(ToolNotAllowedError);
    expect(erro).toBeInstanceOf(McpAuthError);
    const e = erro as ToolNotAllowedError;
    expect(e.mcpCode).toBe(-32002);
    expect(e.httpStatus).toBe(403);
    expect(e.message).toMatch(/tool_not_allowed/);
    expect(e.toolName).toBe("crm_create_lead");
  });

  it("lets a listed tool through", () => {
    expect(() =>
      ensureToolAllowed(["tool:crm_search_contacts", "tool:crm_create_lead"], "crm_create_lead"),
    ).not.toThrow();
  });

  it("does nothing for a token without any tool: scope", () => {
    expect(() => ensureToolAllowed(["mcp:read", "mcp:write", "role:manager"], "crm_create_lead")).not.toThrow();
    expect(() => ensureToolAllowed([], "crm_create_lead")).not.toThrow();
  });

  it("only the exact tool: prefix counts, and the tool name must match exactly", () => {
    expect(() => ensureToolAllowed(["toolbox:crm_create_lead"], "crm_create_lead")).not.toThrow();
    expect(() => ensureToolAllowed(["tool:crm_create_lead_extra"], "crm_create_lead")).toThrow(ToolNotAllowedError);
    expect(() => ensureToolAllowed(["tool:crm_create"], "crm_create_lead")).toThrow(ToolNotAllowedError);
  });
});
