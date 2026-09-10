/**
 * Session event-log access, isolated behind one accessor.
 *
 * The supported host is DSH 0.1.5: the session log is a surface-layer snapshot
 * exposed through `Session.snapshotEvents()`. Older hosts carried a plain
 * `Session.events` property; that API is GONE and this plugin deliberately has
 * no compatibility path for it.
 *
 * The accessor exists because of the 2026-09-10 outage: the property vanished in
 * a host upgrade, the plugin kept compiling against stale typings, the read
 * returned `undefined`, and `[...undefined]` threw on the turn/end path. The
 * throw became an unhandled rejection, DSH's fail-loud handler exited the
 * process, and the final answer still queued in memory died with it.
 *
 * So: one access point, never throwing, an absent or broken accessor REPORTED
 * once (a silent `undefined` is exactly what made the outage invisible), and a
 * log that degrades to empty instead of taking the host down.
 *
 * @module dsh-wechat-bridge/session-events
 */
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
/** The session's event log, or an empty log when the host exposes none. */
export declare function sessionEvents(session: Session): readonly SessionEvent[];
/** The last event of the session log, if any. */
export declare function lastSessionEvent(session: Session): SessionEvent | undefined;
/** The session log in reverse chronological order (newest first). */
export declare function reversedSessionEvents(session: Session): SessionEvent[];
//# sourceMappingURL=session-events.d.ts.map