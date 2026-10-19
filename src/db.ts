import { DuckDBConnection, DuckDBInstance, DuckDBValue } from "@duckdb/node-api";
import path from "node:path";

let connection: DuckDBConnection;

async function rows(sql: string, values: DuckDBValue[] = []) {
    const reader = await connection.runAndReadAll(sql, values);
    return reader.getRowObjectsJS();
}

// Timestamps are DOUBLE and bound as strings, because a bound JS number is
// taken as a 32-bit INTEGER and millisecond timestamps overflow it.
export async function startDuckDB(fileName = "catchup_duckdb.db") {
    const dataDir = process.env.DUCKDB_DATA_DIR ?? path.resolve(__dirname, "../..");
    const instance = await DuckDBInstance.create(fileName === ":memory:" ? fileName : path.join(dataDir, fileName));
    connection = await instance.connect();

    // only when messages were sent, to spot bursts: never what they said
    await connection.run(`CREATE TABLE IF NOT EXISTS MessageTimes (
        room_id VARCHAR,
        event_id VARCHAR,
        ts DOUBLE,
        PRIMARY KEY (room_id, event_id)
    );`);
    await connection.run(`CREATE TABLE IF NOT EXISTS Rooms (
        room_id VARCHAR PRIMARY KEY,
        auto BOOLEAN,
        last_summary_to DOUBLE
    );`);
    // via_event_id is the ❌ reaction that opted someone out, so removing it opts them back in
    await connection.run(`CREATE TABLE IF NOT EXISTS OptOuts (
        room_id VARCHAR,
        sender VARCHAR,
        via_event_id VARCHAR,
        PRIMARY KEY (room_id, sender)
    );`);
}

export async function recordMessage(roomId: string, eventId: string, ts: number) {
    await connection.run(`INSERT OR IGNORE INTO MessageTimes VALUES ($1, $2, $3::DOUBLE);`, [roomId, eventId, String(ts)]);
}

export async function messageTimes(roomId: string, since: number) {
    const found = await rows(`SELECT ts FROM MessageTimes WHERE room_id = $1 AND ts >= $2::DOUBLE ORDER BY ts;`, [roomId, String(since)]);
    return found.map(r => r.ts as number);
}

export async function forgetOldTimes(before: number) {
    await connection.run(`DELETE FROM MessageTimes WHERE ts < $1::DOUBLE;`, [String(before)]);
}

export async function getRoom(roomId: string) {
    const [found] = await rows(`SELECT auto, last_summary_to FROM Rooms WHERE room_id = $1;`, [roomId]);
    return found ? { auto: Boolean(found.auto), lastSummaryTo: (found.last_summary_to as number | null) ?? 0 } : undefined;
}

export async function addRoom(roomId: string) {
    await connection.run(`INSERT OR IGNORE INTO Rooms VALUES ($1, true, 0::DOUBLE);`, [roomId]);
}

export async function setAuto(roomId: string, auto: boolean) {
    await connection.run(`UPDATE Rooms SET auto = $2 WHERE room_id = $1;`, [roomId, auto]);
}

export async function setLastSummaryTo(roomId: string, ts: number) {
    await connection.run(`UPDATE Rooms SET last_summary_to = $2::DOUBLE WHERE room_id = $1;`, [roomId, String(ts)]);
}

export async function optOut(roomId: string, sender: string, viaEventId: string | null) {
    await connection.run(`INSERT OR REPLACE INTO OptOuts VALUES ($1, $2, $3);`, [roomId, sender, viaEventId]);
}

export async function optIn(roomId: string, sender: string) {
    await connection.run(`DELETE FROM OptOuts WHERE room_id = $1 AND sender = $2;`, [roomId, sender]);
}

export async function isOptedOut(roomId: string, sender: string) {
    return (await rows(`SELECT 1 FROM OptOuts WHERE room_id = $1 AND sender = $2;`, [roomId, sender])).length > 0;
}

export async function optedOutSenders(roomId: string) {
    return new Set((await rows(`SELECT sender FROM OptOuts WHERE room_id = $1;`, [roomId])).map(r => r.sender as string));
}

// a removed ❌ reaction arrives as a redaction of the reaction event
export async function optInByReaction(roomId: string, reactionEventId: string) {
    const [found] = await rows(`SELECT sender FROM OptOuts WHERE room_id = $1 AND via_event_id = $2;`, [roomId, reactionEventId]);
    if (!found) return null;
    await optIn(roomId, found.sender as string);
    return found.sender as string;
}
