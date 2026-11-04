// The skill in skills/mcp-connector tells agents which tools exist. These
// checks keep it in step with the tools the server really offers.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createBuiltInConnectors } from "../connectors/built-in.js";
import { FilesystemService } from "../filesystem/filesystem.service.js";
import { InMemoryAuditRepository } from "../workflow/audit.repository.js";
import { WorkflowService } from "../workflow/workflow.service.js";
import { createMcpServer } from "./mcp-server.js";

const skill = (path: string) => readFile(join(__dirname, "../../../../skills/mcp-connector", path), "utf8");

async function serverTools(): Promise<string[]> {
  const runtime = { tokens: { getAccessToken: async () => "token" }, requireSetting: () => "value" };
  const server = createMcpServer({
    filesystem: new FilesystemService(),
    workflow: new WorkflowService(new InMemoryAuditRepository()),
    connectors: createBuiltInConnectors().map((definition) => ({ definition, runtime }))
  });
  const client = new Client({ name: "skill-test", version: "0.1.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  await client.close();
  await server.close();
  return names;
}

describe("the mcp-connector skill", () => {
  it("documents exactly the tools the server offers", async () => {
    const reference = await skill("references/tools.md");
    // The first column of every table row names a tool.
    const documented = [...reference.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]).sort();

    expect(documented).toEqual(await serverTools());
  });

  it("mentions every tool in SKILL.md itself", async () => {
    const text = await skill("SKILL.md");
    for (const tool of await serverTools()) expect(text).toContain(`\`${tool}\``);
  });

  it("has the frontmatter skill marketplaces require", async () => {
    const text = await skill("SKILL.md");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    expect(frontmatter).toMatch(/^name: mcp-connector$/m);
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});
