# In-flight pill limited to backgrounded work, not subagents

Settled a recurring ask: the live "in flight" pill CANNOT reliably count subagents specifically. A
foreground Task/Agent subagent (e.g. an `Explore` review) fires SubagentStart/Stop but never enters Claude
Code's `background_tasks` registry (verified via a temporary emit.js capture: bg_tasks=0 throughout its
run), and the start/stop counter drifts on dropped Stops. The registry holds only BACKGROUNDED work —
Workflows (`type:"workflow"`) + run_in_background shells — which is exactly what bgTasks / the pill already
show. Registry elements DO carry a `type`/`status` discriminator, so a future per-type breakdown
("1 workflow") is possible — but it still can't see Task subagents. Don't re-attempt from these signals.

<!-- entry 39 -->
