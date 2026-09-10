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

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { debugLogEvent } from './debug-log.ts'

/** Whether the one-time host-API drift diagnostic has been emitted. */
let apiDriftReported = false

function reportApiDrift(detail: string): void {
  if (apiDriftReported) return
  apiDriftReported = true
  debugLogEvent({
    event: 'session-events-api-drift',
    expected: 'Session.snapshotEvents() — dsh 0.1.5-rc.1',
    detail: detail.slice(0, 200),
  })
}

/** The session's event log, or an empty log when the host exposes none. */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const host = session as unknown as { snapshotEvents?: () => readonly SessionEvent[] }
  if (typeof host.snapshotEvents !== 'function') {
    reportApiDrift('Session.snapshotEvents is not a function')
    return []
  }
  try {
    const events = host.snapshotEvents()
    if (Array.isArray(events)) return events
    reportApiDrift('Session.snapshotEvents() did not return an array')
    return []
  } catch (error) {
    reportApiDrift(`Session.snapshotEvents() threw: ${String(error)}`)
    return []
  }
}

/** The last event of the session log, if any. */
export function lastSessionEvent(session: Session): SessionEvent | undefined {
  const events = sessionEvents(session)
  return events.length > 0 ? events[events.length - 1] : undefined
}

/** The session log in reverse chronological order (newest first). */
export function reversedSessionEvents(session: Session): SessionEvent[] {
  return [...sessionEvents(session)].reverse()
}
