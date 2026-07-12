import { z } from "zod";
import { sql } from "./db.js";

const DATA_CREDIT =
  "Published by the TATTOO Foundation (https://tattoo.foundation) at mcp.tattoo.foundation. Dataset built by Carso Cybernetics (https://carsocybernetics.com) on the SuperTrucker platform (https://supertrucker.ai); query access donated to the Foundation for driver-protective verification.";

const BASIC_LABELS: Record<string, string> = {
  unsafe_driving: "Unsafe Driving",
  hours_of_service: "HOS Compliance",
  driver_fitness: "Driver Fitness",
  controlled_substances: "Controlled Substances/Alcohol",
  vehicle_maintenance: "Vehicle Maintenance",
  hazmat_compliance: "Hazmat Compliance",
};

function fmtDate(v: unknown): string {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

async function findCarrier(dotNumber: number | string) {
  const dot = BigInt(dotNumber).toString();
  const rows = await sql`
    SELECT id, dot_number, legal_name, fleet_size FROM carrier
    WHERE dot_number = ${dot}::bigint LIMIT 1
  `;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// carrier_safety_history — crashes + roadside inspections
// ---------------------------------------------------------------------------

export const safetyHistorySchema = {
  dot_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .describe("USDOT number"),
  crash_limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Max recent crashes to list (default 20)."),
  inspection_limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("Max recent inspections to list (default 20)."),
};

export async function carrierSafetyHistory(args: {
  dot_number: number | string;
  crash_limit?: number;
  inspection_limit?: number;
}) {
  const carrier = await findCarrier(args.dot_number);
  if (!carrier) {
    return errResult(`No carrier found with USDOT ${args.dot_number}.`);
  }

  const crashLimit = args.crash_limit ?? 20;
  const inspLimit = args.inspection_limit ?? 20;

  const [crashSummary, recentCrashes, inspSummary, recentInsp] =
    await Promise.all([
      sql`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE crash_date >= now() - interval '24 months')::int AS last_24mo,
               coalesce(sum(fatalities), 0)::int AS fatalities,
               coalesce(sum(injuries), 0)::int AS injuries,
               count(*) FILTER (WHERE towed_flag)::int AS tow_aways,
               count(*) FILTER (WHERE hazmat_flag)::int AS hazmat_crashes
        FROM crash WHERE carrier_id = ${carrier.id}
      `,
      sql`
        SELECT crash_date, state, fatalities, injuries, towed_flag, hazmat_flag, report_number
        FROM crash WHERE carrier_id = ${carrier.id}
        ORDER BY crash_date DESC LIMIT ${crashLimit}
      `,
      sql`
        SELECT count(*)::int AS total,
               coalesce(sum(violation_count), 0)::int AS violations,
               coalesce(sum(oos_violation_count), 0)::int AS oos_violations,
               count(*) FILTER (WHERE driver_oos_flag)::int AS driver_oos,
               count(*) FILTER (WHERE vehicle_oos_flag)::int AS vehicle_oos,
               count(*) FILTER (WHERE hazmat_oos_flag)::int AS hazmat_oos,
               coalesce(sum(unsafe_driving_viol_count), 0)::int AS unsafe_driving,
               coalesce(sum(hours_of_service_viol_count), 0)::int AS hours_of_service,
               coalesce(sum(driver_fitness_viol_count), 0)::int AS driver_fitness,
               coalesce(sum(controlled_substances_viol_count), 0)::int AS controlled_substances,
               coalesce(sum(vehicle_maintenance_viol_count), 0)::int AS vehicle_maintenance,
               coalesce(sum(hazmat_compliance_viol_count), 0)::int AS hazmat_compliance,
               min(inspection_date) AS earliest,
               max(inspection_date) AS latest
        FROM inspection WHERE carrier_id = ${carrier.id}
      `,
      sql`
        SELECT inspection_date, state, inspection_level, violation_count,
               oos_violation_count, driver_oos_flag, vehicle_oos_flag, hazmat_oos_flag
        FROM inspection WHERE carrier_id = ${carrier.id}
        ORDER BY inspection_date DESC LIMIT ${inspLimit}
      `,
    ]);

  const cs = crashSummary[0];
  const ins = inspSummary[0];

  const driverOosRate =
    ins.total > 0 ? ((ins.driver_oos / ins.total) * 100).toFixed(1) : null;
  const vehicleOosRate =
    ins.total > 0 ? ((ins.vehicle_oos / ins.total) * 100).toFixed(1) : null;

  const flags: string[] = [];
  if (cs.fatalities > 0) flags.push(`⚠️ ${cs.fatalities} fatalities in crash record`);
  if (cs.last_24mo > 0) flags.push(`⚠️ ${cs.last_24mo} crashes in the last 24 months`);
  // National averages run roughly 5–7% driver OOS and 20–22% vehicle OOS.
  if (driverOosRate && Number(driverOosRate) > 7)
    flags.push(`⚠️ Driver out-of-service rate ${driverOosRate}% (national avg ~5–7%)`);
  if (vehicleOosRate && Number(vehicleOosRate) > 22)
    flags.push(`⚠️ Vehicle out-of-service rate ${vehicleOosRate}% (national avg ~20–22%)`);

  const violByBasic = Object.entries(BASIC_LABELS)
    .map(([key, label]) => ({ key, label, count: ins[key] as number }))
    .sort((a, b) => b.count - a.count);

  const lines = [
    `# Safety history — ${carrier.legal_name} (USDOT ${carrier.dot_number})`,
    `Fleet: ${carrier.fleet_size ?? "?"} power units`,
    "",
    flags.length > 0 ? `## Flags\n${flags.map((f) => `- ${f}`).join("\n")}` : "## Flags\n- None detected.",
    "",
    "## Crashes",
    `Total on record: ${cs.total}  ·  Last 24 months: ${cs.last_24mo}`,
    `Fatalities: ${cs.fatalities}  ·  Injuries: ${cs.injuries}  ·  Tow-aways: ${cs.tow_aways}  ·  Hazmat: ${cs.hazmat_crashes}`,
    recentCrashes.length === 0
      ? "(no crashes on record)"
      : recentCrashes
          .map(
            (c: any) =>
              `- ${fmtDate(c.crash_date)} — ${c.state ?? "—"}` +
              (c.fatalities > 0 ? ` — ${c.fatalities} fatal` : "") +
              (c.injuries > 0 ? ` — ${c.injuries} injured` : "") +
              (c.towed_flag ? " — tow-away" : "") +
              (c.hazmat_flag ? " — hazmat" : "") +
              (c.report_number ? ` — report ${c.report_number}` : ""),
          )
          .join("\n"),
    "",
    "## Roadside inspections",
    ins.total === 0
      ? "(no inspections on record)"
      : [
          `Total: ${ins.total} (${fmtDate(ins.earliest)} → ${fmtDate(ins.latest)})  ·  Violations: ${ins.violations}  ·  OOS violations: ${ins.oos_violations}`,
          `Driver OOS: ${ins.driver_oos} (${driverOosRate}%)  ·  Vehicle OOS: ${ins.vehicle_oos} (${vehicleOosRate}%)  ·  Hazmat OOS: ${ins.hazmat_oos}`,
          "",
          "### Violations by BASIC category",
          violByBasic.map((v) => `- ${v.label}: ${v.count}`).join("\n"),
          "",
          "### Recent inspections",
          recentInsp
            .map(
              (i: any) =>
                `- ${fmtDate(i.inspection_date)} — ${i.state ?? "—"} — level ${i.inspection_level ?? "?"}` +
                ` — ${i.violation_count} violations` +
                (i.oos_violation_count > 0 ? ` (${i.oos_violation_count} OOS)` : "") +
                (i.driver_oos_flag ? " — DRIVER OOS" : "") +
                (i.vehicle_oos_flag ? " — VEHICLE OOS" : "") +
                (i.hazmat_oos_flag ? " — HAZMAT OOS" : ""),
            )
            .join("\n"),
        ].join("\n"),
    "",
    DATA_CREDIT,
  ];

  return okResult(lines.join("\n"), {
    carrier,
    crash_summary: cs,
    recent_crashes: recentCrashes,
    inspection_summary: ins,
    violations_by_basic: violByBasic,
    recent_inspections: recentInsp,
    flags,
  });
}

// ---------------------------------------------------------------------------
// carrier_safety_scores — computed BASIC percentiles (SMS methodology)
// ---------------------------------------------------------------------------

export const safetyScoresSchema = {
  dot_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .describe("USDOT number"),
};

export async function carrierSafetyScores(args: {
  dot_number: number | string;
}) {
  const carrier = await findCarrier(args.dot_number);
  if (!carrier) {
    return errResult(`No carrier found with USDOT ${args.dot_number}.`);
  }

  const scores = await sql`
    SELECT DISTINCT ON (basic_category)
           basic_category, snapshot_date, score_version, measure, percentile,
           safety_event_group, intervention_threshold, intervention_threshold_breached,
           raw_inspection_count, raw_violation_count, inspections_with_violation
    FROM computed_basic_score
    WHERE carrier_id = ${carrier.id}
    ORDER BY basic_category, snapshot_date DESC
  `;

  if (scores.length === 0) {
    return okResult(
      [
        `# Safety scores — ${carrier.legal_name} (USDOT ${carrier.dot_number})`,
        "",
        "No computed BASIC scores for this carrier — typically means too few relevant inspections in the 24-month SMS window to score.",
        "",
        DATA_CREDIT,
      ].join("\n"),
      { carrier, scores: [] },
    );
  }

  const breached = scores.filter((s: any) => s.intervention_threshold_breached);
  const flags = breached.map(
    (s: any) =>
      `⚠️ ${BASIC_LABELS[s.basic_category] ?? s.basic_category}: percentile ${s.percentile} breaches intervention threshold (${s.intervention_threshold})`,
  );

  const lines = [
    `# Safety scores — ${carrier.legal_name} (USDOT ${carrier.dot_number})`,
    `Snapshot: ${fmtDate(scores[0].snapshot_date)}  ·  Methodology: computed BASIC ${scores[0].score_version} (FMCSA SMS-style, computed independently from public inspection data)`,
    "Percentile 0–100: higher = worse relative to peer group. FMCSA intervention thresholds: 65 (most BASICs), 80 for some; breach = would trigger FMCSA attention under SMS rules.",
    "",
    flags.length > 0 ? `## Flags\n${flags.map((f) => `- ${f}`).join("\n")}` : "## Flags\n- No intervention thresholds breached.",
    "",
    "## BASIC percentiles",
    scores
      .map((s: any) => {
        const label = BASIC_LABELS[s.basic_category] ?? s.basic_category;
        const pct = s.percentile === null ? "not scored" : `${s.percentile}%`;
        return (
          `- ${label}: ${pct}` +
          (s.intervention_threshold_breached ? " 🔴 BREACH" : "") +
          ` — measure ${s.measure ?? "—"} — ${s.raw_inspection_count ?? 0} inspections, ${s.raw_violation_count ?? 0} violations`
        );
      })
      .join("\n"),
    "",
    DATA_CREDIT,
  ];

  return okResult(lines.join("\n"), { carrier, scores, flags });
}

// ---------------------------------------------------------------------------
// helpers (mirrors tools.ts)
// ---------------------------------------------------------------------------

function okResult(text: string, structuredContent?: Record<string, unknown>) {
  const out: { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } = {
    content: [{ type: "text", text }],
  };
  if (structuredContent !== undefined) out.structuredContent = structuredContent;
  return out;
}

function errResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}
