import { createLayeredCache, type LayeredCache } from "./cache";
import { fetchRetry } from "./http";

type FredUnits = "lin" | "pc1" | "pch" | "ch1" | "chg";

const CITATION_RULE =
  `CITATION RULE: Any number you state MUST come from this tool's data — NEVER from your training data. After every number, cite the source and date: (Source Name, Mon YYYY). Example: "unemployment was 4.3% (FRED: Unemployment Rate, Mar 2026)". If a number is not in the data above, do not state it.`;

const TTL = {
  fredSearch: 24 * 60 * 60,
  fredSeriesMeta: 24 * 60 * 60,
  fredSeriesHot: 15 * 60,
  fredSeriesStandard: 6 * 60 * 60,
  blsSeries: 6 * 60 * 60,
  blsLookup: 30 * 24 * 60 * 60,
  beaData: 12 * 60 * 60,
  imfData: 24 * 60 * 60,
  worldBankData: 7 * 24 * 60 * 60,
  worldBankSearch: 7 * 24 * 60 * 60,
  ecbData: 24 * 60 * 60,
  inflationAdjust: 30 * 24 * 60 * 60,
  releaseCalendar: 15 * 60,
} as const;

const HOT_FRED_SERIES = new Set([
  "PAYEMS",
  "UNRATE",
  "CPIAUCSL",
  "CPILFESL",
  "GDPC1",
  "A191RL1Q225SBEA",
  "JTSJOL",
  "PCEPILFE",
]);

function cited(source: string, title: string, data: string): string {
  return `SOURCE: ${title}\nURL: ${source}\n\n${data}\n\n${CITATION_RULE}`;
}

export class EconStatsCoreClient {
  private cache: LayeredCache;

  constructor(
    private env = {
      FRED_KEY: process.env.FRED_API_KEY,
      BLS_KEY: process.env.BLS_API_KEY,
      BEA_KEY: process.env.BEA_API_KEY,
    },
    cache = createLayeredCache(),
  ) {
    this.cache = cache;
  }

  private fredSeriesTtl(seriesId: string): number {
    return HOT_FRED_SERIES.has(seriesId) ? TTL.fredSeriesHot : TTL.fredSeriesStandard;
  }

  async fredSearch(query: string): Promise<string> {
    if (!this.env.FRED_KEY) return "FRED_API_KEY not configured";

    const key = `fred:search:${query.trim().toLowerCase()}`;
    return this.cache.getOrCompute(key, TTL.fredSearch, async () => {
      const res = await fetchRetry(
        `https://api.stlouisfed.org/fred/series/search?search_text=${encodeURIComponent(query)}&api_key=${this.env.FRED_KEY}&file_type=json&limit=8`,
      );
      const data = await res.json();
      return (
        data.seriess
          ?.map(
            (s: { id: string; title: string; frequency: string; units: string }) =>
              `${s.id}: ${s.title} (${s.frequency}, ${s.units})`,
          )
          .join("\n") ?? "No results"
      );
    });
  }

  async fredGetSeries(
    seriesId: string,
    limit: number,
    units: FredUnits,
  ): Promise<string> {
    if (!this.env.FRED_KEY) return "FRED_API_KEY not configured";

    const obsKey = `fred:obs:${seriesId}:limit=${limit}:units=${units}`;
    const infoKey = `fred:info:${seriesId}`;

    const [obsText, infoText] = await Promise.all([
      this.cache.getOrCompute(obsKey, this.fredSeriesTtl(seriesId), async () => {
        const res = await fetchRetry(
          `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${this.env.FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}&units=${units}`,
        );
        return await res.text();
      }),
      this.cache.getOrCompute(infoKey, TTL.fredSeriesMeta, async () => {
        const res = await fetchRetry(
          `https://api.stlouisfed.org/fred/series?series_id=${seriesId}&api_key=${this.env.FRED_KEY}&file_type=json`,
        );
        return await res.text();
      }),
    ]);

    const data = JSON.parse(obsText);
    if (data.error_code) return data.error_message || "FRED error";

    let title = seriesId;
    try {
      const info = JSON.parse(infoText);
      const series = info.seriess?.[0];
      if (series?.title) title = series.title;
    } catch {}

    const suffixes: Partial<Record<FredUnits, string>> = {
      pc1: " (YoY % Change)",
      pch: " (% Change)",
      chg: " (Change)",
      ch1: " (Change from Year Ago)",
    };
    if (units !== "lin" && suffixes[units]) title += suffixes[units];

    const observations = (data.observations ?? []) as { date: string; value: string }[];
    const lines = observations
      .filter((observation) => observation.value !== ".")
      .map((observation) => `${observation.date}: ${observation.value}`)
      .join("\n");

    return cited(
      `https://fred.stlouisfed.org/series/${seriesId}`,
      `FRED: ${title}`,
      lines,
    );
  }

  async blsGetSeries(
    seriesIds: string[],
    startYear?: string,
    endYear?: string,
  ): Promise<string> {
    const currentYear = new Date().getFullYear();
    const sy = startYear ?? String(currentYear - 3);
    const ey = endYear ?? String(currentYear);
    const key = `bls:series:${seriesIds.join(",")}:start=${sy}:end=${ey}`;

    return this.cache.getOrCompute(key, TTL.blsSeries, async () => {
      const body: Record<string, unknown> = {
        seriesid: seriesIds,
        startyear: sy,
        endyear: ey,
        calculations: true,
        catalog: !seriesIds.some((id) => id.startsWith("JT")),
      };
      if (this.env.BLS_KEY) body.registrationkey = this.env.BLS_KEY;

      const res = await fetchRetry("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return `BLS API error: ${res.status}`;

      const data = await res.json();
      if (data.status !== "REQUEST_SUCCEEDED") {
        return data.message?.join("; ") ?? "BLS error";
      }

      const results = (data.Results?.series ?? []).map(
        (series: {
          seriesID: string;
          catalog?: { series_title?: string };
          data: {
            year: string;
            period: string;
            value: string;
            calculations?: {
              pct_changes?: Record<string, string>;
              net_changes?: Record<string, string>;
            };
          }[];
        }) => {
          const sid = series.seriesID;
          const isIndex = sid.startsWith("CU") || sid.startsWith("WP") || sid.startsWith("PC");
          const isEmployment = sid.startsWith("CE") || sid.startsWith("SM");
          const title = series.catalog?.series_title ?? sid;

          const lines = series.data
            .filter((row) => row.period !== "M13" && row.value !== "-" && row.value !== "")
            .map((row) => {
              const date = row.period.startsWith("M")
                ? `${row.year}-${row.period.slice(1)}`
                : row.year;
              let display = row.value;
              if (isIndex) {
                const yoy = row.calculations?.pct_changes?.["12"];
                if (yoy && yoy !== "") display = `${yoy}% YoY (index: ${row.value})`;
              } else if (isEmployment) {
                const change = row.calculations?.net_changes?.["1"];
                if (change && change !== "") display = `${change} change (level: ${row.value})`;
              }
              return `${date}: ${display}`;
            })
            .join("\n");

          let label = title;
          if (isIndex) label += " (YoY % Change)";
          else if (isEmployment) label += " (Monthly Change)";

          return `## ${label} (${sid})\nSource: https://data.bls.gov/timeseries/${sid}\n\n${lines}`;
        },
      );

      return results.join("\n\n---\n\n") + "\n\n" + CITATION_RULE;
    });
  }

  async blsSeriesLookup(query: string): Promise<string> {
    const key = `bls:lookup:${query.trim().toLowerCase()}`;
    return this.cache.getOrCompute(key, TTL.blsLookup, async () => {
      const catalog: Record<string, string> = {
        CUSR0000SA0: "CPI All items, US, SA",
        CUSR0000SA0L1E: "CPI Core (less food and energy), US, SA",
        CUSR0000SAH1: "CPI Shelter, US, SA",
        CUSR0000SAF11: "CPI Food at home, US, SA",
        CUSR0000SAM: "CPI Medical care, US, SA",
        CUSR0000SAT: "CPI Transportation, US, SA",
        CUSR0000SETB01: "CPI Gasoline, US, SA",
        CUSR0000SEHA: "CPI Rent of primary residence, US, SA",
        CUSR0000SEHC: "CPI Owners equivalent rent, US, SA",
        CES0000000001: "Total nonfarm employment, SA",
        CES0500000003: "Avg hourly earnings, all private, SA",
        CES2000000001: "Construction employment, SA",
        CES3000000001: "Manufacturing employment, SA",
        CES6562000001: "Health care employment, SA",
        CES7000000001: "Leisure and hospitality employment, SA",
        LNS14000000: "Unemployment rate (U-3), SA",
        LNS13327709: "U-6 underemployment rate, SA",
        LNS12300060: "Prime-age (25-54) EPOP, SA",
        LNS14000006: "Unemployment rate, Black, SA",
        LNS14000009: "Unemployment rate, Hispanic, SA",
        JTS000000000000000JOL: "Job openings, total nonfarm",
        JTS000000000000000QUL: "Quits, total nonfarm",
      };

      const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
      const matches = Object.entries(catalog)
        .filter(([, title]) => terms.every((term) => title.toLowerCase().includes(term)))
        .map(([id, title]) => `${id}: ${title}`);

      const cpiRef =
        "CPI area codes: S12A=NYC, S11A=Boston, S23A=Chicago, S23B=Detroit, S35A=DC, S35B=Miami, S37A=Dallas, S37B=Houston, S49A=LA, S49B=SF, S49D=Seattle. Format: CU+UR/SR+area+item. Example: CUURS12ASAF11 = NYC Food at home";

      return matches.length > 0
        ? matches.join("\n") + "\n\n" + cpiRef
        : "No matches in quick catalog.\n\n" + cpiRef;
    });
  }

  async beaGetData(
    dataset: "NIPA" | "Regional" | "GDPbyIndustry",
    tableName: string,
    frequency: "A" | "Q" | "M",
    year: string,
  ): Promise<string> {
    if (!this.env.BEA_KEY) return "BEA_API_KEY not configured";

    const key = `bea:data:${dataset}:table=${tableName}:freq=${frequency}:year=${year}`;
    return this.cache.getOrCompute(key, TTL.beaData, async () => {
      const params = new URLSearchParams({
        UserID: this.env.BEA_KEY!,
        method: "GetData",
        DataSetName: dataset,
        TableName: tableName,
        Frequency: frequency,
        Year: year,
        ResultFormat: "JSON",
      });
      const res = await fetchRetry(`https://apps.bea.gov/api/data/?${params}`);
      if (!res.ok) return `BEA API error: ${res.status}`;

      const data = await res.json();
      const beaData = data?.BEAAPI?.Results;
      if (beaData?.Error) {
        return beaData.Error.APIErrorDescription ?? "BEA error";
      }

      const rows = (beaData?.Data ?? []) as {
        LineDescription: string;
        TimePeriod: string;
        DataValue: string;
      }[];
      const byLine = new Map<string, string[]>();
      for (const row of rows) {
        const line = row.LineDescription ?? "Data";
        if (!byLine.has(line)) byLine.set(line, []);
        const value = row.DataValue?.replace(/,/g, "");
        if (value && value !== "---") {
          byLine.get(line)!.push(`${row.TimePeriod}: ${value}`);
        }
      }

      return Array.from(byLine.entries())
        .slice(0, 15)
        .map(([line, observations]) => `## BEA: ${line}\n${observations.join("\n")}`)
        .join("\n\n");
    });
  }

  async imfGetData(params: {
    databaseId: "IFS" | "DOT" | "BOP";
    frequency: "A" | "Q" | "M";
    countryCodes: string[];
    indicator: string;
    startPeriod?: string;
    endPeriod?: string;
  }): Promise<string> {
    const key = `imf:data:${params.databaseId}:freq=${params.frequency}:countries=${params.countryCodes.join("+")}:indicator=${params.indicator}:start=${params.startPeriod ?? ""}:end=${params.endPeriod ?? ""}`;
    return this.cache.getOrCompute(key, TTL.imfData, async () => {
      const url = new URL(
        `https://dataservices.imf.org/REST/SDMX_JSON.svc/CompactData/${params.databaseId}/${params.frequency}.${params.countryCodes.join("+")}.${params.indicator}`,
      );
      if (params.startPeriod) url.searchParams.set("startPeriod", params.startPeriod);
      if (params.endPeriod) url.searchParams.set("endPeriod", params.endPeriod);

      const res = await fetchRetry(url.toString());
      if (!res.ok) return `IMF API error: ${res.status}`;

      const data = await res.json();
      const dataset = data?.CompactData?.DataSet;
      if (!dataset) return "No data from IMF";

      const rawSeries = dataset.Series;
      const seriesArray = Array.isArray(rawSeries)
        ? rawSeries
        : rawSeries
          ? [rawSeries]
          : [];

      return seriesArray
        .map((series: { "@REF_AREA": string; "@INDICATOR": string; Obs: unknown }) => {
          const observations = Array.isArray(series.Obs)
            ? series.Obs
            : series.Obs
              ? [series.Obs]
              : [];
          const lines = observations
            .map(
              (obs: { "@TIME_PERIOD": string; "@OBS_VALUE": string }) =>
                `${obs["@TIME_PERIOD"]}: ${obs["@OBS_VALUE"]}`,
            )
            .join("\n");
          return `## IMF: ${series["@INDICATOR"]} (${series["@REF_AREA"]})\n${lines}`;
        })
        .join("\n\n");
    });
  }

  async worldBankGetData(params: {
    countryCodes: string[];
    indicator: string;
    startYear?: number;
    endYear?: number;
  }): Promise<string> {
    const key = `worldbank:data:countries=${params.countryCodes.join(";")}:indicator=${params.indicator}:start=${params.startYear ?? ""}:end=${params.endYear ?? ""}`;
    return this.cache.getOrCompute(key, TTL.worldBankData, async () => {
      const url = new URL(
        `https://api.worldbank.org/v2/country/${params.countryCodes.join(";")}/indicator/${params.indicator}`,
      );
      url.searchParams.set("format", "json");
      url.searchParams.set("per_page", "100");
      if (params.startYear) {
        url.searchParams.set("date", `${params.startYear}:${params.endYear ?? 2025}`);
      }

      const res = await fetchRetry(url.toString());
      if (!res.ok) return `World Bank API error: ${res.status}`;

      const data = await res.json();
      if (!Array.isArray(data) || data.length < 2) return "No data";

      const rows = (data[1] ?? []) as {
        country: { value: string };
        date: string;
        value: number | null;
      }[];
      const byCountry = new Map<string, string[]>();
      for (const row of rows) {
        if (row.value == null) continue;
        const country = row.country?.value ?? "Unknown";
        if (!byCountry.has(country)) byCountry.set(country, []);
        byCountry.get(country)!.push(`${row.date}: ${row.value}`);
      }

      return Array.from(byCountry.entries())
        .map(
          ([country, observations]) =>
            `## ${params.indicator} — ${country}\nSource: https://data.worldbank.org/indicator/${params.indicator}\n\n${observations.reverse().join("\n")}`,
        )
        .join("\n\n");
    });
  }

  async worldBankSearch(query: string): Promise<string> {
    const key = `worldbank:search:${query.trim().toLowerCase()}`;
    return this.cache.getOrCompute(key, TTL.worldBankSearch, async () => {
      const url = new URL("https://api.worldbank.org/v2/indicator");
      url.searchParams.set("format", "json");
      url.searchParams.set("per_page", "10");
      url.searchParams.set("q", query);

      const res = await fetchRetry(url.toString());
      if (!res.ok) return `World Bank error: ${res.status}`;

      const data = await res.json();
      if (!Array.isArray(data) || data.length < 2) return "No results";

      return (
        (data[1] ?? [])
          .map((indicator: { id: string; name: string }) => `${indicator.id}: ${indicator.name}`)
          .join("\n") || "No results"
      );
    });
  }

  async ecbGetData(params: {
    flowRef: string;
    key: string;
    startPeriod?: string;
    endPeriod?: string;
  }): Promise<string> {
    const cacheKey = `ecb:data:flow=${params.flowRef}:key=${params.key}:start=${params.startPeriod ?? ""}:end=${params.endPeriod ?? ""}`;
    return this.cache.getOrCompute(cacheKey, TTL.ecbData, async () => {
      const url = new URL(`https://data-api.ecb.europa.eu/service/data/${params.flowRef}/${params.key}`);
      url.searchParams.set("format", "jsondata");
      if (params.startPeriod) url.searchParams.set("startPeriod", params.startPeriod);
      if (params.endPeriod) url.searchParams.set("endPeriod", params.endPeriod);

      const res = await fetchRetry(url.toString(), {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return `ECB API error: ${res.status}`;

      const data = await res.json();
      const dataset = data?.dataSets?.[0];
      if (!dataset?.series) return "No ECB data";

      const timeDim = data?.structure?.dimensions?.observation?.find(
        (dimension: { id: string }) => dimension.id === "TIME_PERIOD",
      );
      const times: string[] = timeDim?.values?.map((value: { id: string }) => value.id) ?? [];

      return Object.entries(dataset.series)
        .map(([, seriesData]) => {
          const series = seriesData as { observations: Record<string, [number]> };
          const lines = Object.entries(series.observations ?? {})
            .map(([idx, values]) => `${times[Number(idx)] ?? idx}: ${values[0]}`)
            .join("\n");
          return `## ECB: ${params.flowRef}/${params.key}\n${lines}`;
        })
        .join("\n\n");
    });
  }

  async inflationAdjust(
    amount: number,
    fromDate: string,
    toDate: string,
  ): Promise<string> {
    if (!this.env.FRED_KEY) return "FRED_API_KEY not configured";

    const key = `inflation:adjust:${amount}:from=${fromDate}:to=${toDate}`;
    return this.cache.getOrCompute(key, TTL.inflationAdjust, async () => {
      const [fromRes, toRes] = await Promise.all([
        fetchRetry(
          `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCNS&api_key=${this.env.FRED_KEY}&file_type=json&observation_start=${fromDate}&observation_end=${fromDate}&limit=1`,
        ),
        fetchRetry(
          `https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCNS&api_key=${this.env.FRED_KEY}&file_type=json&observation_start=${toDate}&observation_end=${toDate}&limit=1`,
        ),
      ]);

      const fromData = await fromRes.json();
      const toData = await toRes.json();
      const fromCpi = parseFloat(fromData.observations?.[0]?.value);
      const toCpi = parseFloat(toData.observations?.[0]?.value);
      if (isNaN(fromCpi) || isNaN(toCpi)) {
        return "CPI data not available for requested dates";
      }

      const adjusted = amount * (toCpi / fromCpi);
      const cumulativeInflation = ((toCpi / fromCpi) - 1) * 100;
      return `$${amount} from ${fromDate} = $${adjusted.toFixed(2)} in ${toDate} dollars\nCPI ${fromDate}: ${fromCpi}\nCPI ${toDate}: ${toCpi}\nCumulative inflation: ${cumulativeInflation.toFixed(1)}%`;
    });
  }

  async checkReleaseCalendar(): Promise<string> {
    if (!this.env.FRED_KEY) return "FRED_API_KEY not configured";

    const key = `fred:release-calendar:${new Date().toISOString().slice(0, 10)}`;
    return this.cache.getOrCompute(key, TTL.releaseCalendar, async () => {
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

      for (const release of releases) {
        try {
          const res = await fetchRetry(
            `https://api.stlouisfed.org/fred/release/dates?release_id=${release.id}&api_key=${this.env.FRED_KEY}&file_type=json&sort_order=desc&limit=3`,
          );
          const data = await res.json();
          const dates = data.release_dates?.map((item: { date: string }) => item.date) ?? [];
          const isToday = dates.includes(today);
          results.push(
            `${release.name}: last=${dates[0] ?? "?"}${isToday ? ` ** RELEASED TODAY — use ${release.source} direct **` : ""}`,
          );
        } catch {}
      }

      return `Today: ${today}\n\n${results.join("\n")}`;
    });
  }

  async prefetchReleaseDaySeries(): Promise<void> {
    if (!this.env.FRED_KEY) return;

    const hotSeries = [
      { id: "PAYEMS", units: "chg" as const },
      { id: "UNRATE", units: "lin" as const },
      { id: "CPIAUCSL", units: "pc1" as const },
      { id: "CPILFESL", units: "pc1" as const },
      { id: "GDPC1", units: "lin" as const },
      { id: "A191RL1Q225SBEA", units: "lin" as const },
      { id: "JTSJOL", units: "lin" as const },
      { id: "PCEPILFE", units: "pc1" as const },
    ];

    console.error(`Pre-fetching ${hotSeries.length} release-day series...`);
    for (const series of hotSeries) {
      try {
        await this.fredGetSeries(series.id, 36, series.units);
      } catch {}
    }
    console.error("Pre-fetch complete.");
  }
}
