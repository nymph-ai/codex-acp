import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {RequestError} from "@agentclientprotocol/sdk/unstable";
import type {CodexAppServerClient} from "./CodexAppServerClient";

export type ForkBoundary = {
    sessionId: string;
    previousTurnId: string;
    turnId: string;
    itemId: string;
};

function cursorId(boundary: ForkBoundary): string {
    return "cur_" + createHash("sha256").update(JSON.stringify([
        boundary.sessionId, boundary.previousTurnId, boundary.turnId, boundary.itemId,
    ])).digest("hex");
}

/** Retain issued cursors beside native history so an ACP reconnection can still use them. */
export async function issueForkCursor(home: string, boundary: ForkBoundary): Promise<string> {
    const id = cursorId(boundary);
    const directory = join(home, "acp-fork-cursors");
    await mkdir(directory, {recursive: true, mode: 0o700});
    const path = join(directory, id);
    const staging = join(directory, randomUUID());
    try {
        await writeFile(staging, JSON.stringify(boundary), {flag: "wx", mode: 0o600});
        await rename(staging, path);
    } finally {
        await rm(staging, {force: true});
    }
    return id;
}

export async function resolveForkCursor(
    home: string | null,
    client: CodexAppServerClient,
    sessionId: string,
    id: string,
): Promise<string> {
    const boundary = await resolveCursorBoundary(home, client, sessionId, id);
    return boundary.previousTurnId;
}

export async function resolveCursorBoundary(
    home: string | null,
    client: CodexAppServerClient,
    sessionId: string,
    id: string,
): Promise<ForkBoundary> {
    const invalid = () => RequestError.invalidParams({cursorId: id}, "Cursor is unavailable in this session");
    if (home === null || !/^cur_[a-f0-9]{64}$/.test(id)) throw invalid();

    let boundary: ForkBoundary;
    try {
        boundary = JSON.parse(await readFile(join(home, "acp-fork-cursors", id), "utf8"));
    } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") throw invalid();
        throw error;
    }
    if (!boundary || boundary.sessionId !== sessionId || cursorId(boundary) !== id) throw invalid();

    const {thread} = await client.threadReadWithHistory(sessionId);
    const index = thread.turns.findIndex(turn => turn.id === boundary.turnId);
    const item = thread.turns[index]?.items[0];
    if (thread.id !== sessionId || thread.turns[index - 1]?.id !== boundary.previousTurnId
        || item?.type !== "userMessage" || item.id !== boundary.itemId) throw invalid();
    return boundary;
}
