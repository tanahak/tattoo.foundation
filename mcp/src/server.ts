import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// Carrier-lookup surface withdrawn 2026-07-12 (founder ruling): the carrier
// intelligence tools move behind the commercial data.carso.cloud door. The
// Foundation keeps its labor-protection tool (h2b_trucking_employers) only.
// To restore, uncomment the imports, registrations, and mountApi below.
import {
  // lookupCarrier,
  // lookupCarrierSchema,
  // carrierRevocationHistory,
  // revocationHistorySchema,
  // carrierInsuranceStatus,
  // insuranceStatusSchema,
  h2bTruckingEmployers,
  h2bTruckingSchema,
} from "./tools.js";
// import {
//   carrierSafetyHistory,
//   safetyHistorySchema,
//   carrierSafetyScores,
//   safetyScoresSchema,
// } from "./safety.js";
// import { searchCarriers, searchCarriersSchema } from "./search.js";
// import { mountApi } from "./api.js";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "tattoo-foundation",
    version: "0.3.0",
  });

  // Carrier-lookup tools withdrawn 2026-07-12 — see note at top of file.
  // server.registerTool(
  //   "lookup_carrier",
  //   {
  //     title: "Look up a carrier",
  //     description:
  //       "Verify a US commercial trucking carrier by USDOT number or legal/DBA name. Returns identity, fleet size, authority status, insurance, recent authority events, and red flags. Data sourced from the FMCSA SAFER census, donated to the TATTOO Foundation by Carso Cybernetics from the SuperTrucker platform.",
  //     inputSchema: lookupCarrierSchema,
  //   },
  //   lookupCarrier,
  // );

  // server.registerTool(
  //   "carrier_revocation_history",
  //   {
  //     title: "Carrier authority history",
  //     description:
  //       "Full authority-history timeline for a carrier (revocations, grants, suspensions, transfers, etc.) by USDOT number. Returns event-type breakdown and a chronological timeline. Useful for spotting chameleon-carrier patterns and prior revocations.",
  //     inputSchema: revocationHistorySchema,
  //   },
  //   carrierRevocationHistory,
  // );

  // server.registerTool(
  //   "carrier_insurance_status",
  //   {
  //     title: "Carrier insurance status",
  //     description:
  //       "FMCSA insurance filings for a carrier — active 91X auto liability and other filing types — with insurer, coverage amount, and dates. Flags if no active insurance is on record.",
  //     inputSchema: insuranceStatusSchema,
  //   },
  //   carrierInsuranceStatus,
  // );

  server.registerTool(
    "h2b_trucking_employers",
    {
      title: "H-2B trucking employer applications",
      description:
        "DOL H-2B labor disclosure data filtered to trucking SOC codes (53-30xx). Filterable by state, SOC code, fiscal year, and employer name. H-2B is visa-tied employment, structurally close to debt bondage; the TATTOO Foundation surfaces this for driver protection and labor-coercion pattern detection.",
      inputSchema: h2bTruckingSchema,
    },
    h2bTruckingEmployers,
  );

  // server.registerTool(
  //   "carrier_safety_history",
  //   {
  //     title: "Carrier crash & inspection history",
  //     description:
  //       "Crash record and roadside inspection history for a carrier by USDOT number. Returns crash totals (fatalities, injuries, tow-aways, hazmat), out-of-service rates vs national averages, violations broken down by BASIC category, and recent event lists. 24-month inspection window per FMCSA SMS methodology.",
  //     inputSchema: safetyHistorySchema,
  //   },
  //   carrierSafetyHistory,
  // );

  // server.registerTool(
  //   "carrier_safety_scores",
  //   {
  //     title: "Carrier BASIC safety scores",
  //     description:
  //       "Computed BASIC safety percentiles for a carrier by USDOT number — Unsafe Driving, HOS Compliance, Driver Fitness, Controlled Substances, Vehicle Maintenance, Hazmat Compliance. FMCSA SMS-style scores computed independently from public inspection data; flags intervention-threshold breaches. Percentile 0-100, higher = worse.",
  //     inputSchema: safetyScoresSchema,
  //   },
  //   carrierSafetyScores,
  // );

  // server.registerTool(
  //   "search_carriers",
  //   {
  //     title: "Search carriers by criteria",
  //     description:
  //       "Filter the 4.4M-carrier FMCSA census by fleet size range, authority status, state list or region (southeast/northeast/midwest/southwest/west), cargo classification (e.g. 'Refrigerated'), name substring, and contact-info availability. Returns up to 200 per page with phone/email when on file. For prospecting, market sizing, and building outreach lists.",
  //     inputSchema: searchCarriersSchema,
  //   },
  //   searchCarriers,
  // );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Per-session transport storage so streamable-HTTP can correlate requests
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = buildServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session ID" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// REST lookup API withdrawn with the carrier-lookup surface (2026-07-12).
// mountApi(app);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, name: "mcp-tattoo", version: "0.3.0" });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    "TATTOO Foundation labor-protection MCP server (H-2B trucking employer data).\n" +
      "MCP endpoint: POST /mcp (Streamable HTTP, MCP spec 2025-03-26+).\n" +
      "Health: GET /healthz\n" +
      "Discovery: https://tattoo.foundation/.well-known/mcp.json\n" +
      "Dataset built by Carso Cybernetics on the SuperTrucker platform; query access donated to the TATTOO Foundation, which publishes the data here.\n",
  );
});

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => {
  console.log(`mcp-tattoo listening on ${host}:${port}`);
});
