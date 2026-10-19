# 🧵 Catch-Up Summariser

A Chat Hackers tool that notices when a group chat has had a burst of activity
and, once things calm down, posts a short summary so people who missed it can
catch up: the main points, what was decided, what's still open, and who's doing
what. Each point shows the time of the message it came from, so people can
scroll back and read the detail in the original words.

## How it works

1. **It notices a burst.** For every message it stores *when* it was sent (never
   what it said). A burst is when the last hour has at least **5× the group's
   usual busy hour**, and at least **30 messages**. "Usual" is the median of the
   group's hours that had any messages, over the last two weeks. Until the tool
   has 3 days of history it uses a fixed **100 messages in an hour**.
2. **It waits for the chat to calm down.** It summarises once there's been
   **15 minutes of quiet**, or after **3 hours** if the burst keeps going.
3. **It summarises.** It fetches that period's messages from the tool hub,
   leaves out the bot, commands, edits and anyone who opted out, strips quoted
   replies, phone numbers, emails and Matrix ids, and sends the rest to Claude
   (Haiku 5.5).
4. **It posts the summary in the group.** Only the summary is posted. Nothing
   that anyone wrote is stored by the tool. The next burst only counts messages
   after the last summary, so the same conversation isn't summarised twice.

Summaries are posted in the main group rather than a thread or a private
message, because WhatsApp and Signal don't have Matrix threads and the bot's
private messages don't reliably arrive.

## In the group

| | |
|---|---|
| `!catchup` | summary of the last 3 hours |
| `!catchup 6h`, `!catchup 30m` | summary of a chosen period, from 10 minutes up to 24 hours |
| `!catchup off` / `!catchup on` | stop or restart automatic summaries (on demand still works) |
| `!catchup status` | whether automatic summaries are on, and whether a burst is happening |
| `!catchup help` | the welcome message again |
| ❌ on any catch-up message | keep your messages out of summaries |
| ✅ on any catch-up message | include them again (only needed after opting out) |

`!catchup optout` / `optin` do the same as ❌ / ✅ for anyone who can't react.
On-demand summaries are limited to one every 10 minutes per group.

## Consent and privacy

- **Opting in is the group's choice.** Nothing happens until someone adds the
  tool to the group (⚙️, then ❤️ on Catch-Up Summariser). The hub then posts
  its introduction, and the tool posts a fuller welcome saying plainly that it
  reads the messages from busy periods and sends them to an AI.
- **Anyone can opt out**, by reacting ❌ to the welcome or any summary. Their
  messages are left out of every summary from then on. The tool confirms in
  the group.
- **Anyone can turn automatic summaries off** with `!catchup off`.
- **No message text is stored.** Only message times (deleted after 30 days) and
  opt-outs. Messages are fetched from the hub at summary time and discarded
  once the summary is made.

## Accuracy and fairness

Contentious discussions are where a bad summary does most harm, so Claude is
told to:

- describe views neutrally and in proportion ("some felt…, others…"),
- **never attach an opinion or disagreement to a named person**,
- only list something as *decided* if the group clearly agreed it, and treat
  anything unclear as an open question,
- add nothing that isn't in the messages, and not judge who was right.

Names only appear next to actions someone took on ("Ben: print 200 leaflets").
When views differed, the summary says so and points people to the originals.
Every summary ends with a reminder that it's AI-made and may miss nuance, with
times to scroll back to. If a conversation is too long for one request (about
100K tokens), the most recent part is summarised and the summary says so.

## Running it

```bash
npm install
cp .env.example .env   # fill in tool_url, hub_url, catchup_secret, ANTHROPIC_API_KEY
npm run dev            # builds, writes catchup.json, listens on 5066
npm test
```

Expose port 5066 with ngrok or a Cloudflare tunnel, put that URL in `tool_url`
before `npm run dev`, and send the generated `catchup.json` to whoever runs the
tool hub. The tool prints a line for every step (events arriving, bursts
starting and ending, summaries being made) so you can see what it's doing.

| Variable | What it does |
|---|---|
| `tool_url` | public URL of this tool, written into the registration |
| `hub_url` | tool hub base URL, for fetching messages at summary time |
| `catchup_secret` | the `secret` in the registration, needed to post summaries via `/api/send` |
| `ANTHROPIC_API_KEY` | for the summaries |
| `ANTHROPIC_WORKSPACE_ID` | only if the key isn't scoped to a workspace |
| `CATCHUP_MULTIPLIER` | a burst is this many times the usual busy hour (default `5`) |
| `CATCHUP_MINIMUM` | and at least this many messages in an hour (default `30`) |
| `CATCHUP_FALLBACK` | messages in an hour that count as a burst until there's 3 days of history (default `100`) |
| `CATCHUP_QUIET_MINUTES` | quiet minutes before summarising (default `15`) |
| `CATCHUP_MAX_HOURS` | summarise a burst after this long even if it's still going (default `3`) |
| `CATCHUP_TIME_ZONE` | time zone for the times in summaries (default `Europe/London`) |
| `PORT` | default `5066` |

## How it fits the tool hub

- Subscribes to `m.room.message`, `m.reaction` and `m.room.redaction`.
- `POST /` handles events and replies `{ success, response }`. Welcome and
  summary messages carry `context.catchupNotice`, so ❌ / ✅ reactions to them
  come back to the tool.
- Automatic summaries are posted with the hub's `POST /api/send`, and messages
  are read with `GET /api/room/history`.
- `GET /` is a short page explaining the tool.

## Known limits

- A burst in progress is held in memory, so if the tool restarts mid-burst
  that burst isn't summarised automatically (`!catchup` still works).
- Only text messages are summarised. Photos, voice notes and files are skipped.
