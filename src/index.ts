#!/usr/bin/env bun
/**
 * EconStats MCP Server v2
 *
 * Economic data tools with methodology guide.
 * FRED, BLS, BEA, IMF, World Bank, ECB + inflation adjustment.
 *
 * Usage:
 *   bunx econstats-mcp          (stdio, for Claude Desktop/Code)
 *   FRED_API_KEY=xxx bun src/index.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EconStatsCoreClient } from "./core/client";

function txt(text: string) { return { content: [{ type: "text" as const, text }] }; }
const client = new EconStatsCoreClient();

// ── Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "econstats",
  version: "2.0.0",
  instructions: `You are an expert economic analyst. Plain English in, cited analysis out.

HARD RULES:
- NO emojis. NO "Let me fetch..." narration. Just present results.
- Every fact needs a citation. If you can't cite it, cut it.
- Be concise: 200-300 words, lead with the answer.
- For inflation indexes (CPI, PCE, PPI), always interpret as YoY % change, not raw levels.
- Don't compute averages or trends in your head — cite specific data points.

SOURCE ROUTING:
- US macro → fred_get_series (check series_id from common IDs below)
- Granular CPI/employment (metro, industry) → bls_get_series
- GDP detail, state GDP → bea_get_data
- International (recent) → imf_get_data
- International (long-run) → worldbank_get_data
- Euro area → ecb_get_data
- "What is $X worth today?" → inflation_adjust
- Release day (jobs, CPI, GDP) → check_release_calendar, then BLS/BEA direct

METHODOLOGY (what makes this different):
- "Jobs added?" → use change, not level. "Unemployment?" → consider U-6 alongside U-3.
- "How tight is the labor market?" → prime-age EPOP (LNS12300060) + JOLTS openings + quits rate.
- CPI vs PCE: CPI for general, PCE for Fed policy. CPI shelter LAGS market rents.
- GDP: always real (GDPC1). Quarterly figures are annualized. Advance estimates get revised.
- "Real wages" has multiple measures — explain which you're using.
- BLS data values are index levels with YoY annotations. Charts plot the level.

COMMON FRED IDS:
PAYEMS (nonfarm payrolls), UNRATE (unemployment), U6RATE (broad), LNS12300060 (prime-age EPOP),
CPIAUCSL (CPI), CPILFESL (core CPI), PCEPILFE (core PCE), GDPC1 (real GDP),
A191RL1Q225SBEA (GDP growth), FEDFUNDS (fed funds), DGS10 (10yr treasury), DGS2 (2yr),
T10Y2Y (yield curve), MORTGAGE30US (30yr mortgage), HOUST (housing starts),
CSUSHPINSA (Case-Shiller), SP500 (S&P 500), JTSJOL (job openings), JTSQUR (quits rate),
CES0500000003 (avg hourly earnings), RSAFS (retail sales), PSAVERT (savings rate).`,
});

// ── FRED ────────────────────────────────────────────────────────────────

server.tool(
  "fred_search",
  "Search for FRED economic data series by keyword. FRED has 800K+ US series covering GDP, employment, inflation, interest rates, housing, trade, and more. Use this when you don't know the series ID. Common IDs you can use directly with fred_get_series: UNRATE (unemployment), PAYEMS (nonfarm payrolls), CPIAUCSL (CPI), PCEPILFE (core PCE), GDPC1 (real GDP), FEDFUNDS (fed funds rate), DGS10 (10yr Treasury), MORTGAGE30US (30yr mortgage), HOUST (housing starts), SP500 (S&P 500).",
  { query: z.string().describe("Search terms, e.g. 'housing starts' or 'consumer sentiment'") },
  async ({ query }) => {
    return txt(await client.fredSearch(query));
  }
);

server.tool(
  "fred_get_series",
  "Fetch FRED time series data with optional transformations. CRITICAL: For inflation indexes (CPIAUCSL, PCEPILFE, PPI), use units='pc1' to get year-over-year % change — raw index levels are meaningless to users. For employment (PAYEMS), use units='chg' to get monthly change in jobs. For rates (UNRATE, FEDFUNDS, DGS10), use units='lin' (default) since they're already in useful units. GDP: always use real GDP (GDPC1), never nominal.",
  {
    series_id: z.string().describe("FRED series ID, e.g. CPIAUCSL, UNRATE, GDPC1"),
    limit: z.number().default(36).describe("Observations (default 36 = 3 years monthly)"),
    units: z.enum(["lin", "pc1", "pch", "ch1", "chg"]).default("lin").describe("lin=levels, pc1=YoY%, pch=MoM%, chg=change"),
  },
  async ({ series_id, limit, units }) => {
    return txt(await client.fredGetSeries(series_id, limit, units));
  }
);

// ── BLS ─────────────────────────────────────────────────────────────────

server.tool(
  "bls_get_series",
  "Fetch data direct from Bureau of Labor Statistics. Use instead of FRED when: (1) you need data on release day (BLS publishes at 8:30am ET, FRED lags 30-60 min), (2) you need metro-area CPI or state employment detail FRED doesn't have. Returns pre-computed YoY% for CPI/PPI indexes and monthly change for employment series automatically. For labor market analysis, consider fetching multiple series: unemployment (LNS14000000) + prime-age EPOP (LNS12300060) + job openings (JTS000000000000000JOL) gives a much fuller picture than unemployment alone.",
  {
    series_ids: z.array(z.string()).min(1).max(50).describe("BLS series IDs, e.g. ['CUSR0000SA0', 'CES0000000001']"),
    start_year: z.string().optional().describe("Start year, e.g. '2022'"),
    end_year: z.string().optional().describe("End year, e.g. '2026'"),
  },
  async ({ series_ids, start_year, end_year }) => {
    return txt(await client.blsGetSeries(series_ids, start_year, end_year));
  }
);

server.tool(
  "bls_series_lookup",
  "Find BLS series IDs by keyword. Has ~35 common series (CPI components, employment by industry, unemployment demographics, JOLTS). Also returns CPI metro area codes (S12A=NYC, S23A=Chicago, S49A=LA, etc.) for constructing regional CPI series IDs. Use this before bls_get_series when you don't know the ID.",
  { query: z.string().describe("Search terms, e.g. 'shelter CPI', 'construction employment', 'Black unemployment'") },
  async ({ query }) => {
    return txt(await client.blsSeriesLookup(query));
  }
);

// ── BEA ─────────────────────────────────────────────────────────────────

server.tool(
  "bea_get_data",
  "Fetch BEA national accounts data (GDP components, personal income, trade). Most GDP data is also on FRED — use this for detailed NIPA table breakdowns.",
  {
    dataset: z.enum(["NIPA", "Regional", "GDPbyIndustry"]).describe("NIPA for GDP, Regional for state data"),
    table_name: z.string().describe("e.g. T10101 (GDP), T10106 (contributions), SAGDP2N (state GDP)"),
    frequency: z.enum(["A", "Q", "M"]).default("Q"),
    year: z.string().default("LAST5"),
  },
  async ({ dataset, table_name, frequency, year }) => {
    return txt(await client.beaGetData(dataset, table_name, frequency, year));
  }
);

// ── IMF ─────────────────────────────────────────────────────────────────

server.tool(
  "imf_get_data",
  "Fetch IMF International Financial Statistics. Best for cross-country macro comparisons with RECENT data (quarterly/monthly, few months lag). Use for: comparing inflation, GDP, exchange rates across countries. Common indicators: PCPI_PC_CP_A_PT (CPI % change), NGDP_XDC (nominal GDP), ENDA_XDC_USD_RATE (exchange rate). Country codes are ISO2 (US, GB, DE, JP, CN). For long-run structural data (poverty, education, demographics), use worldbank_get_data instead.",
  {
    database_id: z.enum(["IFS", "DOT", "BOP"]).describe("IFS=financial stats, DOT=trade, BOP=balance of payments"),
    frequency: z.enum(["A", "Q", "M"]).default("A"),
    country_codes: z.array(z.string()).describe("ISO2 codes, e.g. ['US', 'DE', 'JP']"),
    indicator: z.string().describe("e.g. PCPI_PC_CP_A_PT (CPI % change), NGDP_XDC (GDP)"),
    start_period: z.string().optional(),
    end_period: z.string().optional(),
  },
  async ({ database_id, frequency, country_codes, indicator, start_period, end_period }) => {
    return txt(await client.imfGetData({
      databaseId: database_id,
      frequency,
      countryCodes: country_codes,
      indicator,
      startPeriod: start_period,
      endPeriod: end_period,
    }));
  }
);

// ── World Bank ──────────────────────────────────────────────────────────

server.tool(
  "worldbank_get_data",
  "Fetch World Bank development indicators. Best for long-run cross-country comparisons (annual data, may lag 1-2 years). Covers 200+ countries. Common indicators: NY.GDP.MKTP.KD.ZG (GDP growth %), FP.CPI.TOTL.ZG (inflation %), SL.UEM.TOTL.ZS (unemployment %), SP.POP.TOTL (population). Use 'WLD' for world aggregate, 'OED' for OECD. For recent/current data, use imf_get_data instead.",
  {
    country_codes: z.array(z.string()).describe("ISO2/ISO3 codes. 'WLD'=world, 'OED'=OECD"),
    indicator: z.string().describe("e.g. NY.GDP.MKTP.KD.ZG (GDP growth), FP.CPI.TOTL.ZG (inflation)"),
    start_year: z.number().optional(),
    end_year: z.number().optional(),
  },
  async ({ country_codes, indicator, start_year, end_year }) => {
    return txt(await client.worldBankGetData({
      countryCodes: country_codes,
      indicator,
      startYear: start_year,
      endYear: end_year,
    }));
  }
);

server.tool(
  "worldbank_search",
  "Search World Bank indicators by keyword.",
  { query: z.string().describe("e.g. 'GDP growth', 'poverty rate', 'CO2 emissions'") },
  async ({ query }) => {
    return txt(await client.worldBankSearch(query));
  }
);

// ── ECB ─────────────────────────────────────────────────────────────────

server.tool(
  "ecb_get_data",
  "Fetch ECB data. Euro area rates, HICP inflation, money supply, exchange rates.",
  {
    flow_ref: z.string().describe("EXR (exchange rates), FM (financial), ICP (HICP), BSI (money supply)"),
    key: z.string().describe("e.g. 'M.U2.N.000000.4.ANR' for euro HICP YoY"),
    start_period: z.string().optional(),
    end_period: z.string().optional(),
  },
  async ({ flow_ref, key, start_period, end_period }) => {
    return txt(await client.ecbGetData({
      flowRef: flow_ref,
      key,
      startPeriod: start_period,
      endPeriod: end_period,
    }));
  }
);

// ── Inflation Adjust ────────────────────────────────────────────────────

server.tool(
  "inflation_adjust",
  "Convert dollar amounts between dates using CPI-U. Use for: 'what is $X worth today?', real wages, inflation-adjusted prices, purchasing power comparisons. Returns the adjusted amount with source CPI values so the result is fully citable. Note: 'real wages' has multiple valid measures — this tool adjusts a single dollar amount, not a time series.",
  {
    amount: z.number().describe("Dollar amount to convert"),
    from_date: z.string().describe("Original date, YYYY-MM-01"),
    to_date: z.string().describe("Target date, YYYY-MM-01"),
  },
  async ({ amount, from_date, to_date }) => {
    return txt(await client.inflationAdjust(amount, from_date, to_date));
  }
);

// ── Release Calendar ────────────────────────────────────────────────────

server.tool(
  "check_release_calendar",
  "Check if today is a major economic data release day (jobs, CPI, GDP, etc). If yes, use BLS/BEA direct instead of FRED.",
  {},
  async () => {
    return txt(await client.checkReleaseCalendar());
  }
);

// ── Start ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("EconStats MCP v2 running on stdio");
  if (process.env.PREFETCH_HOT_SERIES === "true") {
    client.prefetchReleaseDaySeries();
  }
});
