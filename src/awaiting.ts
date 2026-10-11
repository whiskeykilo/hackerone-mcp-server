// ── "Is the program waiting on me?" ───────────────────────────────
// Pure classification over a /hackers/reports/{id} payload. No I/O, so it can
// be unit-tested against recorded timelines.
//
// The timestamps on the list endpoint only say who acted last. Program
// activity is mostly status changes and boilerplate, so on 2026-10-11 the
// timestamp check flagged four open reports and none of them needed a reply.
// This looks at what the program actually posted.
//
// The two possible errors cost different amounts. A false "reply needed" costs
// a glance; a false "nothing to do" can miss a deadline. So anything this
// module does not recognise counts as awaiting.

export interface AwaitingVerdict {
  awaiting_your_reply: boolean;
  /** Why it is awaiting, e.g. "needs-more-info" or "program comment 2026-10-02". Null when not. */
  awaiting_reason: string | null;
}

/**
 * Timeline entries that report a status or metadata change. None of them asks
 * the reporter for anything on its own, even when the program attaches a
 * message. The list started from known types and was checked against every
 * type that appears in this account's 35 reports.
 */
export const NON_ACTIONABLE_TYPES = new Set([
  "activity-bug-new",
  "activity-bug-triaged",
  "activity-bug-pending-program-review",
  "activity-bug-reopened",
  "activity-bug-resolved",
  "activity-bug-duplicate",
  "activity-bug-informative",
  "activity-bug-not-applicable",
  "activity-not-eligible-for-bounty",
  "activity-bounty-awarded",
  "activity-report-severity-updated",
  "activity-report-title-updated",
  "activity-report-vulnerability-types-updated",
  "activity-changed-scope",
]);

/**
 * Fixed templates that programs post as activity-comment. Each phrase must be
 * specific enough that a person writing a real question would not use it.
 */
const BOILERPLATE_PHRASES: RegExp[] = [
  // HackerOne triage, posted by an analyst or by hackerone-agent:
  // "has passed the preliminary review" / "...preliminary analyst review"
  /passed the preliminary (analyst )?review/i,
  // DoD VDP auto-acknowledgement
  /thank you for supporting the dod vulnerability disclosure program/i,
  // Airbnb auto-acknowledgement
  /we received your submission and will get back with you/i,
];

/**
 * A comment counts as boilerplate only when it matches a known template and
 * asks no question. A template with a question added to it is treated as a
 * real request.
 */
export function isBoilerplateComment(message: string | null | undefined): boolean {
  if (!message) return false;
  if (message.includes("?")) return false;
  return BOILERPLATE_PHRASES.some((re) => re.test(message));
}

const day = (iso: string) => iso.slice(0, 10);

/**
 * @param report the `data` object of GET /hackers/reports/{id}, which carries
 *   the activities relationship.
 */
export function classifyAwaiting(report: any): AwaitingVerdict {
  const attrs = report?.attributes ?? {};
  if (attrs.state === "needs-more-info") {
    return { awaiting_your_reply: true, awaiting_reason: "needs-more-info" };
  }
  if (attrs.closed_at) return { awaiting_your_reply: false, awaiting_reason: null };

  const reporter: string | undefined =
    report?.relationships?.reporter?.data?.attributes?.username;
  const activities: any[] = report?.relationships?.activities?.data ?? [];

  const isMine = (a: any) => {
    const actor = a.relationships?.actor?.data;
    return actor?.type === "user" && !!reporter && actor.attributes?.username === reporter;
  };

  // The reporter's own last word. The attribute alone is not enough, because
  // the initial submission does not appear in the timeline. Taking the later of
  // the two also covers the case where one of them is missing.
  let lastMine = attrs.last_reporter_activity_at ? Date.parse(attrs.last_reporter_activity_at) : 0;
  for (const a of activities) {
    if (isMine(a)) lastMine = Math.max(lastMine, Date.parse(a.attributes?.created_at));
  }

  // Everything the program posted since then, newest first. An activity whose
  // actor is missing counts as program activity. Internal activity is skipped
  // because the reporter cannot see it.
  const theirs = activities
    .filter(
      (a) =>
        !isMine(a) &&
        !a.attributes?.internal &&
        Date.parse(a.attributes?.created_at) > lastMine
    )
    .sort(
      (a, b) => Date.parse(b.attributes.created_at) - Date.parse(a.attributes.created_at)
    );

  // Every program activity since the reporter's last word is checked, not just
  // the newest. A question followed by a title edit still needs an answer.
  for (const a of theirs) {
    const when = day(a.attributes.created_at);
    const message: string = a.attributes?.message ?? "";
    if (a.type === "activity-bug-needs-more-info") {
      // The state has moved on, but the request itself was never answered.
      return { awaiting_your_reply: true, awaiting_reason: `needs-more-info request ${when}` };
    }
    if (a.type === "activity-comment") {
      if (isBoilerplateComment(message)) continue;
      return { awaiting_your_reply: true, awaiting_reason: `program comment ${when}` };
    }
    if (NON_ACTIONABLE_TYPES.has(a.type)) continue;
    // A type this module does not know. It can only be ignored when it carries
    // no text.
    if (message.trim()) {
      return {
        awaiting_your_reply: true,
        awaiting_reason: `unrecognised ${a.type.replace(/^activity-/, "")} ${when}`,
      };
    }
  }
  return { awaiting_your_reply: false, awaiting_reason: null };
}
