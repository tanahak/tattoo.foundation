# TATTOO Foundation MCP Server

Public Model Context Protocol server published by the **TATTOO Foundation**
at `mcp.tattoo.foundation`. This is the Foundation-branded carrier-intelligence
surface — agents and AI clients reach the Foundation here as the publisher.

The dataset behind it was **built by Carso Cybernetics on the SuperTrucker
platform**; query access was donated to the Foundation for free, public,
driver-protective use. The same dataset also ships through:

- `mcp.supertrucker.ai` (SuperTrucker product surface — `SuperTrucker-Platform/packages/mcp`)
- `mcp.carsocybernetics.com` (Carso Cybernetics commercial surface — `carso-site/mcp`)

Each MCP exposes the same four tools with branded framing.

## Tools

- `lookup_carrier(dot_number | name)` — verify any US trucking carrier
- `carrier_revocation_history(dot_number)` — full authority-history timeline
- `carrier_insurance_status(dot_number)` — FMCSA insurance filings
- `h2b_trucking_employers(state?, soc_code?, fiscal_year?)` — DOL H-2B trucking filings

## Deploy (manual SSH-pull pattern)

```bash
ssh -i ~/.ssh/supertrucker_spine root@198.199.85.122
cd /root/tattoo.foundation && git pull
cd mcp && npm install && npm run build
systemctl restart mcp-tattoo
journalctl -u mcp-tattoo -n 20 --no-pager
```

CI-driven deploy on push-to-main is queued for the next sprint.

## Local dev

```bash
npm install
DATABASE_URL=postgresql://... \
  JWT_PRIVATE_KEY_PATH=... \
  JWT_PUBLIC_KEY_PATH=... \
  JWT_KID=... \
  npm run build && node dist/server.js
```

The server binds to `127.0.0.1:4100` by default; Caddy fronts it for TLS.
