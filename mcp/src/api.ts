import type { Express, Request, Response } from "express";
import { lookupCarrier } from "./tools.js";
import { carrierSafetyHistory, carrierSafetyScores } from "./safety.js";
import { searchCarriers, REGIONS } from "./search.js";
import { sql } from "./db.js";

// Read-only JSON API for the human lookup page at https://tattoo.foundation/lookup.
// Same queries as the MCP tools; the page shows what an agent would see.

const ALLOWED_ORIGINS = new Set([
  "https://tattoo.foundation",
  "https://www.tattoo.foundation",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

function cors(req: Request, res: Response) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function send(res: Response, result: ToolResult) {
  if (result.isError) {
    res.status(404).json({ error: result.content[0]?.text ?? "Not found" });
    return;
  }
  res.json({
    ...result.structuredContent,
    report_text: result.content[0]?.text ?? "",
  });
}

export function mountApi(app: Express) {
  app.options("/api/*", (req, res) => {
    cors(req, res);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.status(204).end();
  });

  // GET /api/search?q=<dot-or-name> — resolve to a carrier or a match list
  app.get("/api/search", async (req, res) => {
    cors(req, res);
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) {
      res.status(400).json({ error: "Provide q (USDOT number or carrier name, min 2 chars)." });
      return;
    }
    try {
      const result = /^\d+$/.test(q)
        ? await lookupCarrier({ dot_number: q })
        : await lookupCarrier({ name: q });
      send(res, result as ToolResult);
    } catch (err) {
      console.error("api/search error", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/carrier/:dot — full report: identity + authority + insurance + safety + scores
  app.get("/api/carrier/:dot", async (req, res) => {
    cors(req, res);
    const dot = req.params.dot;
    if (!/^\d+$/.test(dot)) {
      res.status(400).json({ error: "USDOT number must be numeric." });
      return;
    }
    try {
      const [identity, safety, scores] = await Promise.all([
        lookupCarrier({ dot_number: dot }),
        carrierSafetyHistory({ dot_number: dot }),
        carrierSafetyScores({ dot_number: dot }),
      ]);
      if ((identity as ToolResult).isError) {
        res.status(404).json({ error: `No carrier found with USDOT ${dot}.` });
        return;
      }
      res.json({
        identity: (identity as ToolResult).structuredContent ?? null,
        safety: (safety as ToolResult).structuredContent ?? null,
        scores: (scores as ToolResult).structuredContent ?? null,
      });
    } catch (err) {
      console.error("api/carrier error", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/carriers/search — filtered census search
  // ?fleet_min=10&fleet_max=100&region=southeast&cargo=Refrigerated&authority=A&limit=100&offset=0
  app.get("/api/carriers/search", async (req, res) => {
    cors(req, res);
    const q = req.query;
    const region = typeof q.region === "string" ? q.region.toLowerCase() : undefined;
    if (region && !(region in REGIONS)) {
      res.status(400).json({ error: `Unknown region. Use: ${Object.keys(REGIONS).join(", ")}` });
      return;
    }
    try {
      const result = await searchCarriers({
        fleet_min: q.fleet_min !== undefined ? Number(q.fleet_min) : undefined,
        fleet_max: q.fleet_max !== undefined ? Number(q.fleet_max) : undefined,
        authority_status:
          q.authority === "any" || q.authority === "I" ? (q.authority as "any" | "I") : "A",
        states:
          typeof q.states === "string" && q.states.length > 0
            ? q.states.split(",").map((s) => s.trim().toUpperCase())
            : undefined,
        region: region as keyof typeof REGIONS | undefined,
        cargo_contains: typeof q.cargo === "string" && q.cargo.length >= 3 ? q.cargo : undefined,
        name_contains: typeof q.name === "string" && q.name.length >= 2 ? q.name : undefined,
        require_contact: q.require_contact === "1" || q.require_contact === "true",
        limit: q.limit !== undefined ? Number(q.limit) : 50,
        offset: q.offset !== undefined ? Number(q.offset) : 0,
      });
      send(res, result as ToolResult);
    } catch (err) {
      console.error("api/carriers/search error", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // GET /api/stats — dataset counts for the lookup page header
  app.get("/api/stats", async (_req, res) => {
    cors(_req as Request, res);
    try {
      // planner estimates — count(*) over the 5M+ row tables takes seconds
      const rows = await sql`
        SELECT (SELECT reltuples::bigint FROM pg_class WHERE relname = 'carrier') AS carriers,
               (SELECT reltuples::bigint FROM pg_class WHERE relname = 'inspection') AS inspections,
               (SELECT reltuples::bigint FROM pg_class WHERE relname = 'crash') AS crashes,
               (SELECT reltuples::bigint FROM pg_class WHERE relname = 'authority_history') AS authority_events,
               (SELECT reltuples::bigint FROM pg_class WHERE relname = 'insurance_filing') AS insurance_filings,
               (SELECT max(snapshot_date) FROM computed_basic_score) AS basic_snapshot
      `;
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.json(rows[0]);
    } catch (err) {
      console.error("api/stats error", err);
      res.status(500).json({ error: "Internal error" });
    }
  });
}
