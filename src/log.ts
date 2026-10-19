// One line per step, so you can follow an event through the tool in the
// terminal. Never pass message text in here, only what kind of thing it was.
export function log(step: string, details: object = {}) {
    const time = new Date().toISOString().slice(11, 19);
    const extra = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
    console.log(`[catchup ${time}] ${step}${extra ? ` | ${extra}` : ""}`);
}
