# Ideas

Parking lot for bigger product directions. Roughly ordered by conviction.

## 1. The Delegate column — drag a card, the work happens

A column role beyond `active`/`done`: anything dropped into a `delegate`
column gets picked up automatically — session spawned with the task as the
prompt, agent works it, PR opened, card flows to "In review" on its own.
A concurrency cap ("run at most 2 agents") turns the board into a dispatch
queue for the agent fleet: triage in the morning by dragging, cards come
back as pull requests. Every piece exists already: SetupManager-style
background pipelines, autofix, PR tracking, column roles.

## 2. The agent files tasks back

Expose the board to the agent (MCP tool or slash command) so it can file
follow-ups mid-session: "this refactor also needs X — added to your board",
with context of where it found it (files, branch, linked session). The board
accumulates the debt the fleet *discovers while working* — shared memory
between the user and the agents.

## 3. AI breakdown with repo context

A "Break down" action on a card: the agent reads the actual repo (reuse
`collect_repo_context`) and splits the task into subtasks, each tagged
agent-doable or needs-human, with the files it expects to touch. Vague card
in, executable plan out.

## 4. Cards that tell you what happened

Each card links a session — go further: token/turn/duration cost per task,
PR diff stat, a one-line AI summary of the work. "My work" on Monday morning
reads like a standup from the fleet: what shipped, what's blocked on you,
what each task cost.

## 5. Capture anywhere, wake up to PRs

The planned branchlab.dev task sync turns the board into a remote control:
file a task from a phone into the Delegate column; the Mac at home has a PR
waiting before you're back. (Sync-ready store shipped with the board: ULID
ids, `updated_at` LWW keys, tombstones, self-contained `tasks.json`.)

Sequencing take: #1 is the moat, #2 makes it self-feeding, #5 makes it a
story people retell; #3/#4 are strong garnish.
