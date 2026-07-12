import { z } from "zod";
import { sql } from "./db.js";

const DATA_CREDIT =
  "Published by the TATTOO Foundation (https://tattoo.foundation) at mcp.tattoo.foundation. Dataset built by Carso Cybernetics (https://carsocybernetics.com) on the SuperTrucker platform (https://supertrucker.ai); query access donated to the Foundation for driver-protective verification.";

// Common business regions; `states` overrides `region` when both are given.
export const REGIONS: Record<string, string[]> = {
  southeast: ["AL", "AR", "FL", "GA", "KY", "LA", "MS", "NC", "SC", "TN", "VA", "WV"],
  northeast: ["CT", "DE", "MA", "MD", "ME", "NH", "NJ", "NY", "PA", "RI", "VT"],
  midwest: ["IA", "IL", "IN", "KS", "MI", "MN", "MO", "ND", "NE", "OH", "SD", "WI"],
  southwest: ["AZ", "NM", "OK", "TX"],
  west: ["AK", "CA", "CO", "HI", "ID", "MT", "NV", "OR", "UT", "WA", "WY"],
};

export const searchCarriersSchema = {
  fleet_min: z.number().int().min(0).optional().describe("Minimum power units (inclusive)."),
  fleet_max: z.number().int().positive().optional().describe("Maximum power units (inclusive)."),
  authority_status: z
    .enum(["A", "I", "any"])
    .optional()
    .describe("Operating authority: 'A' active (default), 'I' inactive, 'any'."),
  states: z
    .array(z.string().length(2))
    .max(55)
    .optional()
    .describe("Two-letter state codes (carrier physical address). Overrides region."),
  region: z
    .enum(["southeast", "northeast", "midwest", "southwest", "west"])
    .optional()
    .describe("Region shortcut. southeast = AL AR FL GA KY LA MS NC SC TN VA WV."),
  cargo_contains: z
    .string()
    .min(3)
    .optional()
    .describe(
      "Case-insensitive match on cargo classifications, e.g. 'Refrigerated', 'Livestock', 'General Freight'.",
    ),
  name_contains: z.string().min(2).optional().describe("Substring match on legal/DBA name."),
  require_contact: z
    .boolean()
    .optional()
    .describe("Only carriers with a phone or email on file (for outreach lists)."),
  limit: z.number().int().positive().max(200).optional().describe("Max rows (default 50, max 200)."),
  offset: z.number().int().min(0).optional().describe("Pagination offset."),
};

export interface SearchCarriersArgs {
  fleet_min?: number;
  fleet_max?: number;
  authority_status?: "A" | "I" | "any";
  states?: string[];
  region?: keyof typeof REGIONS;
  cargo_contains?: string;
  name_contains?: string;
  require_contact?: boolean;
  limit?: number;
  offset?: number;
}

export async function searchCarriers(args: SearchCarriersArgs) {
  const limit = Math.min(args.limit ?? 50, 200);
  const offset = args.offset ?? 0;
  const authority = args.authority_status ?? "A";
  const states =
    args.states?.map((s) => s.toUpperCase()) ??
    (args.region ? REGIONS[args.region] : null);

  const conditions = [sql`c.fleet_size IS NOT NULL`];
  if (authority !== "any") conditions.push(sql`c.authority_status = ${authority}`);
  if (args.fleet_min !== undefined) conditions.push(sql`c.fleet_size >= ${args.fleet_min}`);
  if (args.fleet_max !== undefined) conditions.push(sql`c.fleet_size <= ${args.fleet_max}`);
  if (states) conditions.push(sql`c.address_state = ANY(${states})`);
  if (args.cargo_contains)
    conditions.push(sql`c.cargo_carried ILIKE ${"%" + args.cargo_contains + "%"}`);
  if (args.name_contains) {
    const term = `%${args.name_contains.toLowerCase()}%`;
    conditions.push(
      sql`(lower(c.legal_name) LIKE ${term} OR lower(coalesce(c.dba_name,'')) LIKE ${term})`,
    );
  }
  if (args.require_contact)
    conditions.push(sql`(c.phone IS NOT NULL OR c.email IS NOT NULL)`);

  let where = sql`WHERE ${conditions[0]}`;
  for (let i = 1; i < conditions.length; i++) where = sql`${where} AND ${conditions[i]}`;

  const rows = await sql`
    SELECT c.dot_number, c.mc_number, c.legal_name, c.dba_name,
           c.address_city, c.address_state, c.fleet_size, c.driver_count,
           c.authority_status, c.cargo_carried, c.phone, c.email,
           c.mcs150_year, c.years_in_operation,
           count(*) OVER ()::int AS total_matches
    FROM carrier c
    ${where}
    ORDER BY c.fleet_size DESC NULLS LAST, c.legal_name ASC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const total = rows.length > 0 ? rows[0].total_matches : 0;

  const filterDesc = [
    args.fleet_min !== undefined || args.fleet_max !== undefined
      ? `fleet ${args.fleet_min ?? 0}–${args.fleet_max ?? "∞"}`
      : null,
    authority !== "any" ? `authority=${authority}` : null,
    args.region && !args.states ? `region=${args.region}` : null,
    args.states ? `states=${args.states.join(",")}` : null,
    args.cargo_contains ? `cargo~"${args.cargo_contains}"` : null,
    args.name_contains ? `name~"${args.name_contains}"` : null,
    args.require_contact ? "has contact info" : null,
  ]
    .filter(Boolean)
    .join("  ·  ");

  const lines = [
    `# Carrier search`,
    `Filters: ${filterDesc || "(none)"}`,
    `Matches: ${total.toLocaleString("en-US")}  ·  Showing: ${rows.length}${offset ? ` (offset ${offset})` : ""}`,
    "",
    rows.length === 0
      ? "(no carriers match)"
      : rows
          .map(
            (c: any, i: number) =>
              `${offset + i + 1}. USDOT ${c.dot_number} — ${c.legal_name}` +
              (c.dba_name && c.dba_name !== c.legal_name ? ` (DBA ${c.dba_name})` : "") +
              `\n   ${c.address_city ?? "—"}, ${c.address_state ?? "—"}  ·  fleet ${c.fleet_size}  ·  drivers ${c.driver_count ?? "?"}` +
              (c.phone ? `  ·  ${c.phone}` : "") +
              (c.email ? `  ·  ${c.email}` : "") +
              (c.cargo_carried ? `\n   cargo: ${c.cargo_carried}` : ""),
          )
          .join("\n"),
    "",
    total > offset + rows.length
      ? `More available — repeat with offset=${offset + rows.length}.`
      : "",
    DATA_CREDIT,
  ].filter((l) => l !== "");

  return okResult(lines.join("\n"), {
    total_matches: total,
    returned: rows.length,
    offset,
    carriers: rows.map(({ total_matches, ...c }: any) => c),
  });
}

function okResult(text: string, structuredContent?: Record<string, unknown>) {
  const out: { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> } = {
    content: [{ type: "text", text }],
  };
  if (structuredContent !== undefined) out.structuredContent = structuredContent;
  return out;
}
