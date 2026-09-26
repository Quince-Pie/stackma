# What literal universal optimality would require

The follow-up request on 2026-09-26 explicitly asks for universal optimality.
That is stronger than the earlier scoped qualification. Treat it literally:
one feasible implementation would have to be no worse than **every** feasible
alternative, on every objective separately, for every permitted history. No
weights, averaging across histories, or exclusion of slow reviews is supplied.

There is an impossibility result for the release flow's declared API-call and
controlled-latency objectives. It is stronger than observing that two programs
trade one objective for another: the argument below excludes any third program
that supposedly dominates both relevant families.

## Model and correspondence to the platform

Use two minimized coordinates of the original objective set:

- **C:** total controller-initiated external HTTP/API requests for the complete
  release, including preparation, submission, observation and final verification;
- **L:** controlled time from AMO's public approval to fully verified GitHub
  publication. Mozilla's review duration is excluded from L.

Other objectives, including CI use, remain separate. Dominating all of them would
necessarily dominate these two. A comparator is allowed to spend more CI time;
that does not remove the obligation to match its request count.

Consider the admissible subclass with a fixed valid package/source, available
locked tools, successful prompt API responses, delivered scheduled runs, and an
unknown finite approval time T. There is no timely unsolicited approval signal.
The controller must obtain authoritative approval evidence before publication.
All observations cost at least one request. Neither implementation can know T
before observing it. This is an online information constraint, not a restriction
to the delivered source code or one particular polling implementation.

This subclass is supported by the current interfaces:

- Mozilla documents potentially long [manual review](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/#post-submission-review)
  without a finite upper bound. Its [version API](https://mozilla.github.io/addons-server/topics/api/addons.html#version-detail)
  exposes point status queries.
- Documented [email notifications](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
  have no bounded delivery promise. Histories where mail arrives after the
  required observation are therefore not excluded. The documented
  [scanner webhooks](https://mozilla.github.io/addons-server/topics/development/scanner_pipeline.html#adding-a-scanner-webhook)
  require Mozilla administrative registration and are not an author-accessible
  approval callback.
- GitHub permits [delayed or dropped schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
  The proof uses delivered schedules and continuing repository activity, which
  are possible histories; it does not assume a universal scheduling SLA.

Observation date: 2026-09-26. The Mozilla mechanisms were corroborated at deployed
addons-server `c03d3c661bdbe22bb8f4a52fc46d63668bb31751`. A future guaranteed timely
callback would change the model and require re-analysis.

## Why no third implementation can dominate

1. A feasible fast control F polls every p time units. On the subclass above,
   its complete work after detection takes at most some finite B. Thus its
   controlled completion delay is at most **D = p + B**. B includes signature,
   installation, publication and final verification work; none is hidden outside
   the comparison.
2. A proposed universal dominator U must finish within D after **every** possible
   approval time. It cannot finish safely before observing approval.
3. Follow U while every observation still says pending. If U leaves a silent
   observation gap longer than D, choose an approval immediately after its last
   observation in that gap. Until its next observation, this approved history
   and the still-pending history are indistinguishable to U. It cannot safely
   publish by the fast control's deadline. Therefore U must keep observing with
   gaps at most D throughout an arbitrarily long pending interval.
4. Consequently, before a sufficiently late approval T, U has spent at least
   **floor(T / D) - 1** observation calls. This count grows without bound even
   if U eliminates **all** other preparation, build, transfer and publication
   calls. Saving a fixed amount elsewhere cannot remove it.
5. For each late time H, another feasible control S_H performs its fixed
   preparation/submission work, delays its first approval observation until H,
   then completes the same reliable publication protocol. If approval has not
   happened, it continues ordinary bounded polling. For approval just before H,
   its whole-release request count is a finite constant **C₀**, independent of
   H. This includes every setup and completion request, not just the last poll.
6. Choose H large enough that U's required observation count exceeds C₀. U now
   loses the service-call objective to S_H. It therefore cannot dominate all
   feasible controls while also matching F's latency.

S_H does not require an H-long hosted job. Scheduled tiny jobs can inspect their
local clock and exit before checkout or provider API calls until H. Those wakeups
consume CI resources. That may make S_H unattractive in practice, but it remains
a feasible counterexample for a universal winner that must also beat its request
count. A hard latency requirement could exclude it; this task supplies none.

This is a covering argument over arbitrary causal implementations in the stated
model. It does not depend on the current coordinator's structure, and does not
infer impossibility merely from two observed incomparable programs.

## Randomization and scope limits

Pathwise or latency-tail dominance over the deterministic fast control still
requires the same deadline almost surely. Randomization cannot remove the count.
Even if only expected latency and expected calls were compared, expected delay
at most D implies, by Markov's inequality, at least a one-half probability of
an observation in every disjoint interval of length 2D. The identical pending
prefix therefore gives expected observation count at least approximately T/(4D).
This still eventually exceeds fixed C₀; independence between intervals is not
required for linearity of expectation.

The cost coordinate counts requests initiated by the release controller. It does
not purport to measure hidden requests inside GitHub's infrastructure. If that
different physical cost definition is required, the constant-C₀ argument needs
additional bounds; those have not been measured. Likewise, a guaranteed free
timely notification, a declared finite review horizon, or a hard latency limit
excluding delayed observation could invalidate this particular construction.

The conclusion is consequently precise:

- **Universal componentwise dominance is impossible in the stated model that
  includes the actual release controller's API-call/latency tradeoff.**
- An unrestricted claim about every possible program, platform and physical
  cost remains unestablished. This model theorem must not be sold as that claim.
- The proof does not certify the delivered design as Pareto-optimal, fastest,
  cheapest, or uniquely best. Its engineering qualification remains the separate
  evidence in [release design](release-design.md).
- Successful hosted acceptance would establish exercised publication and update
  behavior. It cannot turn this incompatible universal objective into a true
  claim.
