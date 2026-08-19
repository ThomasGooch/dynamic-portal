# Demo runbook

Twenty to thirty minutes, for a room that controls budget. The ask at the end
is a pilot: two or three real solutions, one quarter.

Every claim below has been run. Where something is unproven or fragile it says
so — a demo that oversells is worse than a shorter one, because the first
question afterwards is usually the one you dodged.

---

## Before the room

```bash
docker compose up -d --build            # ~2 minutes cold, ~20 seconds warm
open http://localhost:3000
```

Four services must be `healthy`:

```bash
docker compose ps --format "{{.Service}} {{.Health}}"
```

**Reset between rehearsals.** Satellites hold state in memory, so orders you
create and files you attach persist until the container restarts:

```bash
docker compose restart satellite-orders satellite-fleet satellite-depots
```

**Decide the model before you start.** The assistant beats need one:

| | Setup | Composition | Notes |
|---|---|---|---|
| Hosted | `ANTHROPIC_API_KEY` in `.env` | ~12 s | What to use in the room |
| Local | `PORTAL_MODEL_PROVIDER=ollama` | does not work | Free; six of seven assistant tests pass |

Screen composition — beat 6 — **needs the hosted model**. On a local 7B it runs
out of turns rather than composing. If the key is dead or the venue's network
is unreliable, cut beat 6 and say why; do not let it fail live.

---

## The spine

### 1 · One portal, three solutions (1 min)

Open `/`. Click **Orders**, then **Fleet**, then **Depots**.

> "Three solutions, one portal. Same shell, same table, same badges."

Copy the URL of a detail screen, paste it in a new tab, hit back. It all works
— these are real routes, not an iframe.

### 2 · Where is the JavaScript? (2 min) — *kills version-and-dependency hell*

> "Fleet is Python. Depots is C#. Neither ships a line of JavaScript or a byte
> of CSS. There is no shared React version to fight over, because satellites
> send **data**, not code."

That is the difference from the last attempt, and it is structural rather than
a promise.

### 3 · The authoring moment (4 min) — *kills coordination cost*

Show `apps/satellite-depots/src/Satellite.Depots/Screens.cs`. It is a few
dozen lines and it produces the whole Depots dashboard.

Then edit `config/satellites.yaml` — change a `displayName` — and
`docker compose restart hub`. New portal, ~15 seconds, **no hub deploy, no
satellite deploy**.

> The registry is mounted into the hub rather than baked into its image. It has
> to be: with `COPY . .` the container re-read its own stale copy and the edit
> did nothing, which quietly falsified this beat. There is a test for the mount
> now, because this is the claim the pilot rests on.

> "Adding or changing a screen costs zero hub deployments. That is the number
> to hold me to."

**If you can, hand someone the keyboard.** A person who has never seen the code
adding a column is worth more than watching you type. Rehearse the undo.

### 4 · A real form (4 min) — *the objection you will actually get*

**Orders → New order.**

- Type a bad email → the error lands **on the field**, not as a banner.
- Tick **Expedite** → a reason box appears. Untick → it goes.
- Choose the **hazmat** label → a handling-notes box appears.
- Set priority **critical**, leave Expedite clear, submit → *"Critical orders
  are expedited."*

> "That last rule is not something a single field can express, and every real
> form has rules like it. The satellite sent `{field, equals}` — data, not code.
> The hub evaluated it. And the server enforces the rule regardless: hiding a
> field is presentation, and the satellite does not believe the browser."

Then open an order → **Documents** → attach a PDF. Bytes cross the hub to the
satellite, which records what arrived.

### 5 · Blast radius (2 min) — *the risk question, answered before it is asked*

```bash
docker compose stop satellite-fleet
```

Reload the portal. Fleet shows a scoped error card; Orders and Depots are
untouched; navigation still works.

```bash
docker compose start satellite-fleet
```

> "One solution failing is one card. That got **better**. The hub failing is
> new, and it is the trade we would be asking you to fund."

Have the availability slide ready — it is the strongest argument against this
and they will find it without you.

### 6 · The assistant (5 min) — *needs the hosted model*

Return to `/`. The launcher renders instantly; below it, **Needs attention**
fills in — a screen composed across all three solutions, with the tool calls it
came from named on it.

> "No satellite could have produced that view, because no satellite can see the
> others. Nobody maintains it. Every number on it traces to a tool call."

Then open the assistant and ask it to approve an order. It **pauses** and the
hub draws a confirmation card.

> "The model proposes; a person decides. Deletion it is not offered at all —
> that is a line in a config file a human reviews, not a prompt."

### 7 · The ask (3 min)

Two or three named solutions, one quarter, and the platform team writes the
first screen for each. That last clause turns "will teams adopt?" from a hope
into a commitment, and it is cheap at this size.

---

## If something breaks

| Symptom | Cause | Do this |
|---|---|---|
| Assistant says it could not complete | No API credit, or model unreachable | Skip to beat 7; the deterministic portal is unaffected |
| A screen shows an error card | That satellite is stopped | `docker compose start satellite-<name>` |
| Form shows stale data | In-memory state from a rehearsal | `docker compose restart satellite-orders` |
| Home never fills in | Composition failed | Say so and move on — the launcher is a complete page |

**Do not** run `docker compose down -v` in the room. It removes volumes and the
next `up` is a two-minute cold build.

---

## What to say if asked

**"Is this micro-frontends again?"** No. Satellites send JSON validated against
a fixed vocabulary. Nothing they send is executed. The failure mode you had —
version coupling between teams — is absent by construction, not by discipline.

**"What if a solution needs something the vocabulary lacks?"** Then the platform
team adds it, additively, and every satellite keeps working. The rule is that a
new component needs demand from more than one team. There is an escape hatch —
a registered full-page iframe — and it is deliberately unattractive.

**"What does this cost?"** A permanent platform function. If it is defunded in
year three, the catalog stops evolving and teams take the escape hatch, and you
are back to the portal this replaced. That risk is organisational; no
architecture removes it.

**"Can we see it fail?"** Yes — beat 5 is exactly that, and it is in the demo
deliberately.
