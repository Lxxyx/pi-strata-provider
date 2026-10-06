import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeConfig } from "../src/config.ts";
import { compactionPreset } from "../src/tuning.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "pi-strata-e2e-"));
const agentDir = join(sandbox, "agent");
const workspace = join(sandbox, "workspace");
await mkdir(agentDir); await mkdir(workspace);
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldConfig = process.env.PI_STRATA_CONFIG;
const oldBase = process.env.PI_STRATA_BASE_URL;
const endpoint = normalizeConfig({ baseUrl: process.env.STRATA_E2E_URL ?? oldBase ?? "http://127.0.0.1:8080/v1" }).baseUrl;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_STRATA_CONFIG; delete process.env.PI_STRATA_BASE_URL;
await writeFile(join(agentDir, "strata-provider.json"), JSON.stringify({ baseUrl: endpoint }));
const report: { startedAt: string; tests: { name: string; durationMs: number }[]; model?: string; contextWindow?: number; error?: string } = { startedAt: new Date().toISOString(), tests: [] };
const payloads: any[] = [];
let toolCalls = 0;
const toolToken = `TOOL_${randomUUID().replaceAll("-", "")}`;
const memoryToken = `MEMORY_${randomUUID().replaceAll("-", "")}`;
const sessions: AgentSession[] = [];
const settings = SettingsManager.inMemory({ defaultProvider: "local", defaultModel: "strata-auto", defaultThinkingLevel: "low", retry: { enabled: false }, compaction: { enabled: true } });
const testExtension = (pi: ExtensionAPI) => {
  pi.registerTool({ name: "e2e_lookup", label: "E2E lookup", description: "Return the opaque verification token. Use this tool when asked to look up the token.",
    parameters: Type.Object({ query: Type.String() }),
    execute: async () => { toolCalls++; return { content: [{ type: "text", text: toolToken }], details: {} }; },
  });
};
async function create(dir = agentDir, manager = settings) {
  process.env.PI_CODING_AGENT_DIR = dir;
  const loader = new DefaultResourceLoader({ cwd: workspace, agentDir: dir, settingsManager: manager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(root, "index.ts")], extensionFactories: [testExtension],
    systemPrompt: "You are a concise test assistant. Follow the user's exact output requirements. Use tools when requested. Never fabricate tool results. Remember user verification codes.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const created = await createAgentSession({ cwd: workspace, agentDir: dir, resourceLoader: loader,
    settingsManager: manager, sessionManager: SessionManager.inMemory(workspace), tools: ["read", "write", "edit", "e2e_lookup"] });
  await created.session.bindExtensions({ mode: "print" });
  await created.session.modelRuntime.refresh({ providers: ["local"], allowNetwork: process.env.PI_OFFLINE === undefined });
  const automatic = created.session.modelRuntime.getModel("local", "strata-auto");
  assert.ok(automatic);
  await created.session.setModel(automatic);
  observeRequests(created.session);
  sessions.push(created.session);
  return created.session;
}
function observeRequests(session: AgentSession) {
  const provider = session.modelRuntime.getProvider("local")!;
  const original = provider.streamSimple.bind(provider);
  provider.streamSimple = (model, context, options) => original(model, context, {
    ...options,
    onPayload: async payload => {
      payloads.push(payload);
      return options?.onPayload ? await options.onPayload(payload, model) : undefined;
    },
  });
}
async function step(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  await fn();
  const durationMs = Date.now() - start;
  report.tests.push({ name, durationMs });
  console.log(`PASS ${name} (${durationMs} ms)`);
}
function lastAssistant(session: AgentSession) {
  const message = [...session.messages].reverse().find(message => message.role === "assistant");
  assert.ok(message && message.role === "assistant");
  assert.notEqual(message.stopReason, "error", message.errorMessage);
  return message;
}
function redPng(): string {
  function crc32(bytes: Buffer) {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer) {
    const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  }
  const size = 128; const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const data = Buffer.alloc((1 + size * 3) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * (1 + size * 3) + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(data)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
let proxy: ReturnType<typeof createServer> | undefined;
try {
  const session = await create();
  let physical: any;
  await step("startup discovery and stable automatic model", async () => {
    const result = await session.modelRuntime.refresh({ providers: ["local"], force: true, allowNetwork: true });
    assert.equal(result.errors.size, 0, [...result.errors.values()].map(error => error.message).join("; "));
    const models = session.modelRuntime.getModels().filter(model => model.provider === "local" && model.id !== "strata-auto");
    assert.ok(models.length > 0);
    physical = models[0];
    assert.equal(session.model?.id, "strata-auto");
    assert.equal(physical.compat.supportsReasoningEffort, true);
    assert.equal(physical.compat.supportsDeveloperRole, false);
    const health = await (await fetch(endpoint.replace(/\/v1$/, "") + "/health")).json();
    assert.equal(physical.contextWindow, health.max_context);
    report.model = physical.id; report.contextWindow = physical.contextWindow;
    observeRequests(session);
    settings.applyOverrides({ compaction: { modelOverrides: { "local/strata-auto": compactionPreset(physical) } } });
  });

  await step("streamed text, token usage and thinking disabled", async () => {
    session.setThinkingLevel("off");
    await session.prompt(`Remember verification code ${memoryToken}. Reply only READY.`);
    assert.match(session.getLastAssistantText() ?? "", /READY/);
    const message = lastAssistant(session);
    assert.ok(message.usage.input > 0 && message.usage.output > 0);
    assert.equal(payloads.at(-1).reasoning_effort, "none");
    assert.equal(payloads.at(-1).reasoning_budget_tokens, 0);
    assert.ok(payloads.at(-1).messages.every((message: any) => message.role !== "developer"));
  });

  await step("low, medium and high effort mappings and soft reasoning budgets", async () => {
    for (const [level, answer, budget] of [["low", "42", 1024], ["medium", "323", 4096], ["high", "391", 8192]] as const) {
      session.setThinkingLevel(level);
      await session.prompt(`Compute ${level === "low" ? "6 * 7" : level === "medium" ? "17 * 19" : "17 * 23"}. Reply with only the numeric answer.`);
      assert.match(session.getLastAssistantText() ?? "", new RegExp(answer));
      lastAssistant(session);
      assert.equal(payloads.at(-1).reasoning_effort, level);
      assert.equal(payloads.at(-1).reasoning_budget_tokens, budget);
    }
  });

  await step("native tool call and opaque tool result follow-up", async () => {
    session.setThinkingLevel("low");
    await session.prompt("Call e2e_lookup with query verification and return its exact opaque token. You must call the tool; do not invent a token.");
    assert.ok(toolCalls > 0);
    assert.ok(session.getLastAssistantText()?.includes(toolToken));
    assert.ok(payloads.some(payload => payload.messages?.some((message: any) => message.role === "tool")));
  });

  await step("real Pi write, edit and read tools in an isolated workspace", async () => {
    await session.prompt("Use write to create note.txt containing ALPHA. Then use edit to replace ALPHA with BETA. Then use read to check the file. Reply only FILE_OK when its content is BETA. Do not use a shell.");
    assert.equal((await readFile(join(workspace, "note.txt"), "utf8")).trim(), "BETA");
    assert.match(session.getLastAssistantText() ?? "", /FILE_OK/);
  });

  await step("vision input through Pi and the real Strata encoder", async () => {
    assert.ok(physical.input.includes("image"), "The live model must have vision enabled for this test.");
    session.setThinkingLevel("off");
    await session.prompt("What is the solid color of this image? Reply with only the English color name.", { images: [{ type: "image", data: redPng(), mimeType: "image/png" }] });
    assert.match(session.getLastAssistantText() ?? "", /red/i);
  });

  await step("manual compaction and memory-preserving follow-up", async () => {
    settings.applyOverrides({ compaction: { modelOverrides: { "local/strata-auto": { reserveTokens: 32768, keepRecentTokens: 256 } } } });
    const summary = await session.compact("Preserve the exact remembered verification code and the final contents of note.txt.");
    assert.ok(summary.summary.includes(memoryToken));
    assert.equal(payloads.at(-1).reasoning_effort, "low", "Auto routing must use fast reasoning for summaries.");
    assert.ok(session.sessionManager.getBranch().some(entry => entry.type === "compaction"));
    await session.prompt("What verification code did I ask you to remember? Reply with the exact code only.");
    assert.ok(session.getLastAssistantText()?.includes(memoryToken));
  });

  await step("automatic threshold compaction using a real generated summary", async () => {
    const threshold = 4096;
    settings.applyOverrides({ compaction: { modelOverrides: { "local/strata-auto": { reserveTokens: physical.contextWindow - threshold, keepRecentTokens: 128 } } } });
    const before = session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length;
    await session.prompt("The following is irrelevant padding for a threshold test: " + "irrelevant background ".repeat(2500) + "\nRetain my verification code. Reply only AUTO_OK.");
    assert.ok(session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length > before);
    assert.match(session.getLastAssistantText() ?? "", /AUTO_OK/);
    settings.applyOverrides({ compaction: { modelOverrides: { "local/strata-auto": compactionPreset(physical) } } });
  });

  await step("abort and subsequent successful inference", async () => {
    let abort: Promise<void> | undefined;
    const unsubscribe = session.subscribe(event => {
      if (!abort && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") abort = session.abort();
    });
    await session.prompt("Write a detailed essay with at least 100 numbered paragraphs about test automation.");
    unsubscribe();
    if (abort) await abort;
    assert.ok(abort, "The stream should emit a text delta before aborting.");
    assert.equal(lastAssistant(session).stopReason, "aborted");
    await session.prompt("Reply only ABORT_RECOVERED.");
    assert.match(session.getLastAssistantText() ?? "", /ABORT_RECOVERED/);
  });

  await step("persistent catalog restoration and offline startup", async () => {
    const store = JSON.parse(await readFile(join(agentDir, "models-store.json"), "utf8"));
    assert.ok(JSON.stringify(store).includes(physical.id));
    const previousOffline = process.env.PI_OFFLINE;
    process.env.PI_OFFLINE = "1";
    try {
      const restored = await create();
      assert.ok(restored.modelRuntime.getModel("local", physical.id));
      await restored.prompt("Reply only OFFLINE_CATALOG_OK.");
      assert.match(restored.getLastAssistantText() ?? "", /OFFLINE_CATALOG_OK/);
    } finally { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; }
  });

  await step("authentication failure, default key guidance and stored-key recovery", async () => {
    let requiredKey = "e2e-only-key";
    proxy = createServer(async (req, res) => {
      try {
        const path = req.url ?? "/";
        if (!path.startsWith("/health") && req.headers.authorization !== `Bearer ${requiredKey}`) {
          res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "missing or wrong API key" } })); return;
        }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(endpoint.replace(/\/v1$/, "") + path, { method: req.method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.STRATA_API_KEY ?? "strata-local"}` },
          ...(req.method !== "GET" && { body: Buffer.concat(chunks) }) });
        if (path.startsWith("/health")) { const health = await upstream.json(); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ...health, api_key: true })); return; }
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        if (upstream.body) for await (const bytes of upstream.body) res.write(Buffer.from(bytes));
        res.end();
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise<void>(resolve => proxy!.listen(0, "127.0.0.1", resolve));
    const address = proxy.address(); assert.ok(address && typeof address === "object");
    const protectedDir = join(sandbox, "protected-agent"); await mkdir(protectedDir);
    await writeFile(join(protectedDir, "strata-provider.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1` }));
    const failed = await create(protectedDir);
    const failure = await failed.modelRuntime.refresh({ providers: ["local"], force: true, allowNetwork: true });
    assert.match(failure.errors.get("local")?.message ?? "", /401.*STRATA_API_KEY/);
    assert.ok(!failure.errors.get("local")?.message.includes(requiredKey));
    await writeFile(join(protectedDir, "auth.json"), JSON.stringify({ local: { type: "api_key", key: requiredKey } }));
    const recovered = await create(protectedDir);
    const refreshed = await recovered.modelRuntime.refresh({ providers: ["local"], force: true, allowNetwork: true });
    assert.equal(refreshed.errors.size, 0);
    recovered.setThinkingLevel("off");
    await recovered.prompt("Reply only AUTH_RECOVERED.");
    assert.match(recovered.getLastAssistantText() ?? "", /AUTH_RECOVERED/);
    requiredKey = "rotated-e2e-key";
    const failedRefresh = await recovered.modelRuntime.refresh({ providers: ["local"], allowNetwork: true, force: true });
    assert.match(failedRefresh.errors.get("local")?.message ?? "", /401/);
    assert.ok(recovered.modelRuntime.getModel("local", physical.id), "A failed refresh must retain the cached catalog.");
    await recovered.prompt("Reply only SHOULD_NOT_SUCCEED.");
    const failedMessage = [...recovered.messages].reverse().find(message => message.role === "assistant");
    assert.ok(failedMessage && failedMessage.role === "assistant" && failedMessage.stopReason === "error");
    assert.match(failedMessage.errorMessage ?? "", /\/login.*STRATA_API_KEY/);
    requiredKey = "e2e-only-key";
    await recovered.modelRuntime.refresh({ providers: ["local"], allowNetwork: true, force: true });
    await recovered.prompt("Reply only KEY_FIXED.");
    assert.match(recovered.getLastAssistantText() ?? "", /KEY_FIXED/);
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  await step("installed Pi CLI loads the package and runs live inference", async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const cli = join(packageRoot, typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi);
    const task = promisify(execFile)(process.execPath, [cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-session", "-e", root, "--model", "local/strata-auto", "--thinking", "off", "--no-tools", "-p", "Reply only CLI_E2E_OK."],
      { cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 120000 });
    task.child.stdin?.end();
    const { stdout, stderr } = await task;
    assert.match(stdout, /CLI_E2E_OK/);
    assert.ok(!stderr.includes("Failed to load extension"), stderr);
  });
  console.log(`E2E completed: ${report.tests.length} tests passed.`);
} catch (error) {
  report.error = error instanceof Error ? error.message : "Unknown E2E failure";
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const session of sessions) session.dispose();
  if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  if (oldConfig === undefined) delete process.env.PI_STRATA_CONFIG; else process.env.PI_STRATA_CONFIG = oldConfig;
  if (oldBase === undefined) delete process.env.PI_STRATA_BASE_URL; else process.env.PI_STRATA_BASE_URL = oldBase;
  await mkdir(join(root, ".artifacts"), { recursive: true });
  await writeFile(join(root, ".artifacts", "e2e-report.json"), JSON.stringify(report, null, 2) + "\n");
  await rm(sandbox, { recursive: true, force: true });
}
