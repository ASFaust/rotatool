# ARCHELON Rethymno — Duty Rota Specification
## June 2027

ARCHELON surveys Rethymno-area beaches for loggerhead (*Caretta caretta*) nests during nesting season. This rota covers **June 1–30, 2027**. Compute and constraint-solving run client-side; this document specifies people, attributes, shift types, and constraints for the ILP.

---

## 1. People

### Attributes (roles / flags)

- **MS leader** — qualified to lead a morning survey team
- **camp leader** — camp leadership
- **presenter** — can hold presentations
- **german**, **english**, **french**, **greek** — spoken languages
- **driver** — holds a driving licence

### Leaders (2) — arrived May 2027, no end date

| Name | Start | End | Attributes |
|---|---|---|---|
| Maria Konstantinou | 2027-05-10 | — | camp leader, MS leader, presenter, greek, english, german, driver |
| Lukas Brandt | 2027-05-15 | — | camp leader, MS leader, presenter, german, english, french, driver |

### Volunteers (15) — staggered start/end, 1–3 month stays

| Name | Start | End | Attributes |
|---|---|---|---|
| Sofia Müller | 2027-05-01 | 2027-06-15 | MS leader, presenter, german, english, driver |
| Thomas Weber | 2027-05-15 | 2027-07-31 | MS leader, english, german, driver |
| Elena Rossi | 2027-05-20 | 2027-06-20 | presenter, english, french, italian |
| James Carter | 2027-06-01 | 2027-08-31 | english, driver |
| Camille Dubois | 2027-06-01 | 2027-07-15 | presenter, french, english |
| Anna Schmidt | 2027-05-10 | 2027-06-30 | MS leader, german, english, driver |
| Yiannis Pappas | 2027-05-25 | 2027-08-25 | greek, english, driver |
| Laura Bianchi | 2027-06-05 | 2027-09-05 | english, french |
| Max Fischer | 2027-06-10 | 2027-07-10 | german, english, driver |
| Chloé Martin | 2027-05-20 | 2027-06-18 | presenter, french, english, driver |
| David Jones | 2027-06-01 | 2027-07-31 | english, driver |
| Nadia Hofmann | 2027-06-12 | 2027-09-12 | MS leader, german, english |
| Petros Nikolaou | 2027-05-30 | 2027-06-28 | greek, english, driver |
| Sarah Klein | 2027-06-08 | 2027-08-08 | german, english |
| Marco Conti | 2027-06-15 | 2027-09-15 | english, italian, driver |

Realistic flux: Sofia, Chloé, Elena, Petros, Anna leave mid/late June; James, Camille, David start June 1; Laura, Max, Nadia, Sarah, Marco start later in June. On June 1 the active roster is ~11–12; it peaks mid-June; late June tapers as departures hit.

A person is only assignable to a shift on date *d* if `start ≤ d ≤ end` (blank end = always available).

### Hours targets (relative load shares)

The true per-person workload is dynamic — it depends on how many people are on site each day — so absolute hour caps are not enforced. Instead everyone carries an hours/week target used as a **relative fair-share weight** by the fairness objective: **leaders 60 h/week, volunteers 40 h/week** (leaders carry 1.5× a volunteer's share). Shares are additionally scaled by each person's days of presence in the planning range, so a half-month stay owes half a share.

---

## 2. Shift Types

### Daily shifts (every day, June 1–30)

**Morning Survey — 3 teams, 05:00–13:00**
- Teams: MS A–C, MS D–E, MS F–G
- Each team: 2–3 people, **≥1 MS leader**
- All three teams run every day
- Daily MS headcount: 6–9 people

**MS Driver — 05:00–13:00, 1 person, requires `driver`**
- One driver shift per day covering morning survey transport

**Cooking — 14:00–16:00, 2 people**

**Kiosk — 3 shifts/day, 2 people each**
- Kiosk 1: 08:00–11:00
- Kiosk 2: 11:00–14:00
- Kiosk 3: 14:00–17:00

### Weekly shifts

**Presentations — 5 per week, 19:00–23:00**
- Held at different hotels
- Each: 2–3 people, **≥1 presenter**
- Distribute the 5 across each calendar week

**Grocery shop — 1 per week, 2 people, ≥1 `driver`**
- Flexible timing; any day of the week

---

## 3. Constraints

### Hard

1. **Coverage** — every shift instance staffed within its min/max headcount.
2. **Qualification** — MS teams ≥1 MS leader; presentations ≥1 presenter; MS Driver & grocery require `driver`.
3. **Availability** — only assign within a person's active date range.
4. **No double-booking** — a person holds at most one shift per overlapping time block. MS (05:00–13:00) and MS Driver (05:00–13:00) fully overlap → distinct people. Kiosk 3 (14:00–17:00) overlaps cooking (14:00–16:00) → distinct people.
5. **Presentation recovery (same day)** — anyone on a Morning Survey team or MS Driver on day *d* (both ending 13:00) cannot take a presentation that same evening (19:00–23:00 on day *d*).
6. **Presentation recovery (next day)** — anyone assigned a presentation on day *d* cannot be assigned any Morning Survey team or MS Driver on day *d+1* (05:00–13:00).
7. **Day off** — ≥1 full day off per rolling 10-day window per person.

> Combined effect of 5 + 6: a presentation shift carves out morning-survey duty both on the evening it sits in (day *d*) and the following morning (*d+1*).

### Soft (objective)

- Balance total workload across people: minimize each person's L1 deviation from their fair share of all assigned hours, weighted by presence days × hours-target share (see §1).
- Spread MS-leader and presenter duties so the few qualified people aren't overloaded.
- Prefer language coverage on presentations matching hotel guest demographics (e.g. ≥1 german or english speaker per presentation).
- Minimize consecutive MS days per person.

---

## 4. Weekly Structure (reference)

June 2027: **Jun 1 = Tuesday.** Weeks for grocery / presentation counting:

- **W1:** Jun 1–6 (partial, Tue–Sun)
- **W2:** Jun 7–13
- **W3:** Jun 14–20
- **W4:** Jun 21–27
- **W5:** Jun 28–30 (partial)

Treat partial weeks pro-rata for the 5 presentations / 1 grocery, or relax min headcount in partial weeks.

### Feasibility notes

- Presentations need ≥1 presenter, and each presentation person is MS-blocked the next morning (constraint 6). With only 6–9 MS slots/day and a limited MS-leader pool, clustering presentations onto consecutive days can starve the next morning's surveys of leaders.
- If the ILP reports infeasibility, relief valves in order: spread the 5 presentations so no two land on consecutive days; relax constraint 5 (same-day MS→presentation) to soft; widen MS team max to 3 to absorb load.