import "dotenv/config";
import express from "express";
import * as fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { MatrixEvent } from "../types";
import { handleCommand, handleReaction, isCommand, Reply, welcome } from "./commands";
import { addRoom, forgetOldTimes, getRoom, optInByReaction, startDuckDB } from "./db";
import { hubConfigured, TOOL_ID } from "./hub";
import { log } from "./log";
import { canSummarise } from "./summarise";
import { onMessage, setBotUser } from "./watcher";

const { catchup_secret, tool_url } = process.env;

const port = Number(process.env.PORT ?? 5066);
const DAY = 24 * 60 * 60 * 1000;

let botUserId: string | undefined = process.env.bot_user_id;

const moduleRegistration = {
  id: TOOL_ID,
  uuid: uuidv4(),
  url: tool_url || `http://localhost:${port}`,
  emoji: "🧵",
  introduction: "When the chat gets really busy, it posts a short AI summary once things calm down, so anyone who missed it can catch up. It reads the messages from the busy period to do this, but never stores them. Send !catchup for a summary on demand, or react ❌ to any catch-up message to keep your messages out.",
  title: "Catch-Up Summariser",
  description: "Posts a short summary after a burst of messages, so people who missed it can catch up",
  secret: catchup_secret,
  event_types: [
    "m.room.message", "m.reaction", "m.room.redaction"
  ]
}

function generateRegistrationFile() {
  fs.writeFileSync(`./${moduleRegistration.id}.json`, JSON.stringify(moduleRegistration, null, 2));
}

async function handleEvent(event: MatrixEvent): Promise<Reply | undefined> {
  if (event.type === "m.room.redaction") {
    const redacts = event.redacts ?? event.content?.redacts;
    if (redacts && await optInByReaction(event.room_id, redacts)) {
      log("  a ❌ was removed, so that person is back in");
      return "👍 Someone removed their ❌, so their messages may be included in catch-up summaries again.";
    }
    return;
  }

  if (event.type === "m.reaction") {
    if (event.prevEvent?.sender !== botUserId) return;
    log("  reaction to one of the bot's messages", { emoji: event.content?.["m.relates_to"]?.key });
    return await handleReaction(event);
  }

  if (event.type !== "m.room.message" || event.sender === botUserId) return;

  if (isCommand(event)) return await handleCommand(event, botUserId);

  // edits aren't new messages
  if (event.content?.["m.relates_to"]?.rel_type === "m.replace") return;

  await onMessage(event.room_id, event.event_id, event.origin_server_ts);
}

async function start() {
  const app = express();
  app.use(express.json());
  await startDuckDB();

  // message times are only needed to know what's normal for a room
  setInterval(() => forgetOldTimes(Date.now() - 30 * DAY), DAY);

  app.use((req, res, next) => {
    log(`request in: ${req.method} ${req.path}`);
    next();
  });

  app.get("/", (req, res) => {
    res.sendFile(path.resolve(__dirname, "../../public/index.html"));
  });

  app.post("/", async (req, res) => {
    const { event } = req.body ?? {};
    botUserId = req.body?.botUserId ?? botUserId;
    setBotUser(botUserId);

    if (!event?.room_id) {
      log("POST / arrived without an event, ignored");
      return res.status(400).send({ success: false, message: "no event" });
    }

    log("event arrived from the hub", { type: event.type, room: event.room_id, id: event.event_id });

    try {
      const isNewRoom = !await getRoom(event.room_id);
      if (isNewRoom) {
        await addRoom(event.room_id);
        log("  first event from this group, posting the welcome");
      }

      const reply = await handleEvent(event);
      const replies = [
        ...(isNewRoom && !isCommand(event) ? [{ message: welcome, context: { catchupNotice: true } }] : []),
        ...(reply ? [typeof reply === "string" ? { message: reply } : reply] : []),
      ];

      log(replies.length ? `  replying with ${replies.length} message(s)` : "  no reply");
      res.send({ success: true, response: replies.length ? replies : undefined });
    } catch (err) {
      log("  FAILED handling the event", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).send({ success: false, message: "error handling event" });
    }
  });

  app.listen(port, () => {
    log(`listening on port ${port}`);
    log("settings", {
      tool_url: tool_url || "NOT SET (hub can't reach you)",
      hub_url: process.env.hub_url || "NOT SET",
      catchup_secret: catchup_secret ? "set" : "NOT SET",
      claude: canSummarise() ? "set" : "NOT SET (no summaries)",
      hub_ready: hubConfigured(),
    });
  });
}

generateRegistrationFile();
start();
