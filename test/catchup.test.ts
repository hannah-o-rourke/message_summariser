import { test } from "node:test";
import assert from "node:assert/strict";
import { burstThreshold, detectBurst, settings } from "../src/burst";
import { parsePeriod } from "../src/commands";
import { clean, format, transcript } from "../src/summarise";
import { MatrixEvent } from "../types";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 19, 15);

// n messages spread evenly over the hour ending at `end`
function spread(n: number, end: number) {
    return Array.from({ length: n }, (_, i) => end - HOUR + ((i + 1) * HOUR) / (n + 1));
}

test("with little history the fixed fallback threshold applies", () => {
    const times = spread(99, NOW);
    assert.equal(burstThreshold(times, NOW).threshold, settings.fallback);
    assert.equal(detectBurst(times, NOW).isBurst, false);
    assert.equal(detectBurst(spread(100, NOW), NOW).isBurst, true);
});

test("the threshold follows how busy the room usually is", () => {
    // ten days of a quiet room: 4 messages in each of 3 hours a day
    const quiet: number[] = [];
    for (let d = 1; d <= 10; d++) for (const h of [10, 13, 19]) quiet.push(...spread(4, NOW - d * DAY + h * HOUR - 15 * HOUR));
    assert.equal(burstThreshold(quiet, NOW).threshold, Math.max(settings.minimum, 4 * settings.multiplier));

    // the same pattern, but a busy room: 30 an hour
    const busy: number[] = [];
    for (let d = 1; d <= 10; d++) for (const h of [10, 13, 19]) busy.push(...spread(30, NOW - d * DAY + h * HOUR - 15 * HOUR));
    assert.equal(burstThreshold(busy, NOW).threshold, 30 * settings.multiplier);

    // 40 messages this hour is a burst for the quiet room, not the busy one
    assert.equal(detectBurst([...quiet, ...spread(40, NOW)], NOW).isBurst, true);
    assert.equal(detectBurst([...busy, ...spread(40, NOW)], NOW).isBurst, false);
});

test("messages already summarised don't count towards a new burst", () => {
    const times = spread(120, NOW);
    const halfway = times[59];
    assert.equal(detectBurst(times, NOW).isBurst, true);
    assert.equal(detectBurst(times, NOW, halfway + 1).isBurst, false);
});

test("!catchup periods are understood and kept within limits", () => {
    assert.equal(parsePeriod("6h"), 6 * HOUR);
    assert.equal(parsePeriod("30m"), 30 * MINUTE);
    assert.equal(parsePeriod("2 hours"), 2 * HOUR);
    assert.equal(parsePeriod("72h"), 24 * HOUR);
    assert.equal(parsePeriod("1m"), 10 * MINUTE);
    assert.equal(parsePeriod("yesterday"), null);
});

function message(id: string, sender: string, ts: number, body: string, extra: Partial<MatrixEvent> = {}): MatrixEvent {
    return { type: "m.room.message", event_id: id, sender, origin_server_ts: ts, room_id: "!r", content: { msgtype: "m.text", body }, ...extra };
}

test("the transcript leaves out the bot, opt-outs, commands, edits and contact details", () => {
    const events = [
        { type: "m.room.member", event_id: "$m", sender: "@ana:x", state_key: "@ana:x", origin_server_ts: NOW - 2 * HOUR, room_id: "!r", content: { membership: "join", displayname: "Ana Smith" } },
        message("$1", "@ana:x", NOW - 30 * MINUTE, "Call me on 07700 900123 or ana@example.org"),
        message("$2", "@bot:x", NOW - 29 * MINUTE, "bot message"),
        message("$3", "@fay:x", NOW - 28 * MINUTE, "I opted out"),
        message("$4", "@ben:x", NOW - 27 * MINUTE, "!catchup"),
        message("$5", "@ben:x", NOW - 26 * MINUTE, "* fixed", { content: { msgtype: "m.text", body: "* fixed", "m.relates_to": { rel_type: "m.replace" } } }),
        message("$6", "@ben:x", NOW - 25 * MINUTE, "> quoted\n\nSounds good"),
        message("$7", "@ben:x", NOW - 3 * HOUR, "too early"),
    ];
    const lines = transcript(events, NOW - HOUR, NOW, "@bot:x", new Set(["@fay:x"]));

    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[\d\d:\d\d\] Ana: Call me on \[number\] or \[email\]$/);
    assert.match(lines[1], /ben: Sounds good$/);
});

test("clean strips quoted replies and Matrix ids", () => {
    assert.equal(clean("> <@ana:x> earlier\nThanks @whatsapp_447:matrix.org"), "Thanks [someone]");
});

test("the posted summary has the sections, times, fairness note and opt-out", () => {
    const text = format({
        overview: "Planning Saturday's stall.",
        topics: [{ point: "Where to put the stall", time: "14:05" }],
        decisions: [{ point: "Meet at 10am at the market", time: "14:20" }],
        open_questions: [{ point: "Who has a gazebo?", time: "14:31" }],
        actions: [{ action: "print 200 leaflets", who: "Ben", time: "14:40" }, { action: "book the hall", who: null, time: "14:45" }],
        views_differed: true,
    }, 120, NOW - HOUR, NOW, false);

    for (const expected of ["🧵 *Catch-up: 120 messages", "Where to put the stall (14:05)", "✅ Decided", "❓ Still open", "• Ben: print 200 leaflets (14:40)", "• book the hall (14:45)", "⚖️", "AI summary", "React ❌"])
        assert.ok(text.includes(expected), expected);
});

test("empty sections are left out", () => {
    const text = format({ overview: "Chat.", topics: [], decisions: [], open_questions: [], actions: [], views_differed: false }, 12, NOW - HOUR, NOW, false);
    assert.ok(!text.includes("Decided"));
    assert.ok(!text.includes("⚖️"));
});
