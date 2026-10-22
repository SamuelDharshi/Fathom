"use client";
import { useCallback, useEffect, useState } from "react";
import Chart from "@/components/Chart";
import PageHero from "@/components/PageHero";
import type { CancelFill, Coverage, Point, Scorecard, Venue, Window } from "@/lib/api";
import { VENUES, VENUE_COLOR, VENUE_LABEL, bps, getJson, mean, pct, timeLabel, usd } from "@/lib/api";

const WINDOWS = [[15, "15 min"], [60, "1 hour"], [360, "6 hours"], [1440, "24 hours"]] as const;
const RANGES = [[3, "Last 3 h"], [12, "Last 12 h"], [48, "Last 48 h"]] as const;

type Resilience = { threshold_usd: number; n_trades: number; n_recovered: number; median_recovery_ms: number | null };
type CF = { t: number; n_cancel: number; n_fill: number; n_open: number }[];

function Delta({ cur, prev, good, fmt }: { cur: number | null; prev: number | null; good: "up" | "down"; fmt: (d: number) => string }) {
  if (cur == null || prev == null) return <div className="delta">no previous window yet</div>;
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return <div className="delta">unchanged vs previous window</div>;
  const better = good === "up" ? d > 0 : d < 0;
  return <div className={`delta ${better ? "up" : "down"}`}>{d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))} vs previous window</div>;
}

const depthSide = (w: Window | null, band: "d5" | "d10" | "d25") => (w ? mean(w.m2[band].bid, w.m2[band].ask) : null);
const slip = (w: Window | null, k: "10k" | "50k" | "100k") => (w ? mean(w.m3[k].buy, w.m3[k].sell) : null);
// a depth band counts only if the feed covered it for at least half of the two-sided samples
function depthCell(w: Window | null, band: "d5" | "d10" | "d25") {
  if (!w) return null;
  const m = w.m2[band];
  const need = w.two_sided_samples * 0.5;
  if (m.n_bid < need || m.n_ask < need) return null;
  return mean(m.bid, m.ask);
}

export default function ScorecardPage() {
  const [win, setWin] = useState<number>(60);
  const [range, setRange] = useState<number>(12);
  const [sc, setSc] = useState<Scorecard | null>(null);
  const [series, setSeries] = useState<Record<Venue, Point[]> | null>(null);
  const [cf, setCf] = useState<CF>([]);
  const [res, setRes] = useState<Resilience | null>(null);
  const [cov, setCov] = useState<Coverage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const step = range <= 12 ? "minute" : "hour";
      const [s, c, r, v, ser] = await Promise.all([
        getJson<Scorecard>(`/api/scorecard?window_minutes=${win}`),
        getJson<{ points: CF }>(`/api/cancel_fill?step=${range <= 12 ? "minute" : "hour"}&hours=${range}`),
        getJson<Resilience>(`/api/resilience?hours=${Math.max(range, 48)}`),
        getJson<Coverage>("/api/coverage"),
        Promise.all(VENUES.map((x) => getJson<{ points: Point[] }>(`/api/series?venue=${x}&step=${step}&hours=${range}`))),
      ]);
      setSc(s); setCf(c.points); setRes(r); setCov(v);
      setSeries({ strike: ser[0].points, binance: ser[1].points, hyperliquid: ser[2].points });
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [win, range]);

  useEffect(() => {
    load();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, [load]);

  if (err && !sc) return <div className="app-body"><div className="empty err">Cannot reach the Fathom API ({err}). Is the API running and NEXT_PUBLIC_API_URL set?</div></div>;
  if (!sc || !series) return <div className="app-body"><div className="empty">Loading recorded data…</div></div>;

  const S = sc.venues.strike;
  const cur = S.current, prev = S.previous;
  const m4: CancelFill = sc.m4_strike.current;
  const trend = (fn: (p: Point) => number | null) => series.strike.map((p) => ({ t: p.t, v: fn(p) }));
  const cmp = (fn: (p: Point) => number | null) => {
    const byT = new Map<number, Record<string, number | null>>();
    for (const v of VENUES) for (const p of series[v]) {
      const row = byT.get(p.t) ?? { t: p.t };
      row[v] = fn(p);
      byT.set(p.t, row);
    }
    return [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number));
  };
  const depth10 = (p: Point) => mean(p.m2.d10.bid, p.m2.d10.ask);
  const slip50 = (p: Point) => mean(p.m3["50k"].buy, p.m3["50k"].sell);
  const hours = cov?.strike?.span_hours ?? 0;

  return (
    <>
      <PageHero title="Scorecard" sub="How deep is Strike's book? Live liquidity metrics from the public L3 feed, next to Binance and Hyperliquid." seed={5} />
      <div className="app-body">
      <h1>How deep is Strike's book?</h1>
      <p className="sub">
        Strike BTC-USD liquidity, measured every 2 seconds from the public L3 order-by-order feed and compared with
        Binance and Hyperliquid BTC perpetuals. Last update {timeLabel(sc.as_of)}. {hours.toFixed(1)} hours of Strike data recorded.
      </p>
      <div className="controls">
        {WINDOWS.map(([m, l]) => <button key={m} className={win === m ? "on" : ""} onClick={() => setWin(m)}>{l}</button>)}
        <span className="small" style={{ alignSelf: "center" }}>window for the headline numbers; compared with the window before it</span>
      </div>

      <h2>Strike, in its own terms</h2>
      <div className="grid">
        <div className="card">
          <div className="label">M1 · Spread uptime (≤ 5 bps, two-sided)</div>
          <div className="value">{pct(cur?.m1_spread_uptime)}</div>
          <Delta cur={cur?.m1_spread_uptime ?? null} prev={prev?.m1_spread_uptime ?? null} good="up" fmt={(d) => `${(d * 100).toFixed(1)} pts`} />
          <div className="note">avg spread {bps(cur?.spread_bps)} · {cur?.samples ?? 0} samples</div>
        </div>
        <div className="card">
          <div className="label">M2 · Depth within 10 bps, per side</div>
          <div className="value">{usd(depthSide(cur, "d10"))}</div>
          <Delta cur={depthSide(cur, "d10")} prev={depthSide(prev, "d10")} good="up" fmt={usd} />
          <div className="note">bid {usd(cur?.m2.d10.bid)} · ask {usd(cur?.m2.d10.ask)}</div>
        </div>
        <div className="card">
          <div className="label">M3 · Slippage, $50k market order</div>
          <div className="value">{bps(slip(cur, "50k"))}</div>
          <Delta cur={slip(cur, "50k")} prev={slip(prev, "50k")} good="down" fmt={(d) => `${d.toFixed(2)} bps`} />
          <div className="note">
            book can fill it {pct(mean(cur?.m3["50k"].fill_rate_buy, cur?.m3["50k"].fill_rate_sell))} of the time
          </div>
        </div>
        <div className="card">
          <div className="label">M4 · Cancel / fill ratio (L3 only)</div>
          <div className="value">{m4.n_fill < 5 ? (m4.n_cancel ? "too few fills" : "n/a") : m4.ratio == null ? "n/a" : m4.ratio >= 100 ? `${Math.round(m4.ratio).toLocaleString()} : 1` : m4.ratio.toFixed(1)}</div>
          <div className="note">
            {m4.n_cancel.toLocaleString()} cancels · {m4.n_fill.toLocaleString()} fills · {m4.n_open.toLocaleString()} new orders in window
          </div>
        </div>
      </div>

      <div className="controls" style={{ marginTop: 20 }}>
        {RANGES.map(([h, l]) => <button key={h} className={range === h ? "on" : ""} onClick={() => setRange(h)}>{l}</button>)}
      </div>
      <div className="two">
        <div><h3>Spread uptime</h3>
          <Chart data={trend((p) => p.m1_spread_uptime)} series={[{ key: "v", label: "Strike", color: "var(--accent)" }]} fmt={(v) => `${(v * 100).toFixed(0)}%`} /></div>
        <div><h3>Depth within 10 bps (per side)</h3>
          <Chart data={trend(depth10)} series={[{ key: "v", label: "Strike", color: "var(--accent)" }]} fmt={usd} /></div>
        <div><h3>Slippage, $50k order (bps)</h3>
          <Chart data={trend(slip50)} series={[{ key: "v", label: "Strike", color: "var(--accent)" }]} fmt={(v) => v.toFixed(1)} /></div>
        <div><h3>Average spread (bps)</h3>
          <Chart data={trend((p) => p.spread_bps)} series={[{ key: "v", label: "Strike", color: "var(--accent)" }]} fmt={(v) => v.toFixed(1)} /></div>
      </div>

      <h2>Versus Binance and Hyperliquid</h2>
      <p className="sub">Same definitions, same 2 second clock. The gap is the size of the opportunity, not a verdict on Strike.</p>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Metric</th>{VENUES.map((v) => <th key={v}>{VENUE_LABEL[v]}</th>)}</tr></thead>
          <tbody>
            <Row label="M1 Spread uptime (≤ 5 bps)" cells={VENUES.map((v) => pct(sc.venues[v].current?.m1_spread_uptime))} />
            {(["d5", "d10", "d25"] as const).map((b) => (
              <Row key={b} label={`M2 Depth within ${b.slice(1)} bps (per side)`}
                cells={VENUES.map((v, i) => {
                  const x = depthCell(sc.venues[v].current, b);
                  const base = depthCell(sc.venues.strike.current, b);
                  return x == null ? "n/a" : i > 0 && base ? `${usd(x)} (${(x / base).toFixed(0)}× Strike)` : usd(x);
                })} />
            ))}
            {(["10k", "50k", "100k"] as const).map((k) => (
              <Row key={k} label={`M3 Slippage, $${k} order`}
                cells={VENUES.map((v) => {
                  const w = sc.venues[v].current;
                  const s = slip(w, k);
                  const fr = w ? mean(w.m3[k].fill_rate_buy, w.m3[k].fill_rate_sell) : null;
                  return s == null ? "unfillable" : `${bps(s)}${fr != null && fr < 0.95 ? ` (fills ${pct(fr)})` : ""}`;
                })} />
            ))}
            <Row label="Samples in window" cells={VENUES.map((v) => String(sc.venues[v].current?.samples ?? 0))} />
          </tbody>
        </table>
      </div>
      {sc.binance_markets?.length > 0 && (
        <p className="small">
          Binance data source: {sc.binance_markets.map(([ts, m]) => `${m === "futures" ? "USD-M perpetual" : m === "spot_mirror" ? "spot (public mirror)" : m} from ${timeLabel(ts)}`).join("; then ")}.
        </p>
      )}
      <p className="small">
        n/a: the venue's public feed does not reach that price band (Binance snapshot holds 1,000 levels; Hyperliquid streams 20 levels per side).
        Never extrapolated. Slippage averages only the samples where the visible book could fill the order; the fill share is shown when below 95%.
      </p>
      <div className="two">
        <div><h3>Spread uptime, all venues</h3>
          <Chart data={cmp((p) => p.m1_spread_uptime)} series={VENUES.map((v) => ({ key: v, label: VENUE_LABEL[v], color: VENUE_COLOR[v] }))} fmt={(v) => `${(v * 100).toFixed(0)}%`} /></div>
        <div><h3>Depth within 10 bps, log scale</h3>
          <Chart log data={cmp(depth10)} series={VENUES.map((v) => ({ key: v, label: VENUE_LABEL[v], color: VENUE_COLOR[v] }))} fmt={usd} /></div>
      </div>

      <h2>What only L3 shows</h2>
      <p className="sub">Every resting order is visible, so we can count placements, cancellations and fills separately.</p>
      <div className="two">
        <div>
          <h3>Orders placed vs cancelled vs filled</h3>
          <Chart data={cf as unknown as Record<string, number | null>[]} fmt={(v) => v.toLocaleString()}
            series={[{ key: "n_open", label: "placed", color: "var(--accent)" }, { key: "n_cancel", label: "cancelled", color: "var(--binance)" }, { key: "n_fill", label: "fills", color: "var(--good)" }]} />
        </div>
        <div className="card">
          <div className="label">M5 · Depth resilience</div>
          <div className="value">{res?.median_recovery_ms != null ? `${(res.median_recovery_ms / 1000).toFixed(0)} s` : "no events"}</div>
          <div className="note">
            Time for depth within 10 bps to recover to 80% after a taker order above {usd(res?.threshold_usd)}.{" "}
            {res?.n_trades ? `${res.n_trades} such orders recorded, ${res.n_recovered} recovered.` : "No taker order that large has traded since recording began, which is itself a finding about thin volume."}
          </div>
          <div className="note" style={{ marginTop: 8 }}>
            Since recording began: {sc.m4_since_start.n_cancel.toLocaleString()} cancels against {sc.m4_since_start.n_fill.toLocaleString()} fills.
          </div>
        </div>
      </div>

      <h2>Data behind these numbers</h2>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Feed</th><th>Hours recorded</th><th>Sample coverage</th><th>Gaps</th><th>Time in gaps</th></tr></thead>
          <tbody>
            {VENUES.map((v) => {
              const c = cov?.[v];
              return (
                <tr key={v}>
                  <td>{VENUE_LABEL[v]}</td><td>{(c?.span_hours ?? 0).toFixed(1)}</td>
                  <td>{pct(c?.sample_coverage ?? null)}</td><td>{c?.gap_count ?? 0}</td>
                  <td>{((c?.gap_ms ?? 0) / 60000).toFixed(1)} min</td>
                </tr>
              );
            })}
            <tr><td>Strike L3 events</td><td colSpan={4}>{(cov?.l3_events?.count ?? 0).toLocaleString()} events stored, every gap marked</td></tr>
          </tbody>
        </table>
      </div>
      <p className="small">Gap time is excluded from all averages, never interpolated. See the methodology page for definitions and limits.</p>
      {err && <p className="err small">Last refresh failed: {err}</p>}
      </div>
    </>
  );
}

function Row({ label, cells }: { label: string; cells: string[] }) {
  return <tr><td>{label}</td>{cells.map((c, i) => <td key={i}>{c}</td>)}</tr>;
}
