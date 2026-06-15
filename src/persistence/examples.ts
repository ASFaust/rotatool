/**
 * examples.ts — built-in example/template datasets, loadable from the topbar.
 *
 * Each entry builds a fresh, validated AppData. Datasets are constructed
 * programmatically (ids via newId()) so loading twice never collides with
 * anything previously imported.
 */

import { AppDataSchema, SCHEMA_VERSION, defaultShiftType } from "../model/schema";
import type { AppData } from "../model/types";
import { newId } from "../model/store";
import { createSeedData } from "./io";

export interface ExampleTemplate {
  id: string;
  name: string;
  description: string;
  create: () => AppData;
}

// ---------------------------------------------------------------------------
// ARCHELON Rethymno — June 2027 (see example.md for the full specification)
// ---------------------------------------------------------------------------

/**
 * Sea-turtle conservation duty rota: 2 leaders + 15 volunteers with staggered
 * arrival/departure dates, daily morning-survey teams (each needing an MS
 * leader), an MS driver run, cooking, three kiosk shifts, plus weekly
 * presentations (needing a presenter) and a grocery run (needing a driver).
 *
 * Specialist seats (MS leader, driver, presenter) are `required` people slots;
 * generic seats are slots with no attributes, which anyone can fill.
 *
 * Workload is dynamic (demand / people-on-site varies through June), so the
 * fairness objective is enabled and hours/week targets act as relative load
 * shares: leaders 60h/wk, volunteers 40h/wk.
 */
function createArchelonData(): AppData {
  const ATTRIBUTE_NAMES = [
    "MS leader",
    "camp leader",
    "presenter",
    "german",
    "english",
    "french",
    "greek",
    "italian",
    "driver",
  ] as const;
  type AttrName = (typeof ATTRIBUTE_NAMES)[number];

  const attrId = {} as Record<AttrName, string>;
  const attributes = ATTRIBUTE_NAMES.map((name) => {
    const id = newId();
    attrId[name] = id;
    return { id, name, valued: false };
  });

  // [name, start, end (undefined = open-ended), hours/week target, attributes]
  // Hours targets express *relative* load shares for the fairness objective:
  // leaders (60h/wk) carry 1.5x a volunteer's (40h/wk) share.
  const PEOPLE: Array<[string, string, string | undefined, number, AttrName[]]> = [
    // Leaders
    ["Maria Konstantinou", "2027-05-10", undefined, 60, ["camp leader", "MS leader", "presenter", "greek", "english", "german", "driver"]],
    ["Lukas Brandt", "2027-05-15", undefined, 60, ["camp leader", "MS leader", "presenter", "german", "english", "french", "driver"]],
    // Volunteers
    ["Sofia Müller", "2027-05-01", "2027-06-15", 40, ["MS leader", "presenter", "german", "english", "driver"]],
    ["Thomas Weber", "2027-05-15", "2027-07-31", 40, ["MS leader", "english", "german", "driver"]],
    ["Elena Rossi", "2027-05-20", "2027-06-20", 40, ["presenter", "english", "french", "italian"]],
    ["James Carter", "2027-06-01", "2027-08-31", 40, ["english", "driver"]],
    ["Camille Dubois", "2027-06-01", "2027-07-15", 40, ["presenter", "french", "english"]],
    ["Anna Schmidt", "2027-05-10", "2027-06-30", 40, ["MS leader", "german", "english", "driver"]],
    ["Yiannis Pappas", "2027-05-25", "2027-08-25", 40, ["greek", "english", "driver"]],
    ["Laura Bianchi", "2027-06-05", "2027-09-05", 40, ["english", "french"]],
    ["Max Fischer", "2027-06-10", "2027-07-10", 40, ["german", "english", "driver"]],
    ["Chloé Martin", "2027-05-20", "2027-06-18", 40, ["presenter", "french", "english", "driver"]],
    ["David Jones", "2027-06-01", "2027-07-31", 40, ["english", "driver"]],
    ["Nadia Hofmann", "2027-06-12", "2027-09-12", 40, ["MS leader", "german", "english"]],
    ["Petros Nikolaou", "2027-05-30", "2027-06-28", 40, ["greek", "english", "driver"]],
    ["Sarah Klein", "2027-06-08", "2027-08-08", 40, ["german", "english"]],
    ["Marco Conti", "2027-06-15", "2027-09-15", 40, ["english", "italian", "driver"]],
  ];

  const persons: AppData["persons"] = [];
  const personAttributes: AppData["personAttributes"] = [];
  const availability: AppData["availability"] = [];
  for (const [name, start, end, hoursPerWeek, attrs] of PEOPLE) {
    const id = newId();
    persons.push({ id, name, activated: true, hoursPerTimeframe: { value: hoursPerWeek, unit: "week" } });
    availability.push({ personId: id, kind: "available", start, end });
    for (const a of new Set<AttrName>(attrs)) {
      personAttributes.push({ personId: id, attributeId: attrId[a] });
    }
  }

  const shiftTemplates: AppData["shiftTemplates"] = [];

  // Shift types, minted on first use by the addTemplate helper below.
  const shiftTypes: AppData["shiftTypes"] = [defaultShiftType()];
  const typeId = (name: string): string => {
    const existing = shiftTypes.find((t) => t.name === name);
    if (existing) return existing.id;
    const id = newId();
    shiftTypes.push({ id, name });
    return id;
  };

  /** Add one repeating template; people slots are { attrs (ANDed), count, required? }. */
  const addTemplate = (
    name: string,
    type: string,
    time: string, // "HH:MM" on the June 1, 2027 anchor
    durationMinutes: number,
    frequencyDays: number,
    slots: Array<{ attrs: AttrName[]; count: number; required?: boolean }>,
    breakMinutes = 0,
  ) => {
    shiftTemplates.push({
      id: newId(),
      name,
      typeId: typeId(type),
      importance: 1,
      activated: true,
      durationMinutes,
      breakMinutes,
      activationDateTime: `2027-06-01T${time}:00`,
      frequency: { value: frequencyDays, unit: "days" },
      requirements: slots.map(({ attrs, count, required }) => ({
        attributeIds: attrs.map((a) => attrId[a]),
        count,
        required: required ?? false,
      })),
    });
  };

  // Three shift types group the work: conservation (the morning surveys),
  // camp work (cook/driver/grocery logistics) and PA work (public awareness:
  // kiosk + presentations).
  const CONSERVATION = "Conservation work";
  const CAMP = "Camp work";
  const PA = "PA work";

  // Daily shifts (pinned day + time). Each MS team: 1 required MS leader,
  // 1 required anyone, 1 optional anyone.
  for (const team of ["A", "B", "C"]) {
    addTemplate(`Morning Survey ${team}`, CONSERVATION, "05:00", 480, 1, [
      { attrs: ["MS leader"], count: 1, required: true },
      { attrs: [], count: 1, required: true },
      { attrs: [], count: 1 },
    ]);
  }
  addTemplate("MS Driver", CAMP, "05:00", 480, 1, [{ attrs: ["driver"], count: 1, required: true }]);
  addTemplate("Cooking", CAMP, "14:00", 120, 1, [{ attrs: [], count: 2 }]);
  // Kiosk shifts abut (08–11, 11–14, 14–17); the 1h break makes back-to-back
  // kiosk for the same person cost an hour of violated break time.
  addTemplate("Kiosk 1", PA, "08:00", 180, 1, [{ attrs: [], count: 2, required: true }], 60);
  addTemplate("Kiosk 2", PA, "11:00", 180, 1, [{ attrs: [], count: 2, required: true }], 60);
  addTemplate("Kiosk 3", PA, "14:00", 180, 1, [{ attrs: [], count: 2, required: true }], 60);

  // Weekly shifts pinned to a fixed day + time (the anchor weekday). Five
  // presentation templates ≙ five presentations per week, ≥1 presenter each.
  // The presentation's 8h break (until 07:00) discourages putting the same
  // person on a 05:00 morning survey next day.
  for (let i = 1; i <= 5; i++) {
    addTemplate(`Presentation ${i}`, PA, "19:00", 240, 7, [
      { attrs: ["presenter"], count: 1, required: true },
      { attrs: [], count: 2 },
    ], 480);
  }
  addTemplate("Grocery shop", CAMP, "10:00", 120, 7, [
    { attrs: ["driver"], count: 1, required: true },
    { attrs: [], count: 1 },
  ]);

  return AppDataSchema.parse({
    meta: { schemaVersion: SCHEMA_VERSION, appVersion: "0.0.0" },
    attributes,
    persons,
    personAttributes,
    availability,
    shiftTypes,
    shiftTemplates,
    // Open the Ledger on the whole month of July 2027.
    ledgerView: { from: "2027-07-01", to: "2027-07-31" },
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const EXAMPLES: ExampleTemplate[] = [
  {
    id: "simple-cook",
    name: "Simple cook rota (Alice & Bob)",
    description:
      "Tiny restaurant: 3 people, one daily evening service needing a cook and a supervisor.",
    create: createSeedData,
  },
  {
    id: "archelon-rethymno",
    name: "ARCHELON Rethymno — June 2027",
    description:
      "Sea-turtle conservation rota: 17 people with staggered stays, daily morning surveys, driver, cooking and kiosk shifts, weekly presentations and grocery runs.",
    create: createArchelonData,
  },
];
