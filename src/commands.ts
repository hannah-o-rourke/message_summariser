import { MatrixEvent } from "../types";
import { settings } from "./burst";
import { getRoom, isOptedOut, optIn, optOut, setAuto } from "./db";
import { log } from "./log";
import { canSummarise, MIN_MESSAGES, OPT_IN_EMOJIS, OPT_OUT_EMOJI, summarise } from "./summarise";
import { inBurst } from "./watcher";

const PREFIX = "!catchup";
const MINUTE = 60 * 1000;
const DEFAULT_PERIOD = 3 * 60 * MINUTE;
const LONGEST_PERIOD = 24 * 60 * MINUTE;
// stops on-demand summaries being run over and over
const ON_DEMAND_GAP = 10 * MINUTE;
const lastOnDemand = new Map<string, number>();

export type Reply = string | { message: string; context?: object };

export const welcome =
    "🧵 *This group now has the Catch-Up Summariser*\n\n" +
    "When the chat gets really busy, it posts a short summary once things calm down, so anyone who missed it can catch up: the main points, what was decided, what's still open, and who's doing what.\n\n" +
    "• To do that, it *reads the messages from the busy period* and sends them to an AI (Anthropic's Claude), with phone numbers and emails removed.\n" +
    "• It never stores what anyone writes. Only the summary is posted.\n" +
    "• It's told to be fair: views are never tied to names, and names are only used for who's doing what.\n\n" +
    "*What you can do:*\n" +
    "• Send *!catchup* for a summary of the last 3 hours (or *!catchup 6h*, *!catchup 30m*)\n" +
    `• React ${OPT_OUT_EMOJI} to this or any catch-up message to keep your messages out of summaries (✅ to come back in)\n` +
    "• Send *!catchup off* to stop automatic summaries, and *!catchup on* to start them again";

export function isCommand(event: MatrixEvent) {
    const body = event.content?.body;
    return event.type === "m.room.message" && typeof body === "string" && body.trim().toLowerCase().startsWith(PREFIX);
}

// "!catchup 6h" / "!catchup 90m" / "!catchup 2 hours" → milliseconds, or null
export function parsePeriod(text: string) {
    const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(text.trim());
    if (!match) return null;
    const amount = Number(match[1]) * (match[2].startsWith("m") ? MINUTE : 60 * MINUTE);
    return Math.min(LONGEST_PERIOD, Math.max(10 * MINUTE, amount));
}

function describePeriod(ms: number) {
    const minutes = Math.round(ms / MINUTE);
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.round(minutes / 6) / 10;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

async function onDemand(event: MatrixEvent, args: string, botUserId: string | undefined): Promise<Reply> {
    if (!canSummarise()) return "Sorry, summaries aren't set up on this server yet.";

    const period = args ? parsePeriod(args) : DEFAULT_PERIOD;
    if (period === null) return "Try *!catchup*, *!catchup 6h* or *!catchup 30m*.";

    const last = lastOnDemand.get(event.room_id) ?? 0;
    if (Date.now() - last < ON_DEMAND_GAP)
        return "A catch-up was made a few minutes ago. Scroll up to find it! 👆";
    lastOnDemand.set(event.room_id, Date.now());

    const to = event.origin_server_ts;
    try {
        const result = await summarise(event.room_id, to - period, to, botUserId);
        if (!result.ok)
            return `Only ${result.count} messages in the last ${describePeriod(period)}, so there's not much to catch up on. Easy enough to scroll! 👆`;
        return { message: result.text, context: { catchupNotice: true } };
    } catch (err) {
        lastOnDemand.delete(event.room_id);
        log("  on-demand summary FAILED", { error: err instanceof Error ? err.message : String(err) });
        return "Sorry, the summary didn't work this time. Please try again in a bit.";
    }
}

export async function handleCommand(event: MatrixEvent, botUserId: string | undefined): Promise<Reply> {
    const args = event.content.body.trim().slice(PREFIX.length).trim().toLowerCase();
    log("  command", { name: args.split(" ")[0] || "(summary)" });

    if (args === "help" || args === "?")
        return { message: welcome, context: { catchupNotice: true } };

    if (args === "off") {
        await setAuto(event.room_id, false);
        return "🧵 Automatic catch-ups are now *off* for this group. You can still send *!catchup* for one on demand, and *!catchup on* to turn them back on.";
    }

    if (args === "on") {
        await setAuto(event.room_id, true);
        return `🧵 Automatic catch-ups are now *on*. When the chat gets busy (at least ${settings.minimum} messages in an hour, and well above normal for this group), a summary will be posted once things calm down.`;
    }

    if (args === "optout" || args === "opt out") {
        await optOut(event.room_id, event.sender, null);
        return `✅ Done, ${event.displayname ?? "you"}. Your messages will be left out of catch-up summaries.`;
    }

    if (args === "optin" || args === "opt in") {
        await optIn(event.room_id, event.sender);
        return `✅ Thanks, ${event.displayname ?? "you"}. Your messages may be included in catch-up summaries again.`;
    }

    if (args === "status") {
        const room = await getRoom(event.room_id);
        return `🧵 Automatic catch-ups are *${room?.auto === false ? "off" : "on"}* here${inBurst(event.room_id) ? ", and the chat is busy right now, so one will follow when things calm down" : ""}.`;
    }

    return await onDemand(event, args, botUserId);
}

// ❌ / ✅ on the welcome or any catch-up summary. Confirmed in the group, because
// private messages don't reliably reach WhatsApp or Signal.
export async function handleReaction(event: MatrixEvent): Promise<Reply | undefined> {
    if (!event.prevEvent?.content?.context?.catchupNotice) return undefined;

    const emoji = event.content?.["m.relates_to"]?.key ?? "";
    const name = event.displayname ?? "you";

    if (emoji.includes(OPT_OUT_EMOJI)) {
        await optOut(event.room_id, event.sender, event.event_id);
        return `👍 Got it, ${name}. Your messages will be left out of catch-up summaries. If you change your mind, react ✅ to any catch-up message.`;
    }

    if (OPT_IN_EMOJIS.some(tick => emoji.includes(tick)) && await isOptedOut(event.room_id, event.sender)) {
        await optIn(event.room_id, event.sender);
        return `👍 Thanks, ${name}. Your messages may be included in catch-up summaries again.`;
    }

    return undefined;
}

export { MIN_MESSAGES };
