# ACP v2 session fork cursors

A v2 client can request history with `session/resume` and
`replayFrom: {type: "start"}`. During replay of the root conversation, Codex ACP
announces a `cursor_update` for a replayed user message that starts a turn
after another retained turn. The cursor is anchored before that message.
The app-server forks through the preceding turn, which preserves the exact
history prefix at that boundary. Cursors are currently offered during standard
v2 replay, where the anchor and native turn boundary are both available.

Send the announced `cursorId` with `session/fork` for the same source session.
A valid cursor leaves the source intact and returns a new session. The cursor
is retained under the Codex home and can be used after closing or reconnecting
the ACP connection. A cursor is unavailable if its boundary was removed or
its retained record is gone. Unknown, stale, or cross-session cursor IDs
return Invalid params (`-32602`). A request without a cursor still forks the
whole session. ACP v1 behavior is unchanged.


## Replay from a retained cursor

The v2 initialize response advertises `replayFromCursor: "_fabric_cursor"`
in `_meta["nymph.ai/fabric"]` when Codex has a cursor store. Send
`replayFrom: {type: "_fabric_cursor", cursorId}` on `session/resume`. Replay
starts with the anchored native user message and includes the retained items
after it. The response follows `replay_complete` and the current foreground
snapshot. The adapter rejects missing, stale, unknown, or cross-session
cursor IDs with `-32602`. ACP's standard `replayFrom: {type: "start"}` replays
from the beginning.
