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
