import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MatrixEvent } from "../types";
import { optedOutSenders } from "./db";
import { fetchHistory } from "./hub";
import { log } from "./log";

const MODEL = "claude-haiku-5-5";
export const MIN_MESSAGES = 10;
// Haiku's price doubles above 100K input tokens; ~4 characters per token
const MAX_CHARACTERS = 360_000;
const TIME_ZONE = process.env.CATCHUP_TIME_ZONE ?? "Europe/London";

export const OPT_OUT_EMOJI = "❌";
export const OPT_IN_EMOJIS = ["✅", "✔", "☑"];

const Point = z.object({ point: z.string(), time: z.string() });

const SummarySchema = z.object({
    overview: z.string(),
    topics: z.array(Point),
    decisions: z.array(Point),
    open_questions: z.array(Point),
    actions: z.array(z.object({ action: z.string(), who: z.string().nullable(), time: z.string() })),
    views_differed: z.boolean(),
});

export type Summary = z.infer<typeof SummarySchema>;

const SYSTEM_PROMPT = `You write short catch-up summaries of busy community group chats, for members who missed the conversation.

Each message is shown as "[HH:MM] Name: text". For every point you make, give the time of the message it mainly comes from, copied exactly in HH:MM form, so people can scroll back to it.

Fairness matters more than anything else:
- Describe the discussion neutrally. Where people disagreed, give each view fairly and in proportion ("some felt…, others…"), and set views_differed to true.
- Never attach an opinion, argument or disagreement to a named person.
- Only list a decision if the group clearly agreed it. If it's unclear, it's an open question.
- Don't add anything that isn't in the messages, and don't judge who was right.

Names: only use a name for an action someone took on or was clearly given ("who"). Otherwise use null.

Keep it brief: a one-sentence overview, at most 5 topics, and only the decisions, open questions and actions that really came up (empty lists are fine). Plain British English, no quotes longer than a few words.`;

function hhmm(ts: number) {
    return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TIME_ZONE });
}

function firstName(name: string) {
    return name.trim().split(/\s+/)[0] || "Someone";
}

// Quoted replies, contact details and Matrix ids are stripped before anything
// leaves the server.
export function clean(body: string) {
    return body
        .split("\n").filter(line => !line.startsWith(">")).join("\n").trim()
        .replace(/@[^\s:]+:[^\s]+/g, "[someone]")
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
        .replace(/\+?\d[\d\s()-]{7,}\d/g, "[number]");
}

export function transcript(events: MatrixEvent[], from: number, to: number, botUserId: string | undefined, optedOut: Set<string>) {
    const names = new Map<string, string>();
    for (const e of events)
        if (e.type === "m.room.member" && e.state_key && e.content?.displayname) names.set(e.state_key, e.content.displayname);

    return events
        .filter(e => e.type === "m.room.message" && e.origin_server_ts >= from && e.origin_server_ts <= to)
        .filter(e => ["m.text", "m.notice", "m.emote"].includes(e.content?.msgtype))
        .filter(e => e.content?.["m.relates_to"]?.rel_type !== "m.replace")
        .filter(e => e.sender !== botUserId && !optedOut.has(e.sender))
        .filter(e => !String(e.content?.body ?? "").trim().toLowerCase().startsWith("!catchup"))
        .sort((a, b) => a.origin_server_ts - b.origin_server_ts)
        .map(e => {
            const text = clean(String(e.content.body ?? ""));
            const name = firstName(names.get(e.sender) ?? e.displayname ?? e.sender.replace(/^@/, "").split(":")[0]);
            return text ? `[${hhmm(e.origin_server_ts)}] ${name}: ${text}` : "";
        })
        .filter(Boolean);
}

export function format(summary: Summary, count: number, from: number, to: number, trimmed: boolean) {
    const lines: string[] = [];
    lines.push(`🧵 *Catch-up: ${count} messages from ${hhmm(from)} to ${hhmm(to)}*`);
    lines.push("", summary.overview);

    const section = (title: string, items: string[]) => {
        if (items.length) lines.push("", `*${title}*`, ...items.map(i => `• ${i}`));
    };
    section("Main points", summary.topics.map(t => `${t.point} (${t.time})`));
    section("✅ Decided", summary.decisions.map(d => `${d.point} (${d.time})`));
    section("❓ Still open", summary.open_questions.map(q => `${q.point} (${q.time})`));
    section("📌 To do", summary.actions.map(a => `${a.who ? `${a.who}: ` : ""}${a.action} (${a.time})`));

    if (summary.views_differed)
        lines.push("", "⚖️ People had different views here. Scroll up to read them in their own words.");
    if (trimmed)
        lines.push("", "(This was a very long conversation, so only the most recent part is summarised.)");

    lines.push("", "🤖 _This is an AI summary, so it may miss nuance. The times show where to scroll back to._");
    lines.push(`${OPT_OUT_EMOJI} React ${OPT_OUT_EMOJI} if you'd rather your messages weren't included in summaries.`);
    return lines.join("\n");
}

export function canSummarise() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Fetches the messages from the hub, leaves out anyone who opted out, and asks
// Claude for a summary. Nothing but the posted summary is kept.
export async function summarise(roomId: string, from: number, to: number, botUserId: string | undefined) {
    log("summary: 1/3 asking the hub for the messages", { room: roomId, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
    const events = await fetchHistory(roomId, from);
    let lines = transcript(events, from, to, botUserId, await optedOutSenders(roomId));
    log("  usable messages", { count: lines.length });

    if (lines.length < MIN_MESSAGES)
        return { ok: false as const, count: lines.length };

    let trimmed = false;
    while (lines.join("\n").length > MAX_CHARACTERS) {
        lines = lines.slice(Math.ceil(lines.length / 10));
        trimmed = true;
    }

    log("summary: 2/3 sending to Claude", { model: MODEL, characters: lines.join("\n").length });
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    const client = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
    const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: { effort: "low", format: zodOutputFormat(SummarySchema) },
        messages: [{ role: "user", content: lines.join("\n") }],
    });
    log("  Claude replied", { stop_reason: response.stop_reason, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens });

    if (response.stop_reason === "refusal" || !response.parsed_output)
        throw new Error(`no usable summary (stopped because: ${response.stop_reason})`);

    log("summary: 3/3 done");
    return { ok: true as const, count: lines.length, text: format(response.parsed_output, lines.length, from, to, trimmed) };
}
