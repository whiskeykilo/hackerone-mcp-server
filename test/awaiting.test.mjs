// Runs against compiled output: `npm test` builds first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyAwaiting, isBoilerplateComment } from "../dist/awaiting.js";

// Recorded from GET /hackers/reports/{id} on 2026-10-11, trimmed to the fields
// the classifier reads (no vulnerability text, no attachment URLs).
const fixture = (id) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${id}.json`, import.meta.url), "utf8"));

// The four reports the timestamp check flagged on 2026-10-11. None needs a reply.
for (const [id, why] of [
  ["4067153", "preliminary-analyst-review comment + scope change"],
  ["4054963", "pending-program-review after reporter's last comment"],
  ["3882755", "pending-program-review only"],
  ["4103694", "title/severity/triaged/not-eligible-for-bounty"],
]) {
  test(`${id} is not awaiting a reply (${why})`, () => {
    const r = fixture(id);
    // Sanity: the timestamp check does flag it.
    assert.ok(r.attributes.last_program_activity_at > r.attributes.last_reporter_activity_at);
    assert.deepEqual(classifyAwaiting(r), { awaiting_your_reply: false, awaiting_reason: null });
  });
}

const reporter = { data: { type: "user", attributes: { username: "whiskeykilo" } } };
const act = (type, created_at, message, username = "h1_analyst_x", internal = false) => ({
  type,
  attributes: { message, created_at, internal },
  relationships: { actor: { data: { type: "user", attributes: { username } } } },
});
const report = (state, lastMine, activities) => ({
  attributes: { state, closed_at: null, last_reporter_activity_at: lastMine },
  relationships: { reporter, activities: { data: activities } },
});

test("needs-more-info state is awaiting", () => {
  const r = report("needs-more-info", "2026-10-01T00:00:00.000Z", [
    act("activity-bug-needs-more-info", "2026-10-02T09:00:00.000Z",
      "Greetings, To validate your report, we require additional information."),
  ]);
  assert.deepEqual(classifyAwaiting(r), {
    awaiting_your_reply: true,
    awaiting_reason: "needs-more-info",
  });
});

test("a plain human question is awaiting", () => {
  const r = report("triaged", "2026-10-01T00:00:00.000Z", [
    act("activity-comment", "2026-10-02T09:00:00.000Z",
      "Hi, could you share the exact request you used for step 3?"),
  ]);
  assert.deepEqual(classifyAwaiting(r), {
    awaiting_your_reply: true,
    awaiting_reason: "program comment 2026-10-02",
  });
});

test("a question is still awaiting when a status change follows it", () => {
  const r = report("triaged", "2026-10-01T00:00:00.000Z", [
    act("activity-comment", "2026-10-02T09:00:00.000Z", "Which version did you test?"),
    act("activity-report-title-updated", "2026-10-03T09:00:00.000Z", ""),
  ]);
  assert.equal(classifyAwaiting(r).awaiting_reason, "program comment 2026-10-02");
});

test("a program comment before the reporter's last word is not awaiting", () => {
  const r = report("triaged", "2026-10-01T00:00:00.000Z", [
    act("activity-comment", "2026-09-30T09:00:00.000Z", "Which version did you test?"),
    act("activity-comment", "2026-10-03T09:00:00.000Z", "19.4.1", "whiskeykilo"),
  ]);
  assert.equal(classifyAwaiting(r).awaiting_your_reply, false);
});

test("internal activity is ignored", () => {
  const r = report("triaged", "2026-10-01T00:00:00.000Z", [
    act("activity-comment", "2026-10-02T09:00:00.000Z", "ping the owner team?", "h1_analyst_x", true),
  ]);
  assert.equal(classifyAwaiting(r).awaiting_your_reply, false);
});

test("an unrecognised activity type with text is awaiting", () => {
  const r = report("triaged", "2026-10-01T00:00:00.000Z", [
    act("activity-some-new-thing", "2026-10-02T09:00:00.000Z", "Please retest the fix."),
  ]);
  assert.equal(classifyAwaiting(r).awaiting_reason, "unrecognised some-new-thing 2026-10-02");
});

test("boilerplate with an added question is not boilerplate", () => {
  const base = fixture("4067153").relationships.activities.data[1].attributes.message;
  assert.equal(isBoilerplateComment(base), true);
  // hackerone-agent's variant, without "analyst"
  const agent = fixture("4054963").relationships.activities.data[0].attributes.message;
  assert.equal(isBoilerplateComment(agent), true);
  assert.equal(isBoilerplateComment(base + "\n\nCould you also confirm the tenant ID?"), false);
});

test("closed reports are never awaiting", () => {
  const r = report("resolved", "2026-10-01T00:00:00.000Z", [
    act("activity-comment", "2026-10-02T09:00:00.000Z", "Any other questions?"),
  ]);
  r.attributes.closed_at = "2026-10-02T10:00:00.000Z";
  assert.equal(classifyAwaiting(r).awaiting_your_reply, false);
});
