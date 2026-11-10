/**
 * Dismissing notifications once the user has seen a bot's chats (on any device). The server
 * keeps, per bot, when its chats were last seen (`NotificationsSeen`); each client removes the
 * notifications it shows for that bot that were sent up to then.
 */

/** A notification a client showed: its bot, and when it was sent (server time, ms). */
export interface DeliveredNotification {
  readonly botId?: string | null | undefined;
  /** When the server sent it; clients fall back to when it arrived (`receivedAt`). */
  readonly at?: number | null | undefined;
  readonly receivedAt?: number | null | undefined;
}

/** Seen marks, by bot: the latest one wins (two devices may report close together). */
export const withSeenMark = (marks: ReadonlyMap<string, number>, botId: string, at: number): ReadonlyMap<string, number> =>
  (marks.get(botId) ?? 0) >= at ? marks : new Map(marks).set(botId, at);

/**
 * The notifications to dismiss: those of a bot whose chats were seen after they were sent.
 * Other bots' notifications, ones sent after the mark, and ones with no bot or no time stay.
 */
export const seenNotifications = <N extends DeliveredNotification>(delivered: Iterable<N>, marks: ReadonlyMap<string, number>): Array<N> => {
  const out: Array<N> = [];
  for (const n of delivered) {
    if (!n.botId) continue;
    const seenAt = marks.get(n.botId);
    const sentAt = n.at ?? n.receivedAt;
    if (seenAt === undefined || sentAt === null || sentAt === undefined) continue;
    if (sentAt <= seenAt) out.push(n);
  }
  return out;
};
