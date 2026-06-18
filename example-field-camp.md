# Seasonal Field Camp — Duty Rota Specification
## June 2027

A seasonal wildlife-monitoring field camp runs daily dawn surveys along a set of survey routes during the active season. This rota covers **June 1–30, 2027**. Compute and constraint-solving run client-side; this document specifies people, attributes, shift types, and constraints for the ILP. It is a generic, multi-shift seasonal-camp scenario kept around as a realistic stress test for the solver.

---

## 1. People

### Attributes (roles / flags)

- **survey leader** — qualified to lead a morning survey team
- **camp leader** — camp leadership
- **presenter** — can hold public talks
- **german**, **english**, **french**, **greek**, **italian** — spoken languages
- **driver** — holds a driving licence

### Leaders (2) — arrived May 2027, no end date

| Name | Start | End | Attributes |
|---|---|---|---|
| Maria Konstantinou | 2027-05-10 | — | camp leader, survey leader, presenter, greek, english, german, driver |
| Lukas Brandt | 2027-05-15 | — | camp leader, survey leader, presenter, german, english, french, driver |

### Volunteers (18) — staggered start/end, 1–3 month stays

| Name | Start | End | Attributes |
|---|---|---|---|
| Sofia Müller | 2027-05-01 | 2027-06-15 | survey leader, presenter, german, english, driver |
| Thomas Weber | 2027-05-15 | 2027-07-31 | survey leader, english, german, driver |
| Elena Rossi | 2027-05-20 | 2027-06-20 | presenter, english, french, italian |
| James Carter | 2027-06-01 | 2027-08-31 | english, driver |
| Camille Dubois | 2027-06-01 | 2027-07-15 | presenter, french, english |
| Anna Schmidt | 2027-05-10 | 2027-06-30 | survey leader, german, english, driver |
| Yiannis Pappas | 2027-05-25 | 2027-08-25 | greek, english, driver |
| Laura Bianchi | 2027-06-05 | 2027-09-05 | english, french |
| Max Fischer | 2027-06-10 | 2027-07-10 | german, english, driver |
| Chloé Martin | 2027-05-20 | 2027-06-18 | presenter, french, english, driver |
| David Jones | 2027-06-01 | 2027-07-31 | english, driver |
| Nadia Hofmann | 2027-06-12 | 2027-09-12 | survey leader, german, english |
| Petros Nikolaou | 2027-05-30 | 2027-06-28 | greek, english, driver |
| Sarah Klein | 2027-06-08 | 2027-08-08 | german, english |
| Marco Conti | 2027-06-15 | 2027-09-15 | english, italian, driver |
| Hannah Vogel | 2027-05-12 | 2027-08-15 | survey leader, presenter, german, english |
| Paolo Greco | 2027-05-18 | 2027-09-30 | survey leader, presenter, italian, english, driver |
| Sandrine Leroy | 2027-05-22 | 2027-07-20 | survey leader, presenter, french, english |

Realistic flux: Sofia, Chloé, Elena, Petros, Anna leave mid/late June; James, Camille, David start June 1; Laura, Max, Nadia, Sarah, Marco start later in June. On June 1 the active roster is ~11–12; it peaks mid-June; late June tapers as departures hit.

A person is only assignable to a shift on date *d* if `start ≤ d ≤ end` (blank end = always available).

### Hours targets (relative load shares)

The true per-person workload is dynamic — it depends on how many people are on site each day — so absolute hour caps are not enforced. Instead everyone carries an hours/week target used as a **relative fair-share weight** by the fairness objective: **leaders 60 h/week, volunteers 40 h/week** (leaders carry 1.5× a volunteer's share). Shares are additionally scaled by each person's days of presence in the planning range, so a half-month stay owes half a share.

---

## 2. Shift Types

### Daily shifts (every day, June 1–30)

**Morning Survey — 3 teams, 05:00–13:00**
- Teams: Survey A, Survey B, Survey C
- Each team: 2–3 people, **≥1 survey leader**
- All three teams run every day
- Daily survey headcount: 6–9 people

**Survey Driver — 05:00–13:00, 1 person, requires `driver`**
- One driver shift per day covering morning survey transport

**Cooking — 14:00–16:00, 2 people**

**Basecamp — AM/PM, 2 hours each, 1 person each** (staffing camp)
- Basecamp AM: 07:00–09:00
- Basecamp PM: 17:00–19:00

**Kiosk — 3 shifts/day, 2 people each** (visitor info kiosk)
- Kiosk 1: 10:00–13:00
- Kiosk 2: 13:00–16:00
- Kiosk 3: 16:00–19:00

### Weekly shifts

**Public talks — 5 per week, 19:00–23:00**
- Held at different venues
- Each: 2–3 people, **≥1 presenter**
- Distribute the 5 across each calendar week

**Grocery shop — 1 per week, 2 people, ≥1 `driver`**
- Flexible timing; any day of the week

---

## 3. Constraints

### Hard

1. **Coverage** — every shift instance staffed within its min/max headcount.
2. **Qualification** — survey teams ≥1 survey leader; public talks ≥1 presenter; Survey Driver & grocery require `driver`.
3. **Availability** — only assign within a person's active date range.
4. **No double-booking** — a person holds at most one shift per overlapping time block. Morning Survey (05:00–13:00) and Survey Driver (05:00–13:00) fully overlap → distinct people. Kiosk 2 (13:00–16:00) overlaps cooking (14:00–16:00) → distinct people.
5. **Talk recovery (same day)** — anyone on a Morning Survey team or Survey Driver on day *d* (both ending 13:00) cannot take a public talk that same evening (19:00–23:00 on day *d*).
6. **Talk recovery (next day)** — anyone assigned a public talk on day *d* cannot be assigned any Morning Survey team or Survey Driver on day *d+1* (05:00–13:00).
7. **Day off** — ≥1 full day off per rolling 10-day window per person.

> Combined effect of 5 + 6: a public talk shift carves out morning-survey duty both on the evening it sits in (day *d*) and the following morning (*d+1*).

### Soft (objective)

- Balance total workload across people: minimize each person's L1 deviation from their fair share of all assigned hours, weighted by presence days × hours-target share (see §1).
- Spread survey-leader and presenter duties so the few qualified people aren't overloaded.
- Prefer language coverage on public talks matching audience demographics (e.g. ≥1 german or english speaker per talk).
- Minimize consecutive survey days per person.

---

## 4. Weekly Structure (reference)

June 2027: **Jun 1 = Tuesday.** Weeks for grocery / public-talk counting:

- **W1:** Jun 1–6 (partial, Tue–Sun)
- **W2:** Jun 7–13
- **W3:** Jun 14–20
- **W4:** Jun 21–27
- **W5:** Jun 28–30 (partial)

Treat partial weeks pro-rata for the 5 public talks / 1 grocery, or relax min headcount in partial weeks.

### Feasibility notes

- Public talks need ≥1 presenter, and each talk person is survey-blocked the next morning (constraint 6). With only 6–9 survey slots/day and a limited survey-leader pool, clustering talks onto consecutive days can starve the next morning's surveys of leaders.
- If the ILP reports infeasibility, relief valves in order: spread the 5 talks so no two land on consecutive days; relax constraint 5 (same-day survey→talk) to soft; widen survey team max to 3 to absorb load.
