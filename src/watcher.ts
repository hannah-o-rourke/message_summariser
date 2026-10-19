import { detectBurst, HISTORY_DAYS, maxBurstLength, quietFor } from "./burst";
import { getRoom, messageTimes, recordMessage, setLastSummaryTo } from "./db";
import { sendToGroup } from "./hub";
import { log } from "./log";
import { canSummarise, summarise } from "./summarise";

const DAY = 24 * 60 * 60 * 1000;

// Rooms currently in a burst, waiting for the chat to go quiet. Kept in memory:
// a restart mid-burst just means that burst isn't summarised automatically.
const bursts = new Map<string, { start: number; last: number; timer: NodeJS.Timeout }>();

let botUserId: string | undefined;

export function setBotUser(id: string | undefined) {
    if (id) botUserId = id;
}

export function inBurst(roomId: string) {
    return bursts.has(roomId);
}

async function finishBurst(roomId: string) {
    const burst = bursts.get(roomId);
    bursts.delete(roomId);
    if (!burst) return;

    log("burst over, summarising", { room: roomId, minutes: Math.round((burst.last - burst.start) / 60000) });
    try {
        const result = await summarise(roomId, burst.start, burst.last, botUserId);
        if (!result.ok) {
            log("  not enough messages to summarise after leaving out opt-outs", { count: result.count });
            return;
        }
        await sendToGroup(roomId, result.text, { catchupNotice: true });
        await setLastSummaryTo(roomId, burst.last);
    } catch (err) {
        log("  automatic summary FAILED", { error: err instanceof Error ? err.message : String(err) });
    }
}

function waitForQuiet(roomId: string, start: number, last: number) {
    const existing = bursts.get(roomId);
    if (existing) clearTimeout(existing.timer);

    // a burst that runs on and on is summarised at the cap rather than never
    const delay = last - start >= maxBurstLength() ? 0 : quietFor();
    const timer = setTimeout(() => finishBurst(roomId), delay);
    bursts.set(roomId, { start, last, timer });
}

// Called for every message: records when it was sent, and starts or extends a
// burst. Summaries only cover messages after the last one, so the same
// conversation isn't summarised twice.
export async function onMessage(roomId: string, eventId: string, ts: number) {
    await recordMessage(roomId, eventId, ts);

    const burst = bursts.get(roomId);
    if (burst) {
        waitForQuiet(roomId, burst.start, Math.max(burst.last, ts));
        return;
    }

    const room = await getRoom(roomId);
    if (!room?.auto || !canSummarise()) return;

    const times = await messageTimes(roomId, Date.now() - HISTORY_DAYS * DAY);
    const check = detectBurst(times, Date.now(), room.lastSummaryTo + 1);
    if (!check.isBurst) return;

    log("burst started", { room: roomId, last_hour: check.count, threshold: check.threshold, usual_busy_hour: check.usual ?? "not known yet" });
    waitForQuiet(roomId, check.start, ts);
}
