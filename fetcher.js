// ==UserScript==
// @name         PoE2 Trade Tracker Fetcher
// @namespace    https://chat.openai.com/
// @version      0.5.0
// @description  Fetch cheapest listings from saved PoE2 trade searches with conservative rate limiting, rolling history, sell-speed heuristics, and JSON export.
// @match        https://www.pathofexile.com/trade2/search/poe2/Fate%20of%20the%20Vaal*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_CONFIG = [];

  const SETTINGS = {
    itemDelayMs: 10000,
    batchSize: 3,
    batchPauseMs: 90000,
    firstRetryMs: 120000,
    secondRetryMs: 300000,
    thirdRetryMs: 900000,
    requestTimeoutMs: 45000,

    topListingsToStore: 5,
    fetchListingsCount: 10,

    historyWindowHours: 48,
    shortGapMinutes: 30,

    autoRunEnabled: true,
    autoRunMode: 'full', // 'test' | 'full'
    minHoursBetweenAutoRuns: 4,
  };

  const STORAGE_KEY = 'poe2_trade_tracker_state_v2';
  const CONFIG_KEY = 'poe2_trade_tracker_config_v1';
  let isRunning = false;

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function hoursToMs(hours) {
    return hours * 60 * 60 * 1000;
  }

  function minutesToMs(minutes) {
    return minutes * 60 * 1000;
  }

  function parseIsoTime(value) {
    if (!value) return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }

  function minutesSince(value) {
    const t = parseIsoTime(value);
    if (t == null) return null;
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  }

  function getState() {
    return GM_getValue(STORAGE_KEY, {
      results: {},
      lastRunAt: null,
      runCount: 0,
      lastError: null,
      runHistory: [],
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
    });
  }

  function setState(nextState) {
    GM_setValue(STORAGE_KEY, nextState);
  }

  function getConfig() {
    const stored = GM_getValue(CONFIG_KEY, null);
    if (Array.isArray(stored)) return stored;
    return DEFAULT_CONFIG;
  }

  function setConfig(config) {
    GM_setValue(CONFIG_KEY, config);
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[’'"`]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function normaliseConfig(raw) {
    if (!Array.isArray(raw)) {
      throw new Error('Checklist JSON must be an array.');
    }

    return raw.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`Checklist entry ${index + 1} is not an object.`);
      }
      if (!item.url || typeof item.url !== 'string') {
        throw new Error(`Checklist entry ${index + 1} is missing a url.`);
      }

      const type = String(item.type || '').trim();
      const notes = String(item.notes || '').trim();
      const id = item.id && String(item.id).trim()
        ? String(item.id).trim()
        : [slugify(type), slugify(notes)].filter(Boolean).join('_') || `item_${index + 1}`;

      return {
        id,
        type,
        notes,
        url: String(item.url).trim(),
      };
    });
  }

  async function importChecklistFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const config = normaliseConfig(parsed);
        setConfig(config);
        renderConfigCount();
        renderStatus(`Loaded checklist: ${config.length} item(s).`);
      } catch (error) {
        renderStatus(`Checklist import failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    input.click();
  }

  function clearChecklist() {
    setConfig(DEFAULT_CONFIG);
    renderConfigCount();
    renderStatus('Loaded checklist cleared.');
  }

  function renderConfigCount() {
    const el = document.getElementById('poe2-tracker-config-count');
    if (el) {
      el.textContent = `Checklist: ${getConfig().length} items`;
    }
  }

  function resetState() {
    setState({
      results: {},
      lastRunAt: null,
      runCount: 0,
      lastError: null,
      runHistory: [],
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
    });
    renderStatus('State reset.');
  }

  function forceUnlock() {
    isRunning = false;
    renderStatus('Run lock cleared.');
  }

  function getRetryDelay(attempt) {
    if (attempt <= 1) return SETTINGS.firstRetryMs;
    if (attempt === 2) return SETTINGS.secondRetryMs;
    return SETTINGS.thirdRetryMs;
  }

  function inferRateLimit(text, status) {
    const hay = (text || '').toLowerCase();
    return status === 429 ||
      hay.includes('too many searches') ||
      hay.includes('too many requests') ||
      hay.includes('rate limit') ||
      hay.includes('temporarily locked out');
  }

  async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SETTINGS.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        credentials: 'include',
        signal: controller.signal,
        ...options,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  function extractLeagueFromUrl(url) {
    const parts = String(url).split('/');
    const idx = parts.findIndex(part => part === 'poe2');
    if (idx === -1 || idx + 1 >= parts.length) return '';
    return decodeURIComponent(parts[idx + 1]);
  }

  function findBootstrapCallStart(html) {
    const marker = 't({';
    const idx = html.indexOf(marker);
    return idx === -1 ? -1 : idx + 2;
  }

  function extractBalancedObject(html, startIndex) {
    if (startIndex < 0 || html[startIndex] !== '{') {
      throw new Error('Could not find bootstrap JSON object start.');
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < html.length; i += 1) {
      const ch = html[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return html.slice(startIndex, i + 1);
        }
      }
    }

    throw new Error('Could not extract balanced bootstrap JSON object.');
  }

  function extractBootstrapPayload(html) {
    const startIndex = findBootstrapCallStart(html);
    if (startIndex === -1) {
      throw new Error('Could not find trade bootstrap payload in page HTML.');
    }
    const jsonText = extractBalancedObject(html, startIndex);
    return JSON.parse(jsonText);
  }

  function normaliseSearchState(payload, fallbackLeague) {
    const league = payload?.league || fallbackLeague || '';
    const state = payload?.state;

    if (!league) {
      throw new Error('Could not determine league from saved search page.');
    }
    if (!state || typeof state !== 'object') {
      throw new Error('Could not find saved search state in page bootstrap.');
    }

    return { league, state };
  }

  async function resolveSavedSearchState(item) {
    const response = await fetchWithTimeout(item.url, {
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    const html = await response.text();

    if (inferRateLimit(html, response.status)) {
      return {
        ok: false,
        kind: 'rate_limited',
        error: 'Rate limited while fetching saved search page.',
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        kind: 'http_error',
        error: `Saved search page HTTP ${response.status}`,
      };
    }

    try {
      const payload = extractBootstrapPayload(html);
      const fallbackLeague = extractLeagueFromUrl(item.url);
      const { league, state } = normaliseSearchState(payload, fallbackLeague);
      return {
        ok: true,
        league,
        state,
      };
    } catch (error) {
      return {
        ok: false,
        kind: 'parse_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function postSearch(league, state) {
    const endpoints = [
      `${location.origin}/api/trade2/search/poe2/${encodeURIComponent(league)}`,
      `${location.origin}/api/trade/search/${encodeURIComponent(league)}`
    ];

    let lastFailure = null;

    for (const endpoint of endpoints) {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: state,
          sort: { price: 'asc' }
        })
      });

      const text = await response.text();

      if (inferRateLimit(text, response.status)) {
        return {
          ok: false,
          kind: 'rate_limited',
          error: `Rate limited while posting search to ${endpoint}.`,
        };
      }

      if (!response.ok) {
        lastFailure = `Search POST ${response.status} at ${endpoint}: ${text.slice(0, 300)}`;
        continue;
      }

      try {
        const json = JSON.parse(text);
        const resultIds = Array.isArray(json?.result) ? json.result : [];
        const resultCount = typeof json?.total === 'number' ? json.total : resultIds.length;
        const queryId = json?.id || '';

        if (!queryId) {
          lastFailure = `Search POST succeeded but no query id was returned from ${endpoint}.`;
          continue;
        }

        return {
          ok: true,
          endpoint,
          queryId,
          resultIds,
          resultCount,
        };
      } catch (error) {
        lastFailure = `Search POST returned invalid JSON at ${endpoint}.`;
      }
    }

    return {
      ok: false,
      kind: 'search_failed',
      error: lastFailure || 'Search POST failed on all candidate endpoints.',
    };
  }

  function buildFetchApiUrl(resultIds, queryId) {
    const url = new URL(`/api/trade2/fetch/${resultIds.join(',')}`, location.origin);
    url.searchParams.set('query', queryId);
    return url.toString();
  }

  function formatPrice(price) {
    if (!price || price.amount == null || !price.currency) return '';
    const label = price.type === '~b/o' ? '~b/o' : (price.type || '~price');
    return `${label} ${price.amount} ${price.currency}`;
  }

  function extractSeller(listing) {
    return (
      listing?.account?.lastCharacterName ||
      listing?.account?.name ||
      ''
    );
  }

  function chooseBestEntry(entries) {
    if (!Array.isArray(entries) || !entries.length) return null;

    const priced = entries.filter(entry => entry?.listing?.price?.amount != null);
    if (priced.length) return priced[0];
    return entries[0];
  }

  function listingAgeMinutes(indexed) {
    if (!indexed) return null;
    const t = Date.parse(indexed);
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.round((Date.now() - t) / 60000));
  }

  function mapTopListings(entries, limit = SETTINGS.topListingsToStore) {
    return (Array.isArray(entries) ? entries : []).slice(0, limit).map(entry => ({
      listing_id: entry?.id || '',
      seller: entry?.listing?.account?.lastCharacterName || entry?.listing?.account?.name || '',
      indexed: entry?.listing?.indexed || '',
      age_minutes: listingAgeMinutes(entry?.listing?.indexed),
      price: entry?.listing?.price || null,
      item: {
        ilvl: entry?.item?.ilvl ?? null,
        typeLine: entry?.item?.typeLine || '',
        name: entry?.item?.name || '',
      }
    }));
  }

  function snapshotFromResult(result) {
    if (!result) return null;
    return {
      fetched_at: result.fetched_at || '',
      result_count: result.result_count ?? 0,
      price_text: result.price_text || '',
      seller: result.seller || '',
      sell_speed: result.sell_speed || 'no_data',
      top_listings: Array.isArray(result.top_listings) ? result.top_listings : [],
    };
  }

  function pruneHistory(history) {
    const cutoff = Date.now() - hoursToMs(SETTINGS.historyWindowHours);
    return (Array.isArray(history) ? history : []).filter(entry => {
      const t = parseIsoTime(entry?.fetched_at);
      return t != null && t >= cutoff;
    });
  }

  function appendHistory(previousHistory, result) {
    const snapshot = snapshotFromResult(result);
    if (!snapshot?.fetched_at) return pruneHistory(previousHistory);

    const history = pruneHistory(previousHistory);
    history.push(snapshot);

    history.sort((a, b) => {
      const ta = parseIsoTime(a.fetched_at) || 0;
      const tb = parseIsoTime(b.fetched_at) || 0;
      return ta - tb;
    });

    return history;
  }

  function pickAnchor(history, targetHours) {
    const targetMs = Date.now() - hoursToMs(targetHours);
    let best = null;
    let bestDistance = Infinity;

    for (const entry of history) {
      const t = parseIsoTime(entry?.fetched_at);
      if (t == null) continue;
      const distance = Math.abs(t - targetMs);
      if (distance < bestDistance) {
        best = entry;
        bestDistance = distance;
      }
    }

    return best;
  }

  function historyUsedFrom(history) {
    const sorted = [...history].sort((a, b) => (parseIsoTime(a.fetched_at) || 0) - (parseIsoTime(b.fetched_at) || 0));
    const latestPrevious = sorted.length ? sorted[sorted.length - 1] : null;
    const anchor6h = pickAnchor(sorted, 6);
    const anchor12h = pickAnchor(sorted, 12);
    const anchor24h = pickAnchor(sorted, 24);
    const anchor48h = pickAnchor(sorted, 48);

    return {
      latest_previous: latestPrevious?.fetched_at || null,
      anchor_6h: anchor6h?.fetched_at || null,
      anchor_12h: anchor12h?.fetched_at || null,
      anchor_24h: anchor24h?.fetched_at || null,
      anchor_48h: anchor48h?.fetched_at || null,
    };
  }

  function deriveSellSpeed(currentTopListings, previousResult, resultCount, previousHistory) {
    const history = pruneHistory(previousHistory);
    const previousTop = Array.isArray(previousResult?.top_listings) ? previousResult.top_listings : [];

    if (!Array.isArray(currentTopListings) || currentTopListings.length === 0 || !resultCount) {
      return {
        sell_speed: 'none',
        history_used: historyUsedFrom(history),
      };
    }

    if (previousTop.length === 0) {
      return {
        sell_speed: 'no_data',
        history_used: historyUsedFrom(history),
      };
    }

    const lastFetchedAt = previousResult?.fetched_at || null;
    const minutesGap = minutesSince(lastFetchedAt);

    if (minutesGap != null && minutesGap < SETTINGS.shortGapMinutes) {
      return {
        sell_speed: previousResult?.sell_speed || 'no_data',
        history_used: historyUsedFrom(history),
      };
    }

    const previousIds = new Set(previousTop.map(x => x?.listing_id).filter(Boolean));
    const currentIds = currentTopListings.map(x => x?.listing_id).filter(Boolean);
    const overlap = currentIds.filter(id => previousIds.has(id)).length;
    const churnRatio = currentIds.length ? (currentIds.length - overlap) / currentIds.length : 0;

    const ages = currentTopListings.map(x => x?.age_minutes).filter(v => typeof v === 'number');
    const oldestAge = ages.length ? Math.max(...ages) : null;
    const newestAge = ages.length ? Math.min(...ages) : null;

    const anchor24 = pickAnchor(history, 24);
    const anchor48 = pickAnchor(history, 48);

    const currentSet = new Set(currentIds);
    const anchor24Ids = new Set((anchor24?.top_listings || []).map(x => x?.listing_id).filter(Boolean));
    const anchor48Ids = new Set((anchor48?.top_listings || []).map(x => x?.listing_id).filter(Boolean));

    const overlap24 = anchor24Ids.size
      ? [...currentSet].filter(id => anchor24Ids.has(id)).length / Math.max(currentSet.size, 1)
      : null;
    const overlap48 = anchor48Ids.size
      ? [...currentSet].filter(id => anchor48Ids.has(id)).length / Math.max(currentSet.size, 1)
      : null;

    let speed = 'slow';

    if (
      churnRatio >= 0.8 ||
      (newestAge !== null && oldestAge !== null && newestAge <= 30 && oldestAge <= 180 && resultCount <= 3)
    ) {
      speed = 'fast';
    } else if (
      churnRatio >= 0.3 ||
      (oldestAge !== null && oldestAge <= 720) ||
      resultCount <= 8
    ) {
      speed = 'medium';
    }

    if (overlap24 !== null && overlap24 >= 0.8 && speed === 'medium') {
      speed = 'slow';
    }

    if (overlap48 !== null && overlap48 >= 0.8) {
      speed = 'slow';
    }

    return {
      sell_speed: speed,
      history_used: historyUsedFrom(history),
    };
  }

  function parseFetchedListings(fetchJson, item, resultCount = null, previousResult = null, previousHistory = []) {
    const entries = Array.isArray(fetchJson?.result) ? fetchJson.result : [];

    if (!entries.length) {
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: 'no_results',
        fetched_at: nowIso(),
        price_text: '',
        seller: '',
        listing_url: item.url,
        error: 'Fetch returned no listing results.',
        result_count: resultCount ?? 0,
        top_listings: [],
        sell_speed: 'none',
        history: pruneHistory(previousHistory),
        snapshot_dates: pruneHistory(previousHistory).map(x => x.fetched_at),
        history_used: historyUsedFrom(previousHistory),
        raw_listing: null,
      };
    }

    const best = chooseBestEntry(entries);
    const listing = best?.listing || {};
    const itemData = best?.item || {};
    const topListings = mapTopListings(entries, SETTINGS.topListingsToStore);
    const speedInfo = deriveSellSpeed(topListings, previousResult, resultCount ?? entries.length, previousHistory);

    const result = {
      id: item.id,
      type: item.type,
      notes: item.notes,
      url: item.url,
      status: 'ok',
      fetched_at: nowIso(),
      price_text: formatPrice(listing.price),
      seller: extractSeller(listing),
      listing_url: item.url,
      error: '',
      result_count: resultCount ?? entries.length,
      top_listings: topListings,
      sell_speed: speedInfo.sell_speed,
      history_used: speedInfo.history_used,
      raw_listing: {
        id: best?.id || '',
        account: listing?.account?.name || '',
        lastCharacterName: listing?.account?.lastCharacterName || '',
        indexed: listing?.indexed || '',
        price: listing?.price || null,
        item: {
          ilvl: itemData?.ilvl ?? null,
          typeLine: itemData?.typeLine || '',
          name: itemData?.name || '',
        }
      }
    };

    const updatedHistory = appendHistory(previousHistory, result);
    result.history = updatedHistory;
    result.snapshot_dates = updatedHistory.map(x => x.fetched_at);

    return result;
  }

  async function fetchListingData(queryId, resultIds, item, resultCount, previousResult, previousHistory) {
    if (!resultIds.length) {
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: 'no_results',
        fetched_at: nowIso(),
        price_text: '',
        seller: '',
        listing_url: item.url,
        error: 'Search returned zero result IDs.',
        result_count: resultCount ?? 0,
        top_listings: [],
        sell_speed: 'none',
        history: pruneHistory(previousHistory),
        snapshot_dates: pruneHistory(previousHistory).map(x => x.fetched_at),
        history_used: historyUsedFrom(previousHistory),
        raw_listing: null,
      };
    }

    const fetchApiUrl = buildFetchApiUrl(resultIds.slice(0, SETTINGS.fetchListingsCount), queryId);

    const response = await fetchWithTimeout(fetchApiUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    const text = await response.text();

    if (inferRateLimit(text, response.status)) {
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: 'rate_limited',
        fetched_at: nowIso(),
        price_text: '',
        seller: '',
        listing_url: item.url,
        error: 'Rate limited during fetch request.',
        result_count: resultCount ?? 0,
        top_listings: [],
        sell_speed: previousResult?.sell_speed || 'no_data',
        history: pruneHistory(previousHistory),
        snapshot_dates: pruneHistory(previousHistory).map(x => x.fetched_at),
        history_used: historyUsedFrom(previousHistory),
        raw_listing: null,
      };
    }

    if (!response.ok) {
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: 'http_error',
        fetched_at: nowIso(),
        price_text: '',
        seller: '',
        listing_url: item.url,
        error: `Fetch HTTP ${response.status}: ${text.slice(0, 300)}`,
        result_count: resultCount ?? 0,
        top_listings: [],
        sell_speed: previousResult?.sell_speed || 'no_data',
        history: pruneHistory(previousHistory),
        snapshot_dates: pruneHistory(previousHistory).map(x => x.fetched_at),
        history_used: historyUsedFrom(previousHistory),
        raw_listing: null,
      };
    }

    try {
      const fetchJson = JSON.parse(text);
      return parseFetchedListings(fetchJson, item, resultCount, previousResult, previousHistory);
    } catch (error) {
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: 'parse_failed',
        fetched_at: nowIso(),
        price_text: '',
        seller: '',
        listing_url: item.url,
        error: 'Fetch response was not valid JSON.',
        result_count: resultCount ?? 0,
        top_listings: [],
        sell_speed: previousResult?.sell_speed || 'no_data',
        history: pruneHistory(previousHistory),
        snapshot_dates: pruneHistory(previousHistory).map(x => x.fetched_at),
        history_used: historyUsedFrom(previousHistory),
        raw_listing: null,
      };
    }
  }

  async function fetchOne(item, attempt = 0) {
    try {
      const storedResult = getState().results[item.id] || null;
      const previousResult = storedResult || null;
      const previousHistory = pruneHistory(storedResult?.history || []);

      const resolved = await resolveSavedSearchState(item);
      if (!resolved.ok) {
        return {
          id: item.id,
          type: item.type,
          notes: item.notes,
          url: item.url,
          status: resolved.kind,
          fetched_at: nowIso(),
          price_text: '',
          seller: '',
          listing_url: item.url,
          error: `${resolved.error} (attempt ${attempt + 1})`,
          result_count: previousResult?.result_count ?? 0,
          top_listings: previousResult?.top_listings || [],
          sell_speed: previousResult?.sell_speed || 'no_data',
          history: previousHistory,
          snapshot_dates: previousHistory.map(x => x.fetched_at),
          history_used: historyUsedFrom(previousHistory),
          raw_listing: null,
        };
      }

      const search = await postSearch(resolved.league, resolved.state);
      if (!search.ok) {
        return {
          id: item.id,
          type: item.type,
          notes: item.notes,
          url: item.url,
          status: search.kind,
          fetched_at: nowIso(),
          price_text: '',
          seller: '',
          listing_url: item.url,
          error: `${search.error} (attempt ${attempt + 1})`,
          result_count: previousResult?.result_count ?? 0,
          top_listings: previousResult?.top_listings || [],
          sell_speed: previousResult?.sell_speed || 'no_data',
          history: previousHistory,
          snapshot_dates: previousHistory.map(x => x.fetched_at),
          history_used: historyUsedFrom(previousHistory),
          raw_listing: null,
        };
      }

      return await fetchListingData(
        search.queryId,
        search.resultIds,
        item,
        search.resultCount,
        previousResult,
        previousHistory
      );
    } catch (error) {
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: 'request_failed',
        fetched_at: nowIso(),
        price_text: '',
        seller: '',
        listing_url: item.url,
        error: error instanceof Error ? error.message : String(error),
        result_count: 0,
        top_listings: [],
        sell_speed: 'no_data',
        history: [],
        snapshot_dates: [],
        history_used: {
          latest_previous: null,
          anchor_6h: null,
          anchor_12h: null,
          anchor_24h: null,
          anchor_48h: null,
        },
        raw_listing: null,
      };
    }
  }

  async function fetchWithRetries(item) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await fetchOne(item, attempt);
      if (result.status === 'ok' || result.status === 'no_results') {
        return result;
      }
      if (result.status === 'rate_limited') {
        const delay = getRetryDelay(attempt + 1);
        renderStatus(`Rate limited on ${item.id}. Waiting ${Math.round(delay / 1000)}s before retry ${attempt + 2}.`);
        await sleep(delay);
        continue;
      }
      if (attempt < 3) {
        const delay = getRetryDelay(attempt + 1);
        renderStatus(`Retrying ${item.id} after ${Math.round(delay / 1000)}s due to ${result.status}.`);
        await sleep(delay);
        continue;
      }
      return result;
    }

    return {
      id: item.id,
      type: item.type,
      notes: item.notes,
      url: item.url,
      status: 'failed_after_retries',
      fetched_at: nowIso(),
      price_text: '',
      seller: '',
      listing_url: item.url,
      error: 'Failed after retries.',
      result_count: 0,
      top_listings: [],
      sell_speed: 'no_data',
      history: [],
      snapshot_dates: [],
      history_used: {
        latest_previous: null,
        anchor_6h: null,
        anchor_12h: null,
        anchor_24h: null,
        anchor_48h: null,
      },
      raw_listing: null,
    };
  }

  function shouldAutoRun() {
    if (!SETTINGS.autoRunEnabled) return false;
    const config = getConfig();
    if (!config.length) return false;

    const state = getState();
    const lastRunAt = parseIsoTime(state.lastRunAt);
    if (lastRunAt == null) return true;

    const elapsedMs = Date.now() - lastRunAt;
    return elapsedMs >= hoursToMs(SETTINGS.minHoursBetweenAutoRuns);
  }

  async function runFetch(limit = getConfig().length) {
    if (isRunning) {
      renderStatus('A fetch run is already in progress.');
      return;
    }

    isRunning = true;
    try {
      const state = getState();
      state.lastRunStartedAt = nowIso();
      state.lastRunAt = state.lastRunStartedAt;
      state.runCount = (state.runCount || 0) + 1;
      setState(state);

      const config = getConfig();
      const items = config.slice(0, limit).filter(item => item.url && item.url.includes('/trade2/search/'));

      if (!items.length) {
        renderStatus('No checklist items loaded.');
        return;
      }

      renderStatus(`Starting fetch for ${items.length} item(s).`);

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        renderStatus(`Fetching ${i + 1}/${items.length}: ${item.id}`);

        const result = await fetchWithRetries(item);

        const nextState = getState();
        nextState.results[item.id] = result;
        nextState.lastError = result.status !== 'ok' && result.status !== 'no_results' ? result.error : null;
        setState(nextState);

        renderStatus(
          `Finished ${item.id}: ${result.status}` +
          `${result.price_text ? ` — ${result.price_text}` : ''}` +
          `${result.sell_speed ? ` • ${result.sell_speed}` : ''}`
        );

        const isLast = i === items.length - 1;
        if (!isLast) {
          const completed = i + 1;
          if (completed % SETTINGS.batchSize === 0) {
            renderStatus(`Batch pause after ${completed} searches for ${Math.round(SETTINGS.batchPauseMs / 1000)}s.`);
            await sleep(SETTINGS.batchPauseMs);
          } else {
            await sleep(SETTINGS.itemDelayMs);
          }
        }
      }

      const finalState = getState();
      finalState.lastRunFinishedAt = nowIso();
      finalState.runHistory = [...(finalState.runHistory || []), finalState.lastRunFinishedAt]
        .filter(Boolean)
        .slice(-50);
      setState(finalState);

      renderStatus('Fetch run complete.');
      exportResults();
    } finally {
      isRunning = false;
    }
  }

  function exportResults() {
    const state = getState();
    const config = getConfig();
    const rows = config.map(item => {
      const result = state.results[item.id] || {};
      return {
        id: item.id,
        type: item.type,
        notes: item.notes,
        url: item.url,
        status: result.status || 'not_fetched',
        fetched_at: result.fetched_at || '',
        price_text: result.price_text || '',
        seller: result.seller || '',
        listing_url: result.listing_url || item.url,
        error: result.error || '',
        result_count: result.result_count ?? null,
        sell_speed: result.sell_speed || 'no_data',
        snapshot_dates: result.snapshot_dates || [],
        history_used: result.history_used || {
          latest_previous: null,
          anchor_6h: null,
          anchor_12h: null,
          anchor_24h: null,
          anchor_48h: null,
        },
        top_listings: result.top_listings || [],
        raw_listing: result.raw_listing || null,
      };
    });

    const snapshotDatesSeen = rows.flatMap(row => row.snapshot_dates || []);
    const payload = {
      exported_at: nowIso(),
      run_started_at: state.lastRunStartedAt || null,
      run_finished_at: state.lastRunFinishedAt || null,
      source_page: location.href,
      settings: SETTINGS,
      checklist_count: config.length,
      item_count: rows.length,
      run_history: state.runHistory || [],
      snapshot_dates_seen: [...new Set(snapshotDatesSeen)].sort(),
      rows,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const objectUrl = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    GM_download({
      url: objectUrl,
      name: `poe2_trade_export_${stamp}.json`,
      saveAs: true,
      onload: () => URL.revokeObjectURL(objectUrl),
      onerror: () => URL.revokeObjectURL(objectUrl),
    });
  }

  function clearResults() {
    const state = getState();
    state.results = {};
    state.lastError = null;
    setState(state);
    renderStatus('Saved results cleared.');
  }

  function renderStatus(text) {
    const el = document.getElementById('poe2-tracker-status');
    if (el) {
      el.textContent = `${new Date().toLocaleTimeString()}: ${text}`;
    }
    console.log('[PoE2 Tracker]', text);
  }

  function makeButton(label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.flex = '1';
    btn.style.padding = '8px 10px';
    btn.style.borderRadius = '6px';
    btn.style.border = '1px solid #666';
    btn.style.background = '#2b2f36';
    btn.style.color = '#fff';
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function buildUi() {
    if (document.getElementById('poe2-tracker-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'poe2-tracker-panel';
    panel.style.position = 'fixed';
    panel.style.right = '16px';
    panel.style.bottom = '16px';
    panel.style.zIndex = '999999';
    panel.style.width = '340px';
    panel.style.background = 'rgba(20, 20, 24, 0.96)';
    panel.style.color = '#f2f2f2';
    panel.style.border = '1px solid #555';
    panel.style.borderRadius = '10px';
    panel.style.padding = '12px';
    panel.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
    panel.style.fontFamily = 'system-ui, sans-serif';

    const title = document.createElement('div');
    title.textContent = 'PoE2 Trade Tracker';
    title.style.fontWeight = '700';
    title.style.marginBottom = '8px';
    panel.appendChild(title);

    const sub = document.createElement('div');
    sub.id = 'poe2-tracker-config-count';
    sub.textContent = `Checklist: ${getConfig().length} items`;
    sub.style.fontSize = '12px';
    sub.style.opacity = '0.8';
    sub.style.marginBottom = '10px';
    panel.appendChild(sub);

    const buttonRow0 = document.createElement('div');
    buttonRow0.style.display = 'flex';
    buttonRow0.style.gap = '8px';
    buttonRow0.style.marginBottom = '8px';

    const loadBtn = makeButton('Load checklist', importChecklistFromFile);
    const clearChecklistBtn = makeButton('Clear checklist', clearChecklist);
    buttonRow0.append(loadBtn, clearChecklistBtn);
    panel.appendChild(buttonRow0);

    const buttonRow1 = document.createElement('div');
    buttonRow1.style.display = 'flex';
    buttonRow1.style.gap = '8px';
    buttonRow1.style.marginBottom = '8px';

    const testBtn = makeButton('Run 3-item test', () => runFetch(3));
    const fullBtn = makeButton('Run full fetch', () => runFetch(getConfig().length));
    buttonRow1.append(testBtn, fullBtn);
    panel.appendChild(buttonRow1);

    const buttonRow2 = document.createElement('div');
    buttonRow2.style.display = 'flex';
    buttonRow2.style.gap = '8px';
    buttonRow2.style.marginBottom = '8px';

    const exportBtn = makeButton('Export JSON', exportResults);
    const clearBtn = makeButton('Clear results', clearResults);
    buttonRow2.append(exportBtn, clearBtn);
    panel.appendChild(buttonRow2);

    const buttonRow3 = document.createElement('div');
    buttonRow3.style.display = 'flex';
    buttonRow3.style.gap = '8px';
    buttonRow3.style.marginBottom = '8px';

    const resetBtn = makeButton('Reset state', resetState);
    const unlockBtn = makeButton('Force unlock', forceUnlock);
    buttonRow3.append(resetBtn, unlockBtn);
    panel.appendChild(buttonRow3);

    const info = document.createElement('div');
    info.style.fontSize = '12px';
    info.style.opacity = '0.85';
    info.style.lineHeight = '1.4';
    info.style.marginBottom = '8px';
    info.textContent =
      'Load checklist.json first. History window: 48h. Auto-run on page open is enabled if enough time has passed.';
    panel.appendChild(info);

    const status = document.createElement('div');
    status.id = 'poe2-tracker-status';
    status.style.fontSize = '12px';
    status.style.background = 'rgba(255,255,255,0.04)';
    status.style.padding = '8px';
    status.style.borderRadius = '6px';
    status.style.minHeight = '52px';
    status.textContent = 'Ready.';
    panel.appendChild(status);

    document.body.appendChild(panel);
  }

  async function maybeAutoRun() {
    if (!shouldAutoRun()) return;

    const count = SETTINGS.autoRunMode === 'test' ? 3 : getConfig().length;
    renderStatus(`Auto-run starting (${SETTINGS.autoRunMode}).`);
    await runFetch(count);
  }

  buildUi();
  setTimeout(() => {
    maybeAutoRun().catch(err => {
      renderStatus(`Auto-run failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 1500);
})();