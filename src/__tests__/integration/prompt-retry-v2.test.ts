import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdirSync, mkdtempSync} from "node:fs";
import {join} from "node:path";
import {Readable, Writable} from "node:stream";
import {expect, it, vi} from "vitest";
import {removeDirectoryWithRetry, writeCodexHomeConfig} from "../acp-test-utils";
import {describeIntegration, INTEGRATION_MODEL_ID} from "./integration-fixture";
import {startMockResponsesServer, textResponse} from "./mock-responses-server";

describeIntegration("integration: ACP v2 prompt retries", () => {
    it("finds a persisted receipt after restarting the adapter and does not reuse it in a fork", async () => {
        const mock = await startMockResponsesServer();
        mock.setResponseHandler(() => textResponse("OK"));
        const temp = join(process.cwd(), "tmp");
        mkdirSync(temp, {recursive: true});
        const root = mkdtempSync(join(temp, "v2-prompt-retry-"));
        const cwd = join(root, "workspace");
        const codexHome = join(root, "codex-home");
        mkdirSync(cwd);
        mkdirSync(codexHome);
        writeCodexHomeConfig(codexHome, {
            model: INTEGRATION_MODEL_ID.model,
            model_reasoning_effort: INTEGRATION_MODEL_ID.effort,
            web_search: "disabled",
        });
        const methods = acp.methods.agent;
        const withAgent = async <T>(run: (agent: acp.ClientContext, updates: acp.UpdateSessionNotification[]) => Promise<T>): Promise<T> => {
            const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
                cwd: process.cwd(), env: {...process.env, CODEX_HOME: codexHome},
                stdio: ["pipe", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", chunk => { stderr += chunk.toString(); });
            const updates: acp.UpdateSessionNotification[] = [];
            const connection = acp.client()
                .onNotification(acp.methods.client.session.update, ({params}) => { updates.push(params); })
                .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
            try {
                const agent = connection.agent;
                await agent.request(methods.initialize, {
                    protocolVersion: 2, info: {name: "vitest", version: "1"},
                    capabilities: {auth: {_meta: {gateway: true}}},
                });
                await agent.request(methods.auth.login, {
                    methodId: "gateway", _meta: {gateway: {baseUrl: mock.baseUrl, headers: {}}},
                });
                return await run(agent, updates);
            } catch (error) {
                if (stderr) console.error(stderr);
                throw error;
            } finally {
                connection.close();
                child.stdin.end();
                if (child.exitCode === null && child.signalCode === null) {
                    const timeout = setTimeout(() => child.kill(), 4_000);
                    try { await once(child, "exit"); }
                    finally { clearTimeout(timeout); }
                }
            }
        };
        const prompt = {
            idempotencyKey: "test-submission-key",
            prompt: [{type: "text" as const, text: "Reply with OK"}],
        };
        const waitForIdle = (updates: acp.UpdateSessionNotification[], session: string, count = 1) => vi.waitFor(() => {
            expect(updates.filter(({sessionId, update}) => sessionId === session
                && acp.SessionUpdate.isStateUpdate(update) && update.state === "idle"
                && "stopReason" in update && update.stopReason === "end_turn")).toHaveLength(count);
        }, {timeout: 10_000});
        try {
            const {sessionId, messageId, secondMessageId} = await withAgent(async (agent, updates) => {
                const {sessionId} = await agent.request(methods.session.new, {cwd});
                const {messageId} = await agent.request(methods.session.prompt, {sessionId, ...prompt});
                await waitForIdle(updates, sessionId);
                const {messageId: secondMessageId} = await agent.request(methods.session.prompt, {
                    sessionId, ...prompt, idempotencyKey: "second-submission-key",
                });
                await waitForIdle(updates, sessionId, 2);
                await agent.request(methods.session.close, {sessionId});
                return {sessionId, messageId, secondMessageId};
            });
            await withAgent(async (agent, updates) => {
                const calls = mock.requests.length;
                await agent.request(methods.session.resume, {cwd, sessionId});
                await expect(agent.request(methods.session.prompt, {sessionId, ...prompt})).resolves.toEqual({messageId});
                expect(mock.requests).toHaveLength(calls);
                expect(updates.some(({update}) => acp.SessionUpdate.isUserMessageChunk(update))).toBe(false);

                await agent.request(methods.session.resume, {cwd, sessionId, replayFrom: {type: "start"}});
                const replayed = updates.filter(({update}) => acp.SessionUpdate.isUserMessageChunk(update));
                expect(replayed).toEqual([messageId, secondMessageId]
                    .map(id => expect.objectContaining({update: expect.objectContaining({messageId: id})})));
                expect(JSON.stringify(updates)).not.toContain(prompt.idempotencyKey);

                const cursor = updates.find(({update}) => acp.SessionUpdate.isCursorUpdate(update))?.update;
                expect(cursor).toMatchObject({anchor: {type: "user_message", messageId: secondMessageId, position: "before"}});
                if (!cursor || !acp.SessionUpdate.isCursorUpdate(cursor)) throw new Error("Missing fork cursor");
                const fork = await agent.request(methods.session.fork, {cwd, sessionId, cursorId: cursor.cursorId});
                await agent.request(methods.session.resume, {cwd, sessionId: fork.sessionId, replayFrom: {type: "start"}});
                const forkReplay = updates.filter(({sessionId: id, update}) =>
                    id === fork.sessionId && acp.SessionUpdate.isUserMessageChunk(update));
                expect(forkReplay).toEqual([expect.objectContaining({update: expect.objectContaining({messageId})})]);
                const forkReceipt = await agent.request(methods.session.prompt, {...prompt, sessionId: fork.sessionId});
                expect(forkReceipt.messageId).not.toBe(messageId);
                await waitForIdle(updates, fork.sessionId);
                await agent.request(methods.session.close, {sessionId: fork.sessionId});
                await agent.request(methods.session.close, {sessionId});
            });
            expect(mock.unexpectedRequests).toBe(0);
        } finally {
            await mock.close();
            removeDirectoryWithRetry(root);
        }
    });
});
