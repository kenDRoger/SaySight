import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type ActiveDotProps,
  type BarShapeProps,
  type DotItemDotProps,
} from 'recharts';

export type RankRow = { rank: number; year: number; amount_pesos: number | null; status: string };
export type TrendRow = {
  year: number; amount_pesos: number | null; status: string;
  change_from_previous_pesos: number | null; percent_change_from_previous: number | null;
};
export type DistributionGroup = { value: string; count: number; percentage: number };
export type DistributionResult = { field: 'status'; groups: DistributionGroup[] };
export type CompareResult = {
  year_a: number; year_b: number; coverage_status: string;
  value_a_pesos: number | null; value_b_pesos: number | null;
  difference_pesos: number | null; percent_change: number | null;
};
type CompareBar = { label: string; year: number; amount: number | null };

const pesoCompact = new Intl.NumberFormat('en-PH', { notation: 'compact', style: 'currency', currency: 'PHP', maximumFractionDigits: 2 });
const pesoExact = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('en-PH', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 });

const pesoText = (amount: number) => `${pesoCompact.format(amount)} (${pesoExact.format(amount)})`;
const yearAmountText = (year: number, amount: number | null) => `FY${year}: ${amount === null ? 'no GAA, no amount reported' : pesoText(amount)}`;
const percentText = (value: number | null) => value === null ? 'not reported' : percentFormat.format(value / 100);
const statusName = (value: string) => ({
  published_source_baseline: 'Published source baseline',
  partial_historical_coverage: 'Partial historical coverage',
  reenacted_no_new_gaa: 'Reenacted, no new GAA',
  published_editions_differ: 'Published editions differ',
} as Record<string, string>)[value] ?? value.replace(/_/g, ' ');
// Recharts forwards aria-label to its SVG root but omits it from the chart prop types.
const svgLabel = (label: string) => ({ 'aria-label': label });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isAmountRow = (value: unknown): value is RankRow & TrendRow => isRecord(value) && typeof value.year === 'number' && (typeof value.amount_pesos === 'number' || value.amount_pesos === null);
export const isRankResult = (value: unknown): value is RankRow[] => Array.isArray(value) && value.every(isAmountRow);
export const isTrendResult = (value: unknown): value is TrendRow[] => Array.isArray(value) && value.every(isAmountRow);
export const isDistributionResult = (value: unknown): value is DistributionResult => isRecord(value) && Array.isArray(value.groups) && value.groups.every((group) => isRecord(group) && typeof group.value === 'string' && typeof group.count === 'number' && typeof group.percentage === 'number');
export const isCompareResult = (value: unknown): value is CompareResult => isRecord(value) && typeof value.year_a === 'number' && typeof value.year_b === 'number' && (typeof value.value_a_pesos === 'number' || value.value_a_pesos === null) && (typeof value.value_b_pesos === 'number' || value.value_b_pesos === null);

const pesoTooltip = (value: unknown) => typeof value === 'number' ? pesoText(value) : 'No GAA — no amount reported';

// Every chart ships a values table behind a disclosure: charts aid comprehension,
// the table carries the exact figures for screen readers, keyboards, and print.
function ValuesTable({ caption, head, rows }: { caption: string; head: string[]; rows: Array<Array<string | number>> }) {
  return <details className="chart-table"><summary>Table of values</summary>
    <div className="table-scroll" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption>{caption}</caption>
        <thead><tr>{head.map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => cellIndex === 0
          ? <th key={cellIndex} scope="row">{cell}</th>
          : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </details>;
}

export function RankChart({ rows }: { rows: RankRow[] }) {
  const summary = `Horizontal bar chart ranking reported GAA appropriations in pesos for ${rows.length} fiscal years, highest first.`;
  return <figure className="chart-figure chart-figure--rank">
    <div className="chart-container chart-container--rank">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" accessibilityLayer role="img" {...svgLabel(summary)} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" tickFormatter={(value: number) => pesoCompact.format(value)} />
          <YAxis type="category" dataKey="year" width={48} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value) => [pesoTooltip(value), 'Amount']} labelFormatter={(label) => `FY${label}`} />
          <Bar dataKey="amount_pesos" fill="#256b4a" shape={(props: BarShapeProps) => {
            // Recharts types bar payloads as any; main.tsx validates the rows as RankRow[].
            const row = props.payload as RankRow;
            return <rect x={props.x} y={props.y} width={props.width} height={props.height} fill="#256b4a" tabIndex={0} aria-label={yearAmountText(row.year, row.amount_pesos)} />;
          }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <figcaption><strong>Reported GAA appropriations by fiscal year, ranked highest first.</strong> Each bar encodes a year's amount in pesos; the axis uses compact currency values and exact amounts appear in tooltips and the raw JSON.<br />
      <span className="chart-note">Limitation: amounts are nominal and coverage scopes vary by year, so this ranking is not inflation- or scope-adjusted.</span>
    </figcaption>
    <ValuesTable caption="Ranked fiscal years and appropriations"
      head={['Rank', 'Fiscal year', 'Amount (PHP)', 'Coverage status']}
      rows={rows.map((row, index) => [index + 1, `FY${row.year}`, row.amount_pesos === null ? 'No amount recorded' : row.amount_pesos.toLocaleString('en-PH'), row.status])} />
  </figure>;
}

const trendDot = (props: DotItemDotProps | ActiveDotProps) => {
  // Recharts types line payloads as any; main.tsx validates the rows as TrendRow[].
  const row = props.payload as TrendRow;
  if (row.amount_pesos === null) return null;
  const radius = typeof props.r === 'number' ? props.r : 4;
  return <circle cx={props.cx} cy={props.cy} r={radius + 1} fill="#256b4a" stroke="#ffffff" strokeWidth={1} tabIndex={0} aria-label={yearAmountText(row.year, row.amount_pesos)} />;
};

export function TrendChart({ rows }: { rows: TrendRow[] }) {
  const gaps = rows.filter((row) => row.amount_pesos === null).map((row) => `FY${row.year}`);
  const summary = `Line chart of reported GAA appropriations in pesos across ${rows.length} fiscal years, with gaps where no GAA was reported.`;
  return <figure className="chart-figure chart-figure--trend">
    <div className="chart-container chart-container--trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} accessibilityLayer role="img" {...svgLabel(summary)} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="year" interval={2} tick={{ fontSize: 10 }} />
          <YAxis tickFormatter={(value: number) => pesoCompact.format(value)} width={56} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value) => [pesoTooltip(value), 'Amount']} labelFormatter={(label) => `FY${label}`} />
          <Line dataKey="amount_pesos" stroke="#256b4a" strokeWidth={2} connectNulls={false} dot={trendDot} activeDot={trendDot} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <figcaption><strong>Reported GAA appropriations over fiscal years.</strong> The line encodes each year's amount in pesos; {gaps.length ? `gaps at ${gaps.join(', ')} mark years with no GAA` : 'this selection has no gap years'}.<br />
      <span className="chart-note">Limitation: missing years are left as gaps — no value is invented — and year-to-year scope differences limit comparison.</span>
    </figcaption>
    <ValuesTable caption="Appropriations and year-over-year change by fiscal year"
      head={['Fiscal year', 'Amount (PHP)', 'Change from previous', 'Coverage status']}
      rows={rows.map((row) => [`FY${row.year}`,
        row.amount_pesos === null ? 'No GAA — no value recorded' : row.amount_pesos.toLocaleString('en-PH'),
        row.change_from_previous_pesos === null || row.change_from_previous_pesos === undefined ? '—' : row.change_from_previous_pesos.toLocaleString('en-PH'),
        row.status])} />
  </figure>;
}

export function DistributionChart({ result }: { result: DistributionResult }) {
  const summary = `Bar chart of ${result.groups.length} coverage-status groups, showing row counts and percentages.`;
  return <figure className="chart-figure chart-figure--distribution">
    <div className="chart-container chart-container--distribution">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={result.groups} layout="vertical" accessibilityLayer role="img" {...svgLabel(summary)} margin={{ top: 4, right: 44, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" allowDecimals={false} />
          <YAxis type="category" dataKey="value" width={132} tick={{ fontSize: 10 }} tickFormatter={(value: string) => statusName(value)} />
          <Tooltip
            labelFormatter={(label) => statusName(String(label))}
            formatter={(value, _name, item) => {
              // Recharts types tooltip payloads as any; the bar data is DistributionResult.groups.
              const group = item.payload as DistributionGroup;
              return `${value} rows · ${percentText(group.percentage)}`;
            }}
          />
          <Bar dataKey="count" fill="#2d6a4f" shape={(props: BarShapeProps) => {
            // Recharts types bar payloads as any; main.tsx validates the groups.
            const group = props.payload as DistributionGroup;
            const label = `${statusName(group.value)}: ${group.count} rows (${percentText(group.percentage)})`;
            return <rect x={props.x} y={props.y} width={props.width} height={props.height} fill="#2d6a4f" tabIndex={0} aria-label={label} />;
          }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <figcaption><strong>Coverage rows by status.</strong> Each bar encodes the row count; percentages are in each bar's accessible label and tooltip.<br />
      <span className="chart-note">Limitation: these are counts of coverage rows, not independent fiscal years or amounts.</span>
    </figcaption>
    <ValuesTable caption="Coverage rows by status"
      head={['Coverage status', 'Rows', 'Percentage']}
      rows={result.groups.map((group) => [statusName(group.value), group.count, percentText(group.percentage)])} />
  </figure>;
}

export function CompareChart({ result }: { result: CompareResult }) {
  const bars: CompareBar[] = [
    { label: `FY${result.year_a}`, year: result.year_a, amount: result.value_a_pesos },
    { label: `FY${result.year_b}`, year: result.year_b, amount: result.value_b_pesos },
  ];
  const differenceText = result.difference_pesos === null ? 'not reported' : pesoText(result.difference_pesos);
  const summary = `Two-bar chart comparing FY${result.year_a} and FY${result.year_b} reported amounts in pesos; difference ${differenceText}, percent change ${percentText(result.percent_change)}.`;
  return <figure className="chart-figure chart-figure--compare">
    <div className="chart-container chart-container--compare">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars} accessibilityLayer role="img" {...svgLabel(summary)} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" />
          <YAxis tickFormatter={(value: number) => pesoCompact.format(value)} width={56} tick={{ fontSize: 11 }} />
          <Tooltip formatter={(value) => [pesoTooltip(value), 'Amount']} />
          <Bar dataKey="amount" fill="#256b4a" shape={(props: BarShapeProps) => {
            // Recharts types bar payloads as any; the bars are built from a validated CompareResult.
            const bar = props.payload as CompareBar;
            return <rect x={props.x} y={props.y} width={props.width} height={props.height} fill="#256b4a" tabIndex={0} aria-label={yearAmountText(bar.year, bar.amount)} />;
          }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <figcaption><strong>FY{result.year_a} versus FY{result.year_b}.</strong> The two bars encode reported amounts; FY{result.year_b} minus FY{result.year_a} is {differenceText}, a change of {percentText(result.percent_change)}.<br />
      <span className="chart-note">Limitation: the comparison is valid only because both years share a coverage status and scope; it does not measure spending.</span>
    </figcaption>
    <ValuesTable caption={`Comparison of FY${result.year_a} and FY${result.year_b}`}
      head={['Measure', 'Value']}
      rows={[[`FY${result.year_a}`, result.value_a_pesos === null ? 'No amount recorded' : result.value_a_pesos.toLocaleString('en-PH')],
        [`FY${result.year_b}`, result.value_b_pesos === null ? 'No amount recorded' : result.value_b_pesos.toLocaleString('en-PH')],
        ['Difference', result.difference_pesos === null ? 'Not comparable' : result.difference_pesos.toLocaleString('en-PH')],
        ['Percent change', percentText(result.percent_change)]]} />
  </figure>;
}
