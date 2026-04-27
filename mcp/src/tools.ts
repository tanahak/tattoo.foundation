import { z } from "zod";
import { sql } from "./db.js";

const DATA_CREDIT =
  "Published by the TATTOO Foundation (https://tattoo.foundation) at mcp.tattoo.foundation. Dataset built by Carso Cybernetics (https://carsocybernetics.com) on the SuperTrucker platform (https://supertrucker.ai); query access donated to the Foundation for driver-protective verification.";

function fmtDate(v: unknown): string {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function fmtMoney(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return `$${n.toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// lookup_carrier
// ---------------------------------------------------------------------------

export const lookupCarrierSchema = {
  dot_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .optional()
    .describe("USDOT number. Provide either dot_number or name."),
  name: z
    .string()
    .min(2)
    .optional()
    .describe(
      "Legal name or DBA name (case-insensitive substring match). Returns up to 10 matches.",
    ),
};

export async function lookupCarrier(args: {
  dot_number?: number | string;
  name?: string;
}) {
  if (!args.dot_number && !args.name) {
    return errResult("Provide either dot_number or name.");
  }

  if (args.dot_number) {
    const dot = BigInt(args.dot_number).toString();
    const carriers = await sql`
      SELECT id, dot_number, mc_number, legal_name, dba_name,
             address_city, address_state, fleet_size, driver_count,
             operation_type, authority_status, insurance_status,
             out_of_service_flag, mcs150_year
      FROM carrier
      WHERE dot_number = ${dot}::bigint
      LIMIT 1
    `;
    if (carriers.length === 0) {
      return errResult(`No carrier found with USDOT ${dot}.`);
    }
    return await renderCarrierCard(carriers[0]);
  }

  const term = `%${args.name!.toLowerCase()}%`;
  const matches = await sql`
    SELECT id, dot_number, mc_number, legal_name, dba_name,
           address_city, address_state, fleet_size, driver_count,
           operation_type, authority_status, insurance_status,
           out_of_service_flag, mcs150_year
    FROM carrier
    WHERE lower(legal_name) LIKE ${term}
       OR lower(coalesce(dba_name, '')) LIKE ${term}
    ORDER BY fleet_size DESC NULLS LAST, legal_name ASC
    LIMIT 10
  `;
  if (matches.length === 0) {
    return errResult(`No carriers found matching "${args.name}".`);
  }
  if (matches.length === 1) {
    return await renderCarrierCard(matches[0]);
  }
  const lines = [
    `Found ${matches.length} carriers matching "${args.name}". Provide dot_number for full verification:`,
    "",
    ...matches.map(
      (c) =>
        `  • USDOT ${c.dot_number} — ${c.legal_name}` +
        (c.dba_name && c.dba_name !== c.legal_name ? ` (DBA ${c.dba_name})` : "") +
        ` — ${c.address_city ?? "—"}, ${c.address_state ?? "—"}` +
        ` — fleet ${c.fleet_size ?? "?"}` +
        ` — auth ${c.authority_status ?? "?"}`,
    ),
    "",
    DATA_CREDIT,
  ];
  return okResult(lines.join("\n"), { matches });
}

async function renderCarrierCard(c: any) {
  // pull most recent authority event + insurance summary in parallel
  const [recentAuth, insurance] = await Promise.all([
    sql`
      SELECT action_type, authority_type, effective_date, reason
      FROM authority_history
      WHERE carrier_id = ${c.id}
      ORDER BY effective_date DESC
      LIMIT 5
    `,
    sql`
      SELECT filing_type, status, insurer_name, coverage_amount,
             effective_date, cancellation_date
      FROM insurance_filing
      WHERE carrier_id = ${c.id}
      ORDER BY effective_date DESC NULLS LAST
      LIMIT 5
    `,
  ]);

  const activeIns = insurance.filter((f: any) => f.status === "Active");

  const flags: string[] = [];
  if (c.out_of_service_flag && c.out_of_service_flag !== "N") {
    flags.push(`⚠️ OUT OF SERVICE flag: ${c.out_of_service_flag}`);
  }
  if (c.authority_status && c.authority_status !== "A") {
    flags.push(`⚠️ Authority status: ${c.authority_status} (not Active)`);
  }
  if (activeIns.length === 0) {
    flags.push("⚠️ No active insurance filings on record");
  }
  const recentRevocations = recentAuth.filter((e: any) =>
    ["REVOKED", "DISCONTINUED REVOCATION", "INVOLUNTARY REVOCATION", "SAFETY REVOCATION", "SAFETY SUSPENSION"].includes(
      e.action_type,
    ),
  );
  if (recentRevocations.length > 0) {
    flags.push(
      `⚠️ Recent revocation/suspension events (${recentRevocations.length}): ${recentRevocations
        .map((e: any) => `${e.action_type} ${fmtDate(e.effective_date)}`)
        .join("; ")}`,
    );
  }

  const lines = [
    `# ${c.legal_name}` + (c.dba_name && c.dba_name !== c.legal_name ? `  (DBA ${c.dba_name})` : ""),
    `USDOT: ${c.dot_number}` + (c.mc_number ? `  ·  MC: ${c.mc_number}` : ""),
    `Location: ${c.address_city ?? "—"}, ${c.address_state ?? "—"}`,
    `Fleet: ${c.fleet_size ?? "?"} power units  ·  Drivers: ${c.driver_count ?? "?"}`,
    `Operation type: ${c.operation_type ?? "—"}`,
    `Authority status: ${c.authority_status ?? "—"}  ·  Insurance status: ${c.insurance_status ?? "—"}  ·  OOS flag: ${c.out_of_service_flag ?? "—"}`,
    `MCS-150 last updated: ${c.mcs150_year ?? "—"}`,
    "",
    flags.length > 0 ? `## Flags\n${flags.map((f) => `- ${f}`).join("\n")}` : "## Flags\n- None detected.",
    "",
    "## Recent authority events",
    recentAuth.length === 0
      ? "- (none on record)"
      : recentAuth
          .map(
            (e: any) =>
              `- ${fmtDate(e.effective_date)} — ${e.action_type}${
                e.authority_type ? ` (${e.authority_type})` : ""
              }${e.reason ? ` — ${e.reason}` : ""}`,
          )
          .join("\n"),
    "",
    "## Insurance",
    activeIns.length === 0
      ? "- No active filings."
      : activeIns
          .map(
            (f: any) =>
              `- ${f.filing_type} ${f.status} — ${f.insurer_name ?? "?"} — ` +
              `coverage ${fmtMoney(f.coverage_amount)} — effective ${fmtDate(f.effective_date)}` +
              (f.cancellation_date ? ` — cancelled ${fmtDate(f.cancellation_date)}` : ""),
          )
          .join("\n"),
    "",
    DATA_CREDIT,
  ];

  return okResult(lines.join("\n"), {
    carrier: c,
    recent_authority_events: recentAuth,
    active_insurance: activeIns,
    flags,
  });
}

// ---------------------------------------------------------------------------
// carrier_revocation_history
// ---------------------------------------------------------------------------

export const revocationHistorySchema = {
  dot_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .describe("USDOT number"),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max events to return (default 50)."),
};

export async function carrierRevocationHistory(args: {
  dot_number: number | string;
  limit?: number;
}) {
  const dot = BigInt(args.dot_number).toString();
  const limit = args.limit ?? 50;

  const carrier = await sql`
    SELECT id, dot_number, legal_name FROM carrier
    WHERE dot_number = ${dot}::bigint LIMIT 1
  `;
  if (carrier.length === 0) {
    return errResult(`No carrier found with USDOT ${dot}.`);
  }

  const events = await sql`
    SELECT action_type, authority_type, effective_date, reason, docket_number
    FROM authority_history
    WHERE carrier_id = ${carrier[0].id}
    ORDER BY effective_date DESC
    LIMIT ${limit}
  `;

  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.action_type] = (counts[e.action_type] || 0) + 1;
  }

  const lines = [
    `# Authority history — ${carrier[0].legal_name} (USDOT ${carrier[0].dot_number})`,
    `Showing ${events.length} most recent events.`,
    "",
    "## Event-type breakdown",
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `- ${t}: ${n}`)
      .join("\n") || "(none)",
    "",
    "## Timeline (newest first)",
    events.length === 0
      ? "(none on record)"
      : events
          .map(
            (e: any) =>
              `- ${fmtDate(e.effective_date)} — ${e.action_type}` +
              (e.authority_type ? ` (${e.authority_type})` : "") +
              (e.docket_number ? ` — docket ${e.docket_number}` : "") +
              (e.reason ? ` — ${e.reason}` : ""),
          )
          .join("\n"),
    "",
    DATA_CREDIT,
  ];

  return okResult(lines.join("\n"), {
    carrier: carrier[0],
    event_counts: counts,
    events,
  });
}

// ---------------------------------------------------------------------------
// carrier_insurance_status
// ---------------------------------------------------------------------------

export const insuranceStatusSchema = {
  dot_number: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .describe("USDOT number"),
};

export async function carrierInsuranceStatus(args: {
  dot_number: number | string;
}) {
  const dot = BigInt(args.dot_number).toString();
  const carrier = await sql`
    SELECT id, dot_number, legal_name FROM carrier
    WHERE dot_number = ${dot}::bigint LIMIT 1
  `;
  if (carrier.length === 0) {
    return errResult(`No carrier found with USDOT ${dot}.`);
  }

  const filings = await sql`
    SELECT filing_type, status, insurer_name, policy_number,
           coverage_amount, effective_date, cancellation_date
    FROM insurance_filing
    WHERE carrier_id = ${carrier[0].id}
    ORDER BY effective_date DESC NULLS LAST
  `;

  const active = filings.filter((f: any) => f.status === "Active");
  const has91X = active.some((f: any) => f.filing_type === "91X");
  const flags: string[] = [];
  if (active.length === 0) flags.push("⚠️ No active insurance filings.");
  else if (!has91X) flags.push("⚠️ No active 91X (auto liability) on record.");

  const lines = [
    `# Insurance — ${carrier[0].legal_name} (USDOT ${carrier[0].dot_number})`,
    `Active filings: ${active.length}  ·  Total filings on record: ${filings.length}`,
    "",
    flags.length > 0 ? `## Flags\n${flags.map((f) => `- ${f}`).join("\n")}` : "## Flags\n- None.",
    "",
    "## Active filings",
    active.length === 0
      ? "(none)"
      : active
          .map(
            (f: any) =>
              `- ${f.filing_type} — ${f.insurer_name ?? "?"} — ` +
              `coverage ${fmtMoney(f.coverage_amount)} — effective ${fmtDate(f.effective_date)}` +
              (f.policy_number ? ` — policy ${f.policy_number}` : ""),
          )
          .join("\n"),
    "",
    "## Full filing history (newest first)",
    filings.length === 0
      ? "(none)"
      : filings
          .map(
            (f: any) =>
              `- ${f.filing_type} ${f.status} — ${f.insurer_name ?? "?"} — ` +
              `${fmtDate(f.effective_date)} → ${
                f.cancellation_date ? fmtDate(f.cancellation_date) : "open"
              } — coverage ${fmtMoney(f.coverage_amount)}`,
          )
          .join("\n"),
    "",
    DATA_CREDIT,
  ];

  return okResult(lines.join("\n"), {
    carrier: carrier[0],
    active_filings: active,
    all_filings: filings,
    flags,
  });
}

// ---------------------------------------------------------------------------
// h2b_trucking_employers
// ---------------------------------------------------------------------------

export const h2bTruckingSchema = {
  state: z
    .string()
    .length(2)
    .optional()
    .describe("Two-letter US state code (employer state). Optional."),
  soc_code: z
    .string()
    .optional()
    .describe(
      "Specific SOC code (e.g., '53-3032.00' for heavy/tractor-trailer drivers). If omitted, returns all 53-30xx trucking codes.",
    ),
  fiscal_year: z
    .number()
    .int()
    .optional()
    .describe("Filter to a specific federal fiscal year. Optional."),
  employer_name_contains: z
    .string()
    .optional()
    .describe("Case-insensitive substring match on employer name. Optional."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Max rows (default 50)."),
};

export async function h2bTruckingEmployers(args: {
  state?: string;
  soc_code?: string;
  fiscal_year?: number;
  employer_name_contains?: string;
  limit?: number;
}) {
  const limit = args.limit ?? 50;

  const conditions: any[] = [];
  if (args.soc_code) {
    conditions.push(sql`soc_code = ${args.soc_code}`);
  } else {
    conditions.push(sql`soc_code LIKE '53-30%'`);
  }
  if (args.state) {
    conditions.push(sql`employer_state = ${args.state.toUpperCase()}`);
  }
  if (args.fiscal_year) {
    conditions.push(sql`fiscal_year = ${args.fiscal_year}`);
  }
  if (args.employer_name_contains) {
    conditions.push(
      sql`lower(employer_name) LIKE ${"%" + args.employer_name_contains.toLowerCase() + "%"}`,
    );
  }

  let where = sql`WHERE ${conditions[0]}`;
  for (let i = 1; i < conditions.length; i++) {
    where = sql`${where} AND ${conditions[i]}`;
  }

  const rows = await sql`
    SELECT case_number, case_status, decision_date, job_title, soc_code, soc_title,
           workers_requested, workers_certified,
           employment_begin_date, employment_end_date,
           employer_name, trade_name_dba, employer_city, employer_state,
           worksite_city, worksite_state,
           basic_wage_from, basic_wage_to, wage_unit,
           fiscal_year, fiscal_quarter
    FROM h2b_application
    ${where}
    ORDER BY decision_date DESC NULLS LAST, employer_name ASC
    LIMIT ${limit}
  `;

  const totalWorkers = rows.reduce(
    (sum: number, r: any) => sum + (r.workers_certified ?? r.workers_requested ?? 0),
    0,
  );

  const byState: Record<string, number> = {};
  for (const r of rows) {
    if (r.employer_state)
      byState[r.employer_state] = (byState[r.employer_state] || 0) + 1;
  }

  const lines = [
    `# H-2B trucking labor applications`,
    `Filters: ${
      [
        args.soc_code ? `soc=${args.soc_code}` : "soc=53-30xx (all trucking)",
        args.state ? `state=${args.state.toUpperCase()}` : null,
        args.fiscal_year ? `fy=${args.fiscal_year}` : null,
        args.employer_name_contains ? `name~"${args.employer_name_contains}"` : null,
      ]
        .filter(Boolean)
        .join("  ·  ") || "(none)"
    }`,
    `Returned: ${rows.length} applications  ·  Workers (certified or requested): ${totalWorkers}`,
    "",
    "Note: H-2B is visa-tied employment. Workers' immigration status is bound to the sponsoring employer, which structurally enables coercion (debt bondage, wage theft, retaliation). The TATTOO Foundation surfaces this data for driver protection and pattern detection.",
    "",
    "## Applications",
    rows.length === 0
      ? "(none match)"
      : rows
          .map(
            (r: any) =>
              `- ${r.employer_name}` +
              (r.trade_name_dba ? ` (DBA ${r.trade_name_dba})` : "") +
              ` — ${r.employer_city ?? "—"}, ${r.employer_state ?? "—"}` +
              ` — ${r.soc_code} ${r.soc_title}` +
              ` — workers req/cert: ${r.workers_requested ?? "?"}/${r.workers_certified ?? "?"}` +
              ` — status: ${r.case_status ?? "?"}` +
              ` — decision: ${fmtDate(r.decision_date)}` +
              ` — case ${r.case_number ?? "?"}`,
          )
          .join("\n"),
    "",
    "## Top employer states (in result set)",
    Object.entries(byState)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([s, n]) => `- ${s}: ${n}`)
      .join("\n") || "(none)",
    "",
    DATA_CREDIT,
  ];

  return okResult(lines.join("\n"), { rows, total_workers: totalWorkers, by_state: byState });
}

// ---------------------------------------------------------------------------
// helpers
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
