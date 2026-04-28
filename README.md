# econstats-mcp

Economic data MCP server with an economist's methodology guide. Connects FRED, BLS, BEA, IMF, World Bank, and ECB to any MCP-compatible client.

## What makes it different

Not just data access — the server includes methodology rules that teach LLMs which series to pick:

- CPI vs PCE for inflation (and why they diverge)
- Prime-age EPOP vs headline unemployment for labor market tightness
- YoY % change for CPI/PPI indexes, monthly change for employment
- BLS direct on release day (FRED lags 30-60 minutes)
- Real wages: explains which of 4 measures it's using and why

## Quick Start

```bash
# Install Bun if needed
curl -fsSL https://bun.sh/install | bash

# Run (get a free FRED API key at https://fred.stlouisfed.org/docs/api/api_key.html)
FRED_API_KEY=your-key bunx econstats-mcp
```

## Setup

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "econstats": {
      "command": "bunx",
      "args": ["econstats-mcp"],
      "env": { "FRED_API_KEY": "your-key" }
    }
  }
}
```

### Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "econstats": {
      "type": "stdio",
      "command": "bunx",
      "args": ["econstats-mcp"],
      "env": { "FRED_API_KEY": "your-key" }
    }
  }
}
```

### OpenBB

Connect as an MCP server in the OpenBB workspace AI settings.

## API Keys

| Key | Required | Get it |
|-----|----------|--------|
| `FRED_API_KEY` | Yes | https://fred.stlouisfed.org/docs/api/api_key.html (free) |
| `BLS_API_KEY` | Optional | https://data.bls.gov/registrationEngine/ (free, higher rate limits) |
| `BEA_API_KEY` | Optional | https://apps.bea.gov/API/signup/ (free, for GDP detail) |

IMF, World Bank, and ECB need no keys.

## Caching

The server now uses a two-layer cache:

- L1: in-process memory cache for hot repeated queries in a single MCP process
- L2: optional shared Redis cache for cross-process or hosted deployments

If you are running a shared MCP endpoint for OpenBB users, set these optional env vars:

| Key | Required | Purpose |
|-----|----------|---------|
| `UPSTASH_REDIS_REST_URL` | Optional | Shared cache backend URL |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Shared cache backend token |
| `CACHE_NAMESPACE` | Optional | Cache prefix, defaults to `econstats:v2` |
| `PREFETCH_HOT_SERIES` | Optional | Set to `true` only for long-lived hosted processes |

TTL policy is source-aware:

- Hot FRED series like `PAYEMS`, `UNRATE`, `CPIAUCSL`, `CPILFESL`, `PCEPILFE`: 15 minutes
- Standard FRED series: 6 hours
- BLS / BEA: 6-12 hours
- IMF / ECB: 24 hours
- World Bank and BLS lookup catalogs: days to weeks
- Release calendar: 15 minutes

The cache layer also deduplicates in-flight requests, so a burst of identical OpenBB tool calls only triggers one upstream API request.

Startup prefetch is disabled by default because short-lived stdio clients can create unnecessary upstream traffic. Turn it on only when you are running a persistent shared MCP service.

## Tools (11)

| Tool | Description |
|------|-------------|
| `fred_search` | Search FRED series by keyword |
| `fred_get_series` | Fetch FRED data with transformations (YoY%, change, etc.) |
| `bls_get_series` | Fetch BLS data with pre-computed YoY% and monthly changes |
| `bls_series_lookup` | Find BLS series IDs by keyword |
| `bea_get_data` | BEA national accounts (GDP components, state data) |
| `imf_get_data` | IMF International Financial Statistics (190 countries) |
| `worldbank_get_data` | World Bank development indicators (200+ countries) |
| `worldbank_search` | Search World Bank indicators |
| `ecb_get_data` | ECB data (euro area rates, HICP, money supply) |
| `inflation_adjust` | Convert dollar amounts between dates using CPI-U |
| `check_release_calendar` | Check if today is a data release day |

## Data Sources

All data comes from free, public government APIs. We attribute all data to its source agency (Federal Reserve, BLS, BEA, IMF, World Bank, ECB). No data is redistributed — each query fetches directly from the source.

## License

MIT
