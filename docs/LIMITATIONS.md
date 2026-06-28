# Limitations

These are inherent to agent-time verification and are stated honestly:

- **Coverage.** An agent can install without calling the tool; the postinstall-runs-on-install window can't be fully closed from inside the agent loop. The pre-commit hook is the backstop.
- **False negatives at the edges.** A brand-new squat not yet in OSV, and one whose name isn't close to a known package, can slip to `yellow` rather than `red`. (Two such cases remain in the eval.)
- **The axios problem.** A *legitimate* package with a brief past compromise (specific bad versions) is kept `green` by name — which means a brandsquat that is structurally identical to such an incident can also pass. This is a deliberate trade-off favoring zero false positives on real packages.
- **Adversarial signals.** Age, downloads, and provenance can be faked or aged before weaponizing.
- **Transitive blind spot.** Nested dependencies are never typed by the agent, so the agent-time advantage doesn't reach them.
