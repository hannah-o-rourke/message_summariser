const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const settings = {
    // a burst is this many times the room's usual busy hour...
    multiplier: Number(process.env.CATCHUP_MULTIPLIER ?? 5),
    // ...but never fewer than this many messages in an hour
    minimum: Number(process.env.CATCHUP_MINIMUM ?? 30),
    // used until there's enough history to know what's normal for the room
    fallback: Number(process.env.CATCHUP_FALLBACK ?? 100),
    // how long the chat has to go quiet before the burst is summarised
    quietMinutes: Number(process.env.CATCHUP_QUIET_MINUTES ?? 15),
    // a burst that keeps going is summarised after this long anyway
    maxHours: Number(process.env.CATCHUP_MAX_HOURS ?? 3),
};

export const HISTORY_DAYS = 14;
const MIN_HISTORY_DAYS = 3;

function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// How many messages in an hour counts as a burst for this room. "Usual" is the
// median of the room's hours that had any messages at all, over the last two
// weeks, not counting the last hour.
export function burstThreshold(times: number[], now: number) {
    const history = times.filter(t => t < now - HOUR && t >= now - HISTORY_DAYS * DAY);
    const oldest = history.reduce((min, t) => Math.min(min, t), Infinity);
    if (!history.length || now - oldest < MIN_HISTORY_DAYS * DAY)
        return { threshold: settings.fallback, usual: null };

    const perHour = new Map<number, number>();
    for (const t of history) {
        const hour = Math.floor(t / HOUR);
        perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }
    const usual = median([...perHour.values()]);
    return { threshold: Math.max(settings.minimum, Math.ceil(usual * settings.multiplier)), usual };
}

// Whether the last hour of messages makes a burst, and if so where it began:
// the first message in that hour. Messages before countFrom (the end of the
// last summary) don't count towards a new burst, but do count towards what's
// usual for the room.
export function detectBurst(times: number[], now: number, countFrom = 0) {
    const lastHour = times.filter(t => t >= Math.max(now - HOUR, countFrom) && t <= now);
    const { threshold, usual } = burstThreshold(times, now);
    return {
        isBurst: lastHour.length >= threshold,
        start: lastHour.length ? Math.min(...lastHour) : now,
        count: lastHour.length,
        threshold,
        usual,
    };
}

export function quietFor() {
    return settings.quietMinutes * MINUTE;
}

export function maxBurstLength() {
    return settings.maxHours * HOUR;
}
