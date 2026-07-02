# Website Handoff: Agent Status Feed

This note is for the agent building the personal website UI that shows the live status and recent activity of the agent.

## Goal and Product Intent

The website should present the agent as a real system with observable work, not as a chat demo.

The feed is intentionally:

- public-safe
- read-only
- low-cost
- eventually consistent

It is not a raw runtime log stream. It is a curated public activity layer derived from internal agent events.

The UI should communicate:

- what the agent is doing right now
- what kinds of tasks it has done recently
- that deployments and background activity are real

The UI should not imply:

- full internal trace visibility
- exact progress percentages
- guaranteed real-time delivery
- that users can control or inspect private task contents

## Public Endpoints

Base URLs are exposed from the public status surface (for example a Cloudflare Worker):

- `https://<public-status-host>/current.json`
- `https://<public-status-host>/events.json`

These are the only intended website-facing status APIs for now.

Do not read the bridge database.
Do not read container logs.
Do not infer status from unrelated endpoints.

## API Semantics

### `current.json`

Purpose:

- a snapshot of the current public state
- optimized for hero/header/status badge usage

It is not a history feed.
It always represents the latest known public state only.

Example shape:

```json
{
  "status": "idle",
  "title": "Agent idle",
  "summary": "optional",
  "updatedAt": "2026-05-27T03:14:31.400Z",
  "activeCount": 0,
  "stats": {
    "tasksHandled": 42,
    "tasksCompleted": 36,
    "tasksFailed": 6
  },
  "source": "gmail",
  "taskType": "research"
}
```

Field meaning:

- `status`
  Human-facing machine state for the current snapshot.
  Use for badge color/state grouping.

- `title`
  The main public label to render.
  Safe to show directly.

- `summary`
  Optional short secondary description.
  May be absent.

- `updatedAt`
  Timestamp of the current snapshot, not page fetch time.

- `activeCount`
  Number of currently active public tasks tracked by the publisher.
  Today this is usually `0` or `1`.

- `stats`
  Cumulative public task counters persisted across restarts/deploys.

- `stats.tasksHandled`
  Total public tasks that reached a terminal state.
  This means `completed + failed`.

- `stats.tasksCompleted`
  Total public tasks that completed successfully.

- `stats.tasksFailed`
  Total public tasks that ended in failure.

- `source`
  Optional origin of the currently active/latest task:
  `gmail`, `scheduler`, or `workflow`.

- `taskType`
  Optional coarse public task classification.

Recommended UI use:

- primary live status card
- "last updated" label
- source/task type chip
- KPI cards such as total tasks handled

### `events.json`

Purpose:

- recent public activity history
- optimized for an activity timeline/feed

Example shape:

```json
{
  "updatedAt": "2026-05-27T03:14:31.401Z",
  "events": [
    {
      "id": "task_started-...",
      "ts": "2026-05-27T03:08:37.026Z",
      "type": "task_started",
      "status": "running",
      "title": "Task started",
      "summary": "optional",
      "source": "gmail",
      "taskType": "research",
      "skillName": "web-access",
      "durationMs": 123456,
      "commitSha": "abc123...",
      "runId": "123456789",
      "actor": "hcsum"
    }
  ],
  "meta": {
    "deploymentFingerprint": "..."
  }
}
```

Field meaning:

- `updatedAt`
  Timestamp when the events file itself was last written.

- `events`
  Append-only recent event window.
  Order is oldest to newest.
  Render newest last or reverse on the frontend if desired.

- `meta.deploymentFingerprint`
  Internal dedupe marker.
  Frontend usually does not need to display this.

## Event Types and Intended Meaning

These are not arbitrary log lines. Each type has public meaning.

- `deployment`
  A new deployed version started and recorded itself.
  Good for a "site + agent are actively maintained" signal.

- `agent_idle`
  No active public task is currently running.

- `task_received`
  A new public task entered the system.

- `task_queued`
  The task is accepted and waiting for execution.

- `task_started`
  The task has actually started executing.

- `skill_loaded`
  A public-safe whitelisted skill was loaded.
  This is intentional showcase data, not a private tool trace.

- `research_started`
  The agent has entered a research/gathering phase.

- `web_data_started`
  The agent has started collecting data from the web.

- `draft_started`
  The agent is composing the final answer/output.

- `knowledge_update_started`
  The agent is writing into or updating the knowledge system.

- `scheduled_report_started`
  A scheduler-driven task has started preparing output.

- `report_delivered`
  The final result email/output was delivered.

- `task_completed`
  The task completed successfully.

- `task_failed`
  The task ended unsuccessfully.
  Failure summaries are intentionally sanitized and high-level.

## Status Field Semantics

Current public statuses include values such as:

- `deployment`
- `idle`
- `received`
- `queued`
- `running`
- `researching`
- `drafting`
- `knowledge`
- `delivered`
- `completed`
- `failed`

Frontend guidance:

- treat them as public presentation states, not internal state machine truth
- use them for color/icon grouping
- do not build brittle logic that assumes one strict transition graph

## Task Classification Semantics

`taskType` is intentionally coarse.

Known values include:

- `research`
- `email-task`
- `morning-report`
- `scheduled-report`
- `scheduled-task`
- `knowledge-ingest`
- `knowledge-query`
- `knowledge-lint`
- `knowledge-task`

This field is useful for:

- filtering chips
- icon families
- small grouping in the timeline

It is not a stable analytics taxonomy yet.

## Important Data Interpretation Rules

1. `current.json` is the truth for "what is current now".
   Do not derive current state from the last item in `events.json` if `current.json` is available.

2. `current.json.stats` is the truth for cumulative handled-task counts.
   Do not derive totals from `events.json`, because `events.json` is only a bounded recent window.

3. `events.json` is a recent window, not a permanent archive.
   The publisher keeps only the latest bounded event list.

4. Events now persist across deploys.
   A deploy should not wipe the recent feed.

5. A `deployment` event is expected after deploy.
   This is intentional and should usually be shown.

6. Titles are already public-safe.
   The frontend can display them directly.

7. Summaries are optional.
   The UI must handle missing `summary`.

8. Timestamps are UTC ISO strings.
   Convert in the frontend for user-facing display.

9. The feed is eventually consistent.
   A task may still be running even if no new event has appeared for a short period.

## Recommended Frontend Behavior

- Poll both endpoints every `10s` to `30s`.
- Fetch `current.json` and `events.json` independently.
- If one request fails, keep old data and mark the UI as stale.
- Show a clear "last updated" timestamp.
- Prefer subtle activity/timeline UI over raw log aesthetics.
- Treat this as an ambient system status surface, not a debugger.

## Recommended Sections on the Website

### 1. Live Status

Use `current.json`.

Suggested fields to show:

- status badge
- title
- optional summary
- total tasks handled
- total completed
- total failed
- source
- task type
- last updated

### 2. Recent Activity

Use `events.json`.

Suggested fields per event:

- event title
- local timestamp
- small status chip
- optional summary

### 3. Deployment Signal

Show `deployment` events as first-class timeline entries.
This makes the agent feel alive and maintained.

## Things the Website Should Not Do

- do not expose internal error strings beyond provided `summary`
- do not infer private prompts or email contents
- do not claim exact execution percentages
- do not treat missing recent events as proof of failure
- do not depend on hidden/internal event IDs or deployment fingerprints

## Known Limitations

- `taskType` / `publicTitle` classification is heuristic and still somewhat coarse
- the feed is optimized for showcase, not debugging
- some long-running tasks may appear quiet between events
- scheduled-task reply semantics are not yet first-class conversation semantics

## Short Version for Implementation

If you only remember five things:

1. `current.json` is the live snapshot.
2. `events.json` is the recent timeline.
3. Titles and summaries are safe to render directly.
4. Poll; do not expect push.
5. This is a public activity feed, not raw logs.
