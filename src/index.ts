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

const FRED_KEY = process.env.FRED_API_KEY;
const BLS_KEY = process.env.BLS_API_KEY;
const BEA_KEY = process.env.BEA_API_KEY;

// ── Helpers ─────────────────────────────────────────────────────────────

async function fetchRetry(url: string | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); continue; }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      else throw err;
    }
  }
  throw new Error("fetchRetry exhausted");
}

function txt(text: string) { return { content: [{ type: "text" as const, text }] }; }

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
    if (!FRED_KEY) return txt("FRED_API_KEY not configured");
    const res = await fetchRetry(
      `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(query)}&api_key=${FRED_KEY}&file_type=json&limit=8`
    );
    const data = await res.json();
    const results = data.seriess?.map((s: { id: string; title: string; frequency: string; units: string }) =>
      `${s.id}: ${s.title} (${s.frequency}, ${s.units})`
    ).join("\n") ?? "No results";
    return txt(results);
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
    if (!FRED_KEY) return txt("FRED_API_KEY not configured");
    const [obsRes, infoRes] = await Promise.all([
      fetchRetry(`https://api.stlouisfed.org/fred/series/observations?series_id=${series_id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}&units=${units}`),
      fetchRetry(`https://api.stlouisfed.org/fred/series?series_id=${series_id}&api_key=${FRED_KEY}&file_type=json`),
    ]);
    if (!obsRes.ok) return txt(`FRED API error: ${obsRes.status}`);
    const data = await obsRes.json();
    if (data.error_code) return txt(data.error_message || `FRED error`);

    let title = series_id;
    let seriesUnits = "";
    if (infoRes.ok) {
      const info = await infoRes.json();
      const s = info.seriess?.[0];
      if (s?.title) title = s.title;
      if (s?.units) seriesUnits = s.units;
    }

    // Reflect transformation in title
    const suffixes: Record<string, string> = { pc1: " (YoY % Change)", pch: " (% Change)", chg: " (Change)", ch1: " (Change from Year Ago)" };
    if (units !== "lin" && suffixes[units]) title += suffixes[units];

    const observations = (data.observations ?? []) as { date: string; value: string }[];
    const lines = observations.filter(o => o.value !== ".").map(o => `${o.date}: ${o.value}`).join("\n");
    const source = `https://fred.stlouisfed.org/series/${series_id}`;
    return txt(`## ${title}\nSource: ${source}\nUnits: ${seriesUnits}\n\n${lines}`);
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
    const currentYear = new Date().getFullYear();
    const body: Record<string, unknown> = {
      seriesid: series_ids,
      startyear: start_year ?? String(currentYear - 3),
      endyear: end_year ?? String(currentYear),
      calculations: true,
      catalog: !series_ids.some(id => id.startsWith("JT")),
    };
    if (BLS_KEY) body.registrationkey = BLS_KEY;

    const res = await fetchRetry("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return txt(`BLS API error: ${res.status}`);
    const data = await res.json();
    if (data.status !== "REQUEST_SUCCEEDED") return txt(data.message?.join("; ") ?? "BLS error");

    const results = (data.Results?.series ?? []).map((s: {
      seriesID: string;
      catalog?: { series_title?: string };
      data: { year: string; period: string; value: string; calculations?: { pct_changes?: Record<string, string>; net_changes?: Record<string, string> } }[];
    }) => {
      const sid = s.seriesID;
      const isIndex = sid.startsWith("CU") || sid.startsWith("WP") || sid.startsWith("PC");
      const isEmployment = sid.startsWith("CE") || sid.startsWith("SM");
      const title = s.catalog?.series_title ?? sid;

      const lines = s.data
        .filter(d => d.period !== "M13" && d.value !== "-" && d.value !== "")
        .map(d => {
          const date = d.period.startsWith("M") ? `${d.year}-${d.period.slice(1)}` : d.year;
          let display = d.value;
          if (isIndex) {
            const yoy = d.calculations?.pct_changes?.["12"];
            if (yoy && yoy !== "") display = `${yoy}% YoY (index: ${d.value})`;
          } else if (isEmployment) {
            const chg = d.calculations?.net_changes?.["1"];
            if (chg && chg !== "") display = `${chg} change (level: ${d.value})`;
          }
          return `${date}: ${display}`;
        })
        .join("\n");

      let label = title;
      if (isIndex) label += " (YoY % Change)";
      else if (isEmployment) label += " (Monthly Change)";

      return `## ${label} (${sid})\nSource: https://data.bls.gov/timeseries/${sid}\n\n${lines}`;
    });

    return txt(results.join("\n\n---\n\n"));
  }
);

server.tool(
  "bls_series_lookup",
  "Find BLS series IDs by keyword. Has ~35 common series (CPI components, employment by industry, unemployment demographics, JOLTS). Also returns CPI metro area codes (S12A=NYC, S23A=Chicago, S49A=LA, etc.) for constructing regional CPI series IDs. Use this before bls_get_series when you don't know the ID.",
  { query: z.string().describe("Search terms, e.g. 'shelter CPI', 'construction employment', 'Black unemployment'") },
  async ({ query }) => {
    const catalog: Record<string, string> = {
      "CUSR0000SA0": "CPI All items, US, SA",
      "CUSR0000SA0L1E": "CPI Core (less food and energy), US, SA",
      "CUSR0000SAH1": "CPI Shelter, US, SA",
      "CUSR0000SAF11": "CPI Food at home, US, SA",
      "CUSR0000SAM": "CPI Medical care, US, SA",
      "CUSR0000SAT": "CPI Transportation, US, SA",
      "CUSR0000SETB01": "CPI Gasoline, US, SA",
      "CUSR0000SEHA": "CPI Rent of primary residence, US, SA",
      "CUSR0000SEHC": "CPI Owners equivalent rent, US, SA",
      "CES0000000001": "Total nonfarm employment, SA",
      "CES0500000003": "Avg hourly earnings, all private, SA",
      "CES2000000001": "Construction employment, SA",
      "CES3000000001": "Manufacturing employment, SA",
      "CES6562000001": "Health care employment, SA",
      "CES7000000001": "Leisure and hospitality employment, SA",
      "LNS14000000": "Unemployment rate (U-3), SA",
      "LNS13327709": "U-6 underemployment rate, SA",
      "LNS12300060": "Prime-age (25-54) EPOP, SA",
      "LNS14000006": "Unemployment rate, Black, SA",
      "LNS14000009": "Unemployment rate, Hispanic, SA",
      "JTS000000000000000JOL": "Job openings, total nonfarm",
      "JTS000000000000000QUL": "Quits, total nonfarm",
    };
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    const matches = Object.entries(catalog)
      .filter(([, t]) => terms.every(term => t.toLowerCase().includes(term)))
      .map(([id, t]) => `${id}: ${t}`);

    const cpiRef = "CPI area codes: S12A=NYC, S11A=Boston, S23A=Chicago, S23B=Detroit, S35A=DC, S35B=Miami, S37A=Dallas, S37B=Houston, S49A=LA, S49B=SF, S49D=Seattle. Format: CU+UR/SR+area+item. Example: CUURS12ASAF11 = NYC Food at home";

    return txt(matches.length > 0 ? matches.join("\n") + "\n\n" + cpiRef : "No matches in quick catalog.\n\n" + cpiRef);
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
    if (!BEA_KEY) return txt("BEA_API_KEY not configured");
    const params = new URLSearchParams({ UserID: BEA_KEY, method: "GetData", DataSetName: dataset, TableName: table_name, Frequency: frequency, Year: year, ResultFormat: "JSON" });
    const res = await fetchRetry(`https://apps.bea.gov/api/data/?${params}`);
    if (!res.ok) return txt(`BEA API error: ${res.status}`);
    const data = await res.json();
    const beaData = data?.BEAAPI?.Results;
    if (beaData?.Error) return txt(beaData.Error.APIErrorDescription ?? "BEA error");

    const rows = (beaData?.Data ?? []) as { LineDescription: string; TimePeriod: string; DataValue: string }[];
    const byLine = new Map<string, string[]>();
    for (const r of rows) {
      const key = r.LineDescription ?? "Data";
      if (!byLine.has(key)) byLine.set(key, []);
      const val = r.DataValue?.replace(/,/g, "");
      if (val && val !== "---") byLine.get(key)!.push(`${r.TimePeriod}: ${val}`);
    }

    const results = Array.from(byLine.entries()).slice(0, 15).map(([line, obs]) =>
      `## BEA: ${line}\n${obs.join("\n")}`
    );
    return txt(results.join("\n\n"));
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
    const url = new URL(`https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/${database_id}/${frequency}.${country_codes.join("+")}.${indicator}`);
    if (start_period) url.searchParams.set("startPeriod", start_period);
    if (end_period) url.searchParams.set("endPeriod", end_period);

    const res = await fetchRetry(url.toString());
    if (!res.ok) return txt(`IMF API error: ${res.status}`);
    const data = await res.json();
    const dataset = data?.CompactData?.DataSet;
    if (!dataset) return txt("No data from IMF");

    const raw = dataset.Series;
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const results = arr.map((s: { "@REF_AREA": string; "@INDICATOR": string; Obs: unknown }) => {
      const obs = Array.isArray(s.Obs) ? s.Obs : s.Obs ? [s.Obs] : [];
      const lines = obs.map((o: { "@TIME_PERIOD": string; "@OBS_VALUE": string }) =>
        `${o["@TIME_PERIOD"]}: ${o["@OBS_VALUE"]}`).join("\n");
      return `## IMF: ${s["@INDICATOR"]} (${s["@REF_AREA"]})\n${lines}`;
    });
    return txt(results.join("\n\n"));
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
    const url = new URL(`https://api.worldbank.org/v2/country/${country_codes.join(";")}/indicator/${indicator}`);
    url.searchParams.set("format", "json");
    url.searchParams.set("per_page", "100");
    if (start_year) url.searchParams.set("date", `${start_year}:${end_year ?? 2025}`);

    const res = await fetchRetry(url.toString());
    if (!res.ok) return txt(`World Bank API error: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return txt("No data");

    const rows = (data[1] ?? []) as { country: { value: string }; date: string; value: number | null }[];
    const byCountry = new Map<string, string[]>();
    for (const r of rows) {
      if (r.value == null) continue;
      const key = r.country?.value ?? "Unknown";
      if (!byCountry.has(key)) byCountry.set(key, []);
      byCountry.get(key)!.push(`${r.date}: ${r.value}`);
    }
    const results = Array.from(byCountry.entries()).map(([country, obs]) =>
      `## ${indicator} — ${country}\nSource: https://data.worldbank.org/indicator/${indicator}\n\n${obs.reverse().join("\n")}`
    );
    return txt(results.join("\n\n"));
  }
);

server.tool(
  "worldbank_search",
  "Search World Bank indicators by keyword.",
  { query: z.string().describe("e.g. 'GDP growth', 'poverty rate', 'CO2 emissions'") },
  async ({ query }) => {
    const url = new URL("https://api.worldbank.org/v2/indicator");
    url.searchParams.set("format", "json");
    url.searchParams.set("per_page", "10");
    url.searchParams.set("q", query);
    const res = await fetchRetry(url.toString());
    if (!res.ok) return txt(`World Bank error: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return txt("No results");
    const indicators = (data[1] ?? []).map((i: { id: string; name: string }) => `${i.id}: ${i.name}`).join("\n");
    return txt(indicators || "No results");
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
    const url = new URL(`https://data-api.ecb.europa.eu/service/data/${flow_ref}/${key}`);
    url.searchParams.set("format", "jsondata");
    if (start_period) url.searchParams.set("startPeriod", start_period);
    if (end_period) url.searchParams.set("endPeriod", end_period);

    const res = await fetchRetry(url.toString(), { headers: { Accept: "application/json" } });
    if (!res.ok) return txt(`ECB API error: ${res.status}`);
    const data = await res.json();
    const dataset = data?.dataSets?.[0];
    if (!dataset?.series) return txt("No ECB data");

    const timeDim = data?.structure?.dimensions?.observation?.find((d: { id: string }) => d.id === "TIME_PERIOD");
    const times: string[] = timeDim?.values?.map((v: { id: string }) => v.id) ?? [];

    const results = Object.entries(dataset.series).map(([, sd]: [string, unknown]) => {
      const s = sd as { observations: Record<string, [number]> };
      const lines = Object.entries(s.observations ?? {})
        .map(([idx, vals]) => `${times[Number(idx)] ?? idx}: ${vals[0]}`)
        .join("\n");
      return `## ECB: ${flow_ref}/${key}\n${lines}`;
    });
    return txt(results.join("\n\n"));
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
    if (!FRED_KEY) return txt("FRED_API_KEY not configured");
    const [fromRes, toRes] = await Promise.all([
      fetchRetry(`https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCNS&api_key=${FRED_KEY}&file_type=json&observation_start=${from_date}&observation_end=${from_date}&limit=1`),
      fetchRetry(`https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCNS&api_key=${FRED_KEY}&file_type=json&observation_start=${to_date}&observation_end=${to_date}&limit=1`),
    ]);
    const fromData = await fromRes.json();
    const toData = await toRes.json();
    const fromCPI = parseFloat(fromData.observations?.[0]?.value);
    const toCPI = parseFloat(toData.observations?.[0]?.value);
    if (isNaN(fromCPI) || isNaN(toCPI)) return txt("CPI data not available for requested dates");
    const adjusted = amount * (toCPI / fromCPI);
    return txt(`$${amount} from ${from_date} = $${(Math.round(adjusted * 100) / 100).toFixed(2)} in ${to_date} dollars\nCPI ${from_date}: ${fromCPI}\nCPI ${to_date}: ${toCPI}\nCumulative inflation: ${(Math.round(((toCPI / fromCPI) - 1) * 10000) / 100).toFixed(1)}%`);
  }
);

// ── Release Calendar ────────────────────────────────────────────────────

server.tool(
  "check_release_calendar",
  "Check if today is a major economic data release day (jobs, CPI, GDP, etc). If yes, use BLS/BEA direct instead of FRED.",
  {},
  async () => {
    if (!FRED_KEY) return txt("FRED_API_KEY not configured");
    const releases = [
      { id: 50, name: "Employment Situation", source: "BLS" },
      { id: 10, name: "CPI", source: "BLS" },
      { id: 46, name: "PPI", source: "BLS" },
      { id: 53, name: "GDP", source: "BEA" },
      { id: 54, name: "Personal Income", source: "BEA" },
      { id: 127, name: "JOLTS", source: "BLS" },
    ];
    const today = new Date().toISOString().slice(0, 10);
    const results: string[] = [];
    for (const rel of releases) {
      try {
        const res = await fetchRetry(`https://api.stlouisfed.org/fred/release/dates?release_id=${rel.id}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=3`);
        const data = await res.json();
        const dates = data.release_dates?.map((d: { date: string }) => d.date) ?? [];
        const isToday = dates.includes(today);
        results.push(`${rel.name}: last=${dates[0] ?? "?"} ${isToday ? "** RELEASED TODAY — use " + rel.source + " direct **" : ""}`);
      } catch {}
    }
    return txt(`Today: ${today}\n\n${results.join("\n")}`);
  }
);

// ── Start ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("EconStats MCP v2 running on stdio");
});
