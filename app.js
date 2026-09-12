(function () {
  "use strict";

  const EA_BASE = "https://environment.data.gov.uk/flood-monitoring";
  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

  const STATION_CACHE_KEY = "england-river-stations-v3";
  const LATEST_CACHE_KEY = "england-river-latest-v1";
  const GEOMETRY_CACHE_PREFIX = "england-river-geometry-v2:";
  const ACCESS_SECTIONS_CACHE_KEY = "river-access-sections-v4";
  const TILE_LAYER_STORAGE_KEY = "river-app-tile-layer-v2";

  const STATION_CACHE_TTL = 6 * 60 * 60 * 1000;
  const LATEST_CACHE_TTL = 2 * 60 * 1000;
  const GEOMETRY_CACHE_TTL = 24 * 60 * 60 * 1000;
  const ACCESS_SECTIONS_CACHE_TTL = 24 * 60 * 60 * 1000;
  const MAX_RIVERS_VISIBLE = 1000;
  const API_PAGE_SIZE = 10000;
  const MAX_API_PAGES = 50;
  const MAX_NEAREST_GAUGE_DISTANCE_KM = 25;
  const MAX_SAME_RIVER_GAUGE_DISTANCE_KM = 80;
  const EARTH_RADIUS_KM = 6371;
  const FLOW_LEVELS = ["scrape", "low", "medium", "high", "huge"];
  const FLOW_LEVEL_META = {
    scrape: { label: "scrape", className: "scrape" },
    low: { label: "low", className: "low" },
    medium: { label: "medium", className: "medium" },
    high: { label: "high", className: "high" },
    huge: { label: "huge", className: "huge" },
    missing: { label: "empty", className: "empty" }
  };
  const LEAFLET_SCRIPT_URLS = [
    "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"
  ];

  const state = {
    map: null,
    rivers: [],
    riverByKey: new Map(),
    stationsById: new Map(),
    latestByStationRef: new Map(),
    latestFetchedAt: 0,
    stationDataState: { kind: "missing", fetchedAt: 0, error: "" },
    latestDataState: { kind: "missing", fetchedAt: 0, error: "" },
    nrwFetchedAt: 0,
    selectedRiverKey: "",
    riverType: "whitewater",
    rainchasersRiverKeys: null,
    rainchasersRiverSummaries: null,
    rainchasersSectionSummaries: null,
    markers: [],
    overviewMarkers: [],
    accessMarkers: [],
    accessSections: [],
    riverLines: [],
    tileLayer: null,
    tileLayers: [],
    activeController: null
  };

  const els = {};

  if (!window.RIVER_APP_TEST_MODE) {
    document.addEventListener("DOMContentLoaded", init);
  }

  function init() {
    bindElements();
    bindEvents();
    bootApp();
  }

  function bindElements() {
    els.connectionDot = document.getElementById("connectionDot");
    els.gaugeList = document.getElementById("gaugeList");
    els.map = document.getElementById("map");
    els.mapStyle = document.getElementById("mapStyle");
    els.overviewButton = document.getElementById("overviewButton");
    els.refreshButton = document.getElementById("refreshButton");
    els.riverPanel = document.querySelector(".river-panel");
    els.riverList = document.getElementById("riverList");
    els.riverListMeta = document.getElementById("riverListMeta");
    els.riverSearch = document.getElementById("riverSearch");
    els.riverTypeTabs = Array.from(document.querySelectorAll("[data-river-type]"));
    els.riverSummary = document.getElementById("riverSummary");
    els.selectedSectionDetails = document.getElementById("selectedSectionDetails");
    els.selectedRiver = document.getElementById("selectedRiver");
    els.selectedSource = document.getElementById("selectedSource");
    els.statusMessage = document.getElementById("statusMessage");
    els.dataFreshness = document.getElementById("dataFreshness");
  }

  function bindEvents() {
    els.riverSearch.addEventListener("input", renderRiverList);
    els.riverTypeTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        activateRiverType(tab.dataset.riverType || "whitewater");
      });
      tab.addEventListener("keydown", function (event) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = els.riverTypeTabs.indexOf(tab);
        let next = event.key === "Home" ? 0 : event.key === "End" ? els.riverTypeTabs.length - 1 :
          (current + (event.key === "ArrowRight" ? 1 : -1) + els.riverTypeTabs.length) % els.riverTypeTabs.length;
        els.riverTypeTabs[next].focus();
        activateRiverType(els.riverTypeTabs[next].dataset.riverType || "whitewater");
      });
    });

    els.mapStyle.addEventListener("change", function () {
      setTileLayer(els.mapStyle.value, { announce: true });
    });

    els.overviewButton.addEventListener("click", function () {
      showOverview({ fit: true });
    });

    els.refreshButton.addEventListener("click", function () {
      if (state.selectedRiverKey) {
        selectRiver(state.selectedRiverKey, { forceLatest: true });
      } else {
        loadRiverIndex({ force: true }).then(function () {
          renderRiverList({ fitOverview: true });
          refreshOverviewLevels({ force: true });
        }).catch(showError);
      }
    });
  }

  function activateRiverType(type) {
    state.riverType = type;
    renderRiverList({ fitOverview: !state.selectedRiverKey });
  }

  async function bootApp() {
    try {
      setBusy("Loading map...");
      await ensureLeaflet();
      createMap();
      await loadRiverIndex();
      renderRiverList({ fitOverview: true });
      selectRiverFromHash();
      setReady();
      refreshOverviewLevels();
    } catch (error) {
      showError(error);
    }
  }

  async function ensureLeaflet() {
    if (window.L) return;

    for (const url of LEAFLET_SCRIPT_URLS) {
      try {
        await loadScript(url, 8000);
        if (window.L) return;
      } catch (error) {
        console.warn(error);
      }
    }

    throw new Error("Map library failed to load. Check that the browser can reach unpkg.com or jsdelivr.net.");
  }

  function loadScript(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      const timeout = window.setTimeout(function () {
        script.remove();
        reject(new Error(`${url} timed out`));
      }, timeoutMs);

      script.src = url;
      script.async = true;
      script.onload = function () {
        window.clearTimeout(timeout);
        resolve();
      };
      script.onerror = function () {
        window.clearTimeout(timeout);
        reject(new Error(`${url} failed to load`));
      };

      document.head.appendChild(script);
    });
  }

  function createMap() {
    if (!window.L) {
      throw new Error("Leaflet failed to load. Check your internet connection and refresh the page.");
    }

    const config = window.RIVER_APP_CONFIG || {};
    const center = config.defaultCenter || { lat: 52.8, lng: -1.6 };
    state.tileLayers = normalizeTileLayers(config.tileLayers);

    els.map.classList.remove("map-empty");
    els.map.textContent = "";
    state.map = L.map(els.map, {
      zoomControl: true,
      preferCanvas: true
    }).setView([center.lat, center.lng], config.defaultZoom || 6);

    renderMapStyleOptions(config.defaultTileLayer);
    setTileLayer(els.mapStyle.value || config.defaultTileLayer);
    setupMapResizeHandling();
  }

  function normalizeTileLayers(tileLayers) {
    const fallback = [
      {
        id: "osm-standard",
        label: "OpenStreetMap Standard",
        url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }
    ];

    return Array.isArray(tileLayers) && tileLayers.length ? tileLayers : fallback;
  }

  function renderMapStyleOptions(defaultTileLayer) {
    const fragment = document.createDocumentFragment();

    state.tileLayers.forEach(function (tileLayer) {
      const option = document.createElement("option");
      option.value = tileLayer.id;
      option.textContent = tileLayer.label;
      fragment.append(option);
    });

    els.mapStyle.replaceChildren(fragment);

    const preferred = safeStorageGet(TILE_LAYER_STORAGE_KEY) || defaultTileLayer || state.tileLayers[0].id;
    els.mapStyle.value = state.tileLayers.some(function (tileLayer) {
      return tileLayer.id === preferred;
    }) ? preferred : state.tileLayers[0].id;
  }

  function setTileLayer(tileLayerId, options) {
    const selected = state.tileLayers.find(function (tileLayer) {
      return tileLayer.id === tileLayerId;
    }) || state.tileLayers[0];

    if (!selected || !state.map) return;

    if (state.tileLayer) {
      state.tileLayer.remove();
      state.tileLayer = null;
    }

    let errors = 0;
    state.tileLayer = L.tileLayer(selected.url, {
      maxZoom: 19,
      attribution: selected.attribution,
      keepBuffer: 4,
      updateWhenIdle: false,
      updateWhenZooming: false
    }).addTo(state.map);

    state.tileLayer.on("tileerror", function () {
      errors += 1;
      if (errors === 3) {
        els.statusMessage.textContent = "Some map tiles failed. Try another map style from the Map menu.";
      }
    });

    safeStorageSet(TILE_LAYER_STORAGE_KEY, selected.id);
    els.mapStyle.value = selected.id;
    state.map.invalidateSize({ animate: false });

    if (options && options.announce) {
      els.statusMessage.textContent = `Map switched to ${selected.label}.`;
    }
  }

  function setupMapResizeHandling() {
    if (!state.map) return;

    const invalidate = function () {
      state.map.invalidateSize({ animate: false });
    };

    requestAnimationFrame(invalidate);
    window.setTimeout(invalidate, 250);
    window.addEventListener("resize", invalidate);

    if (window.ResizeObserver) {
      const observer = new ResizeObserver(invalidate);
      observer.observe(els.map);
    }
  }

  async function loadRiverIndex(options) {
    const force = Boolean(options && options.force);
    if (!force && state.rivers.length) return;

    const cached = force ? null : readCache(STATION_CACHE_KEY, STATION_CACHE_TTL, { includeMeta: true });
    if (cached) {
      state.stationDataState = { kind: "cached", fetchedAt: cached.createdAt, error: "" };
      hydrateRiverIndex(cached.value);
      return;
    }

    setBusy("Loading Environment Agency stations...");
    const url = `${EA_BASE}/id/stations?parameter=level&status=Active&_view=full`;
    try {
      const items = await fetchAllItems(url, { pageSize: API_PAGE_SIZE });
      const stations = items.filter(isRiverLevelStation).map(normalizeStation);
      const payload = buildRiverPayload(stations);
      writeCache(STATION_CACHE_KEY, payload);
      state.stationDataState = { kind: "live", fetchedAt: payload.createdAt, error: "" };
      hydrateRiverIndex(payload);
    } catch (error) {
      const stale = readCache(STATION_CACHE_KEY, STATION_CACHE_TTL, { allowExpired: true, includeMeta: true });
      if (stale) {
        state.stationDataState = {
          kind: "stale",
          fetchedAt: stale.createdAt,
          error: error && error.message ? error.message : "Station refresh failed."
        };
        hydrateRiverIndex(stale.value);
      } else {
        state.stationDataState = {
          kind: "failed",
          fetchedAt: 0,
          error: error && error.message ? error.message : "Station refresh failed."
        };
        hydrateRiverIndex(buildRiverPayload([]));
      }
    }
  }

  function buildRiverPayload(stations) {
    const riverMap = new Map();
    const stationsByUniqueId = new Map();

    stations.forEach(function (station) {
      const uniqueId = makeUniqueStationId(station.id, stationsByUniqueId);
      station.id = uniqueId;
      stationsByUniqueId.set(uniqueId, station);

      const riverName = cleanRiverName(station.riverName);
      const key = makeKey(riverName);
      if (!riverMap.has(key)) {
        riverMap.set(key, {
          key,
          name: riverName,
          displayName: riverDisplayName(riverName),
          riverType: classifyRiverType(riverName),
          stationIds: [],
          catchments: new Set(),
          bounds: createEmptyBounds()
        });
      }

      const river = riverMap.get(key);
      river.stationIds.push(station.id);
      if (station.catchmentName) river.catchments.add(station.catchmentName);
      extendPlainBounds(river.bounds, station.lat, station.lng);
    });

    const riverList = Array.from(riverMap.values())
      .map(function (river) {
        return {
          key: river.key,
          name: river.name,
          displayName: river.displayName || riverDisplayName(river.name),
          riverType: river.riverType,
          stationIds: river.stationIds,
          stationCount: river.stationIds.length,
          catchmentCount: river.catchments.size,
          bounds: river.bounds,
          center: centerOfPlainBounds(river.bounds)
        };
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, "en-GB");
      });

    return {
      createdAt: Date.now(),
      stations: Array.from(stationsByUniqueId.values()),
      rivers: riverList
    };
  }

  function hydrateRiverIndex(payload) {
    state.stationsById = new Map(payload.stations.map(function (station) {
      return [station.id, station];
    }));

    const nrwStations = normalizeNrwStations(window.NRW_STATIONS);
    state.nrwFetchedAt = parseDateTime(window.NRW_STATIONS_FETCHED_AT);
    nrwStations.forEach(function (station) {
      state.stationsById.set(station.id, station);
    });

    state.rivers = mergeRainchasersSections(payload.rivers, payload.stations.concat(nrwStations)).map(function (river) {
      return Object.assign({}, river, {
        riverType: river.riverType || classifyRiverType(river.name),
        stations: river.stationIds
          .map(function (id) { return state.stationsById.get(id); })
          .filter(Boolean)
      });
    });

    state.riverByKey = new Map(state.rivers.map(function (river) {
      return [river.key, river];
    }));

    renderRiverTypeTabs();
    els.riverListMeta.textContent = `${state.rivers.length} rivers from ${payload.stations.length + nrwStations.length} active level stations`;
    renderDataFreshness();
  }

  function mergeRainchasersSections(rivers, stations) {
    const riverMap = new Map();
    const stationsByDataUrl = groupStationsByDataUrl(stations);

    asArray(rivers).forEach(function (river) {
      if (classifyRiverType(river.name) === "whitewater") return;

      const copy = Object.assign({}, river, {
        key: river.key || makeKey(river.name),
        displayName: river.displayName || riverDisplayName(river.name),
        riverType: "flatwater",
        stationIds: asArray(river.stationIds),
        stationCount: isFiniteNumber(river.stationCount) ? Number(river.stationCount) : asArray(river.stationIds).length,
        sectionCount: isFiniteNumber(river.sectionCount) ? Number(river.sectionCount) : 0,
        gradeSummary: river.gradeSummary || "",
        catchmentCount: isFiniteNumber(river.catchmentCount) ? Number(river.catchmentCount) : 0,
        bounds: normalizePlainBounds(river.bounds)
      });

      copy.center = centerOfPlainBounds(copy.bounds);
      copy.key = makeUniqueRiverKey(copy.key, riverMap);
      riverMap.set(copy.key, copy);
    });

    getRainchasersSectionSummaries().forEach(function (summary) {
      const section = {
        key: makeUniqueRiverKey(`ww-${summary.sectionKey}`, riverMap),
        name: summary.riverName,
        displayName: riverDisplayName(summary.riverName),
        sectionName: summary.sectionName,
        sectionDisplayName: summary.sectionName,
        sectionId: summary.sectionId,
        riverType: "whitewater",
        stationIds: [],
        stationCount: 0,
        sectionCount: 1,
        gradeSummary: summary.grade,
        km: summary.km,
        notes: summary.notes,
        catchmentCount: 0,
        bounds: clonePlainBounds(summary.bounds),
        center: centerOfPlainBounds(summary.bounds),
        overviewPoint: summary.putIn,
        accessPoints: summary.points,
        rainchasersKey: summary.riverKey,
        accessSectionId: summary.sectionId,
        measureDataUrls: summary.measureDataUrls,
        rainchasersMeasures: summary.measures
      };

      summary.measureDataUrls.forEach(function (dataUrl) {
        asArray(stationsByDataUrl.get(dataUrl)).forEach(function (station) {
          addStationToRiver(section, station);
        });
      });

      if (!section.stationIds.length) {
        const nearest = findNearestStationForSection(section, stations);
        if (nearest) {
          addStationToRiver(section, nearest.station, { extendBounds: false });
          section.nearestGaugeStationId = nearest.station.id;
          section.nearestGaugeDistanceKm = nearest.distanceKm;
        }
      }

      riverMap.set(section.key, section);
    });

    return Array.from(riverMap.values()).sort(function (a, b) {
      const aName = `${displayRiverName(a)} ${a.sectionName || ""}`.trim();
      const bName = `${displayRiverName(b)} ${b.sectionName || ""}`.trim();
      return aName.localeCompare(bName, "en-GB");
    });
  }

  function groupStationsByDataUrl(stations) {
    return asArray(stations).reduce(function (grouped, station) {
      const dataUrl = String(station && station.dataUrl || "").toLowerCase();
      if (!dataUrl) return grouped;

      if (!grouped.has(dataUrl)) {
        grouped.set(dataUrl, []);
      }
      grouped.get(dataUrl).push(station);
      return grouped;
    }, new Map());
  }

  function addStationToRiver(river, station, options) {
    if (!river || !station || river.stationIds.includes(station.id)) return;
    river.stationIds.push(station.id);
    river.stationCount = river.stationIds.length;
    if (!options || options.extendBounds !== false) {
      extendPlainBounds(river.bounds, station.lat, station.lng);
      river.center = centerOfPlainBounds(river.bounds);
    }
  }

  function findNearestStationForSection(section, stations) {
    const anchors = sectionAnchorPoints(section);
    if (!anchors.length) return null;

    let nearest = null;
    const sectionRiverKey = accessMatchKey(section && section.name);
    asArray(stations).forEach(function (station) {
      if (!isFiniteNumber(station && station.lat) || !isFiniteNumber(station && station.lng)) return;

      const distanceKm = anchors.reduce(function (best, point) {
        return Math.min(best, distanceBetweenPointsKm(point, station));
      }, Infinity);

      const stationRiverKey = accessMatchKey(station.riverName);
      const sameRiver = Boolean(sectionRiverKey && stationRiverKey && (
        stationRiverKey === sectionRiverKey ||
        stationRiverKey.startsWith(`${sectionRiverKey}-`) ||
        sectionRiverKey.startsWith(`${stationRiverKey}-`)
      ));
      const maxDistanceKm = sameRiver ? MAX_SAME_RIVER_GAUGE_DISTANCE_KM : MAX_NEAREST_GAUGE_DISTANCE_KM;
      if (distanceKm > maxDistanceKm) return;

      const score = distanceKm + (sameRiver ? 0 : MAX_NEAREST_GAUGE_DISTANCE_KM);
      if (!nearest || score < nearest.score) {
        nearest = { station, distanceKm, sameRiver, score };
      }
    });

    return nearest;
  }

  function sectionAnchorPoints(section) {
    const points = asArray(section && section.accessPoints).filter(function (point) {
      return isFiniteNumber(point && point.lat) && isFiniteNumber(point && point.lng);
    });

    if (section && section.overviewPoint &&
        isFiniteNumber(section.overviewPoint.lat) && isFiniteNumber(section.overviewPoint.lng)) {
      points.push(section.overviewPoint);
    }

    if (section && section.center &&
        isFiniteNumber(section.center.lat) && isFiniteNumber(section.center.lng)) {
      points.push(section.center);
    }

    return points;
  }

  async function selectRiver(key, options) {
    const river = state.riverByKey.get(key);
    if (!river || !state.map) return;

    if (state.activeController) {
      state.activeController.abort();
    }

    const controller = new AbortController();
    state.activeController = controller;
    state.selectedRiverKey = key;
    state.riverType = river.riverType || classifyRiverType(river.name);

    history.replaceState(null, "", `#${encodeURIComponent(displaySelectedName(river))}`);
    renderRiverList({ preserveScroll: true });
    clearMapLayers();
    els.selectedRiver.textContent = displaySelectedName(river);
    els.selectedSource.textContent = selectedSourceLabel(river);
    els.overviewButton.hidden = false;
    renderSelectedSectionDetails(river);
    setBusy(`Loading ${displaySelectedName(river)}...`);
    updateSummary(river);
    renderGaugeList(river);
    drawGaugeMarkers(river);
    fitToStations(river);

    let selectedLines = [];

    const accessTask = loadAccessSections(river, { signal: controller.signal }).then(function () {
      if (controller.signal.aborted) return;
      drawAccessMarkers(river);
    }).catch(function (error) {
      if (controller.signal.aborted) return;
      console.warn(error);
    });

    const latestTask = (hasStationSource(river, "ea") ? loadLatestReadings({
      force: Boolean(options && options.forceLatest),
      signal: controller.signal
    }) : Promise.resolve()).then(function () {
      if (controller.signal.aborted) return;
      updateSummary(river);
      renderGaugeList(river);
      drawGaugeMarkers(river);
    }).catch(function (error) {
      if (controller.signal.aborted) return;
      state.latestDataState = {
        kind: "failed",
        fetchedAt: state.latestFetchedAt,
        error: error && error.message ? error.message : "Live reading refresh failed."
      };
      updateSummary(river);
      renderGaugeList(river);
      drawGaugeMarkers(river);
    });

    const geometryTask = loadRiverGeometry(river, {
      force: Boolean(options && options.forceGeometry),
      signal: controller.signal
    }).then(function (lines) {
      if (controller.signal.aborted) return;
      if (lines.length) {
        selectedLines = lines;
        drawRiverLines(lines);
        fitToSelectedContent(river, lines);
      } else {
        clearRiverLines();
        els.statusMessage.textContent = "Exact river line not found; gauges shown only.";
      }
    }).catch(function (error) {
      if (controller.signal.aborted) return;
      console.warn(error);
      clearRiverLines();
      els.statusMessage.textContent = "Exact river line not found; gauges shown only.";
    });

    await Promise.allSettled([latestTask, geometryTask, accessTask]);
    if (controller.signal.aborted) return;

    const readingCount = river.stations.filter(function (station) {
      return Boolean(selectReadingForStation(station));
    }).length;
    const accessCount = getMatchingAccessSections(river).reduce(function (sum, section) {
      return sum + section.points.length;
    }, 0);
    if (accessCount) {
      fitToSelectedContent(river, selectedLines);
    }
    els.statusMessage.textContent = selectedRiverStatus(river, readingCount, accessCount);
    renderDataFreshness();
    setReady();
  }

  function showOverview(options) {
    if (!state.map) return;

    if (state.activeController) {
      state.activeController.abort();
      state.activeController = null;
    }

    state.selectedRiverKey = "";
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    clearMapLayers();
    renderSelectedSectionDetails(null);
    els.selectedRiver.textContent = "Select a river";
    els.selectedSource.textContent = "UK river levels";
    els.overviewButton.hidden = true;
    els.riverSummary.replaceChildren();
    els.gaugeList.replaceChildren();
    els.statusMessage.textContent = "";
    renderRiverList({
      fitOverview: Boolean(options && options.fit),
      preserveScroll: true
    });
    refreshOverviewLevels();
    setReady();
  }

  async function loadLatestReadings(options) {
    const force = Boolean(options && options.force);
    const signal = options && options.signal;
    const freshInMemory = state.latestFetchedAt && Date.now() - state.latestFetchedAt < LATEST_CACHE_TTL;
    if (!force && freshInMemory) return;

    const cached = force ? null : readCache(LATEST_CACHE_KEY, LATEST_CACHE_TTL, { includeMeta: true });
    if (cached) {
      hydrateLatestReadings(cached.value.readings, cached.createdAt);
      state.latestDataState = { kind: "cached", fetchedAt: cached.createdAt, error: "" };
      return;
    }

    const url = `${EA_BASE}/data/readings?latest&parameter=level&_view=full`;
    try {
      const items = await fetchAllItems(url, { signal, pageSize: API_PAGE_SIZE });
      const readings = items.map(normalizeLatestReading).filter(Boolean);
      const createdAt = Date.now();
      hydrateLatestReadings(readings, createdAt);
      state.latestDataState = { kind: "live", fetchedAt: createdAt, error: "" };
      writeCache(LATEST_CACHE_KEY, { createdAt, readings });
    } catch (error) {
      const stale = readCache(LATEST_CACHE_KEY, LATEST_CACHE_TTL, { allowExpired: true, includeMeta: true });
      if (!stale) throw error;
      hydrateLatestReadings(stale.value.readings, stale.createdAt);
      state.latestDataState = {
        kind: "stale",
        fetchedAt: stale.createdAt,
        error: error && error.message ? error.message : "Live reading refresh failed."
      };
    }
  }

  function hydrateLatestReadings(readings, createdAt) {
    const grouped = new Map();

    readings.forEach(function (reading) {
      if (!grouped.has(reading.stationReference)) {
        grouped.set(reading.stationReference, []);
      }
      grouped.get(reading.stationReference).push(reading);
    });

    grouped.forEach(function (items) {
      items.sort(compareReadings);
    });

    state.latestByStationRef = grouped;
    state.latestFetchedAt = createdAt || Date.now();
  }

  async function loadRiverGeometry(river, options) {
    const force = Boolean(options && options.force);
    const signal = options && options.signal;
    const cacheKey = GEOMETRY_CACHE_PREFIX + river.key;
    const cached = force ? null : readCache(cacheKey, GEOMETRY_CACHE_TTL);
    if (cached) return cached.lines || [];

    const query = buildOverpassQuery(river);
    const body = `data=${encodeURIComponent(query)}`;
    const response = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body,
      signal
    });

    if (!response.ok) {
      throw new Error(`Overpass API returned ${response.status}`);
    }

    const data = await response.json();
    const lines = filterLinesNearRiver(extractLinesFromOverpass(data), river);
    writeCache(cacheKey, { createdAt: Date.now(), lines });
    return lines;
  }

  async function loadAccessSections(_river, options) {
    if (state.accessSections.length) return;

    const config = window.RIVER_APP_CONFIG || {};
    const globalName = config.accessSectionsGlobal || "";
    const url = config.accessSectionsUrl || "";
    const source = defaultAccessSource(config);

    if (globalName && Array.isArray(window[globalName])) {
      state.accessSections = window[globalName].map(function (item) {
        return normalizeAccessSection(item, source);
      }).filter(Boolean);
      return;
    }

    if (!url) return;

    const cached = readCache(ACCESS_SECTIONS_CACHE_KEY, ACCESS_SECTIONS_CACHE_TTL);
    if (cached) {
      state.accessSections = cached.sections || [];
      return;
    }

    const data = await fetchJson(url, { signal: options && options.signal });
    const sections = asArray(data).map(function (item) {
      return normalizeAccessSection(item, source);
    }).filter(Boolean);
    state.accessSections = sections;
    writeCache(ACCESS_SECTIONS_CACHE_KEY, {
      createdAt: Date.now(),
      sections
    });
  }

  function defaultAccessSource(config) {
    return {
      name: config.accessSectionsSourceName || "Rainchasers",
      url: config.accessSectionsSourceUrl || "https://github.com/robtuley/rainchasers",
      license: config.accessSectionsLicense || "MIT"
    };
  }

  function normalizeAccessSection(item, source) {
    return normalizeLocalAccessSection(item, source) || normalizeWhereTheWaterSection(item, source);
  }

  function normalizeLocalAccessSection(item, source) {
    const riverName = cleanRiverName(item.riverName || item.river);
    const name = cleanRiverName(item.name || [riverName, item.sectionName].filter(Boolean).join(" - "));
    if (!riverName || !name || !Array.isArray(item.points)) return null;

    const points = item.points.map(normalizeAccessPoint).filter(Boolean);
    if (!points.length) return null;

    return {
      id: item.id || makeKey(name),
      name,
      sectionId: item.id || makeKey(name),
      sectionName: cleanRiverName(item.sectionName),
      riverKey: makeKey(riverName),
      matchKey: accessMatchKey(riverName),
      grade: item.grade || "",
      km: numberOrNull(item.km),
      gaugeName: formatRainchasersMeasures(item.measures),
      guidebookLink: item.guidebookLink || "",
      accessIssue: item.accessIssue || "",
      notes: item.notes || "",
      rainchasersMeasures: normalizeRainchasersMeasures(item.measures),
      sourceName: item.sourceName || source.name,
      sourceUrl: item.sourceUrl || source.url,
      license: item.license || source.license,
      points
    };
  }

  function normalizeWhereTheWaterSection(item, source) {
    const name = cleanRiverName(item.name);
    if (!name) return null;

    const points = [];
    addAccessPoint(points, item, "put-in", item.put_in_lat, item.put_in_long);
    addAccessPoint(points, item, "get-out", item.get_out_lat, item.get_out_long);

    if (!points.length) return null;

    return {
      id: item.uuid || makeKey(name),
      name,
      riverKey: makeKey(name),
      matchKey: accessMatchKey(name),
      grade: item.grade || "",
      gaugeName: item.gauge_name || "",
      guidebookLink: item.guidebook_link || "",
      accessIssue: item.access_issue || "",
      notes: item.notes || "",
      sourceName: source.name,
      sourceUrl: source.url,
      license: source.license,
      points
    };
  }

  function normalizeAccessPoint(point) {
    const latitude = numberOrNull(point && point.lat);
    const longitude = numberOrNull(point && point.lng);
    if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;

    return {
      type: point.type === "get-out" ? "get-out" : "put-in",
      label: point.label || (point.type === "get-out" ? "Get out" : "Put in"),
      lat: latitude,
      lng: longitude
    };
  }

  function findAccessPoint(points, type) {
    const normalized = asArray(points).map(normalizeAccessPoint).filter(Boolean);
    return normalized.find(function (point) {
      return point.type === type;
    }) || normalized[0] || null;
  }

  function normalizeRainchasersMeasures(measures) {
    return asArray(measures).map(function (measure) {
      const normalized = {
        dataUrl: String(measure && measure.data_url || "").toLowerCase(),
        desc: String(measure && measure.desc || "").trim()
      };

      FLOW_LEVELS.forEach(function (level) {
        normalized[level] = numberOrNull(measure && measure[level]);
      });

      if (!isFiniteNumber(normalized.huge)) {
        normalized.huge = numberOrNull(measure && measure.too_high);
      }

      const hasLevel = FLOW_LEVELS.some(function (level) {
        return isFiniteNumber(normalized[level]);
      });

      return normalized.dataUrl || normalized.desc || hasLevel ? normalized : null;
    }).filter(Boolean);
  }

  function addAccessPoint(points, section, type, lat, lng) {
    const latitude = numberOrNull(lat);
    const longitude = numberOrNull(lng);
    if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return;

    points.push({
      type,
      label: type === "put-in" ? "Put in" : "Get out",
      lat: latitude,
      lng: longitude,
      sectionName: cleanRiverName(section.name),
      grade: section.grade || "",
      guidebookLink: section.guidebook_link || "",
      accessIssue: section.access_issue || "",
      notes: section.notes || ""
    });
  }

  function renderRiverList(options) {
    const previousScrollTop = options && options.preserveScroll ? els.riverList.scrollTop : null;
    const query = currentRiverSearchQuery();
    const rivers = getMenuRivers();
    const visible = rivers.slice(0, MAX_RIVERS_VISIBLE);
    const fragment = document.createDocumentFragment();

    renderRiverTypeTabs();

    visible.forEach(function (river) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "river-button";
      if (river.key === state.selectedRiverKey) {
        button.classList.add("active");
      }
      button.dataset.riverKey = river.key;
      button.addEventListener("click", function () {
        selectRiver(river.key);
      });

      const main = document.createElement("span");
      main.className = "river-card-main";

      const name = document.createElement("span");
      name.className = "river-name";
      name.textContent = displayRiverName(river);

      const meta = document.createElement("span");
      meta.className = "river-meta";
      meta.textContent = riverMetaText(river);

      const tags = document.createElement("span");
      tags.className = "river-tags";

      if (river.riverType === "whitewater" && river.gradeSummary) {
        tags.append(createRiverTag(`Grade ${river.gradeSummary}`, "grade"));
      }

      if (river.riverType === "whitewater") {
        if (isFiniteNumber(river.km)) {
          tags.append(createRiverTag(formatDistance(river.km), ""));
        }
      } else {
        tags.append(createRiverTag(`${river.stationCount} gauges`, ""));
      }

      if (river.riverType === "whitewater" && river.nearestGaugeStationId) {
        tags.append(createRiverTag("nearest gauge", "gauge"));
      } else if (river.riverType === "whitewater" && river.stationCount) {
        tags.append(createRiverTag(`${river.stationCount} gauges`, "gauge"));
      }

      const flowBadge = createRiverFlowBadge(river);

      main.append(name, meta);
      button.append(main, tags, flowBadge);

      fragment.append(button);
    });

    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "list-meta";
      empty.textContent = "No matching rivers.";
      fragment.append(empty);
    }

    els.riverList.replaceChildren(fragment);
    if (previousScrollTop !== null) {
      els.riverList.scrollTop = previousScrollTop;
    }

    if (query && rivers.length > MAX_RIVERS_VISIBLE) {
      els.riverListMeta.textContent = `${rivers.length} ${riverTypeLabel(state.riverType).toLowerCase()} matches; showing first ${MAX_RIVERS_VISIBLE}`;
    } else if (query) {
      els.riverListMeta.textContent = `${rivers.length} matching ${riverTypeLabel(state.riverType).toLowerCase()} rivers`;
    } else if (state.rivers.length) {
      const stationCount = rivers.reduce(function (sum, river) {
        return sum + river.stationCount;
      }, 0);
      if (state.riverType === "whitewater") {
        const sectionCount = rivers.reduce(function (sum, river) {
          return sum + (river.sectionCount || 0);
        }, 0);
        els.riverListMeta.textContent = `${rivers.length} white water sections, ${sectionCount} paddle sections, ${stationCount} assigned gauges`;
      } else {
        els.riverListMeta.textContent = `${rivers.length} flat water rivers from ${stationCount} active level stations`;
      }
    }

    if (!state.selectedRiverKey) {
      drawOverviewMarkers(rivers, { fit: Boolean(options && options.fitOverview) });
    }
  }

  function currentRiverSearchQuery() {
    return els.riverSearch.value.trim().toLowerCase();
  }

  function getMenuRivers() {
    const query = currentRiverSearchQuery();
    return state.rivers.filter(function (river) {
      const displayName = displayRiverName(river);
      return river.riverType === state.riverType &&
        (!query || displayName.toLowerCase().includes(query));
    });
  }

  function renderRiverTypeTabs() {
    const counts = countRiverTypes();

    els.riverTypeTabs.forEach(function (tab) {
      const type = tab.dataset.riverType || "whitewater";
      const active = type === state.riverType;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
      tab.textContent = `${riverTypeLabel(type)} ${counts[type] || 0}`;
      if (active && els.riverList) {
        els.riverList.setAttribute("aria-labelledby", tab.id);
      }
    });
  }

  function countRiverTypes() {
    return state.rivers.reduce(function (counts, river) {
      const type = river.riverType || classifyRiverType(river.name);
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, { whitewater: 0, flatwater: 0 });
  }

  function riverTypeLabel(type) {
    return type === "flatwater" ? "Flat water" : "White water";
  }

  function riverMetaText(river) {
    if (river.sectionName) {
      return river.sectionName;
    }

    if (river.riverType === "whitewater") {
      if (hasStationSource(river, "ea") && hasStationSource(river, "nrw")) return "Rainchasers + EA/NRW gauges";
      if (river.nearestGaugeStationId) return "Rainchasers + nearest gauge";
      if (hasStationSource(river, "nrw")) return "Rainchasers + NRW gauges";
      if (hasStationSource(river, "ea")) return "Rainchasers + EA gauges";
      return "Rainchasers access points";
    }

    return "Environment Agency gauges";
  }

  function createRiverTag(text, kind) {
    const tag = document.createElement("span");
    tag.className = `river-tag ${kind || ""}`.trim();
    tag.textContent = text;
    return tag;
  }

  function createRiverFlowBadge(river) {
    const flow = classifyRainchasersFlow(river);
    const meta = FLOW_LEVEL_META[flow.kind] || FLOW_LEVEL_META.missing;
    const badge = document.createElement("span");
    badge.className = `river-flow-badge flow-${meta.className}`;
    badge.textContent = meta.label;
    badge.setAttribute("aria-label", `Flow status: ${meta.label}`);
    return badge;
  }

  function renderSelectedSectionDetails(river) {
    if (!els.selectedSectionDetails) return;
    if (!river || river.riverType !== "whitewater") {
      els.selectedSectionDetails.hidden = true;
      els.selectedSectionDetails.replaceChildren();
      return;
    }

    const title = document.createElement("h2");
    title.textContent = displayRiverName(river);

    const section = document.createElement("p");
    section.className = "selected-section-name";
    section.textContent = river.sectionName || "White water section";

    const tags = document.createElement("div");
    tags.className = "selected-section-tags";
    if (river.gradeSummary) {
      tags.append(createRiverTag(`Grade ${river.gradeSummary}`, "grade"));
    }
    if (isFiniteNumber(river.km)) {
      tags.append(createRiverTag(formatDistance(river.km), ""));
    }
    if (river.nearestGaugeStationId) {
      tags.append(createRiverTag("nearest gauge", "gauge"));
    } else if (river.stationCount) {
      tags.append(createRiverTag(`${river.stationCount} gauges`, "gauge"));
    }

    const notes = document.createElement("p");
    notes.className = "selected-section-notes";
    notes.textContent = river.notes || "No section notes in the local Rainchasers data.";

    els.selectedSectionDetails.replaceChildren(title, section, tags, notes);
    els.selectedSectionDetails.hidden = false;
  }

  function selectedSourceLabel(river) {
    if (!river.stationCount) return "Rainchasers";
    if (river.riverType !== "whitewater") return "Environment Agency";

    const sources = ["Rainchasers"];
    if (river.nearestGaugeStationId) sources.push("Nearest gauge");
    if (hasStationSource(river, "ea")) sources.push("Environment Agency");
    if (hasStationSource(river, "nrw")) sources.push("Natural Resources Wales");
    return sources.join(" / ");
  }

  function hasStationSource(river, source) {
    return asArray(river.stations).some(function (station) {
      return station && station.source === source;
    });
  }

  function renderGaugeList(river) {
    const fragment = document.createDocumentFragment();
    const stations = river.stations.slice().sort(function (a, b) {
      return a.label.localeCompare(b.label, "en-GB");
    });

    if (!stations.length) {
      const empty = document.createElement("p");
      empty.className = "empty-gauges";
      empty.textContent = "No gauge data is available for this river.";
      fragment.append(empty);
      els.gaugeList.replaceChildren(fragment);
      return;
    }

    stations.forEach(function (station) {
      fragment.append(createGaugeCard(station, river));
    });

    els.gaugeList.replaceChildren(fragment);
  }

  function createGaugeCard(station, river) {
    const reading = selectReadingForStation(station);
    const readingStatus = classifyReading(reading, station);
    const card = document.createElement("article");
    card.className = "gauge-card";

    const header = document.createElement("header");
    const titleBlock = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "gauge-title";
    title.textContent = station.label;

    const town = document.createElement("p");
    town.className = "gauge-town";
    const nearestDistance = isNearestGaugeStation(river, station) && isFiniteNumber(river.nearestGaugeDistanceKm)
      ? `Nearest available gauge, ${formatDistance(river.nearestGaugeDistanceKm)} away`
      : "";
    town.textContent = nearestDistance || [station.town, station.catchmentName].filter(Boolean).join(" / ") || "Gauge station";

    const statusChip = document.createElement("span");
    statusChip.className = `chip ${readingStatus.kind}`;
    statusChip.textContent = readingStatus.label;
    statusChip.setAttribute("aria-label", `Gauge status: ${readingStatus.label}`);

    titleBlock.append(title, town);
    header.append(titleBlock, statusChip);

    const value = document.createElement("div");
    value.className = "gauge-value";
    const levelNumber = document.createElement("span");
    levelNumber.className = "level-number";
    levelNumber.textContent = reading && isFiniteNumber(reading.value) ? formatLevel(reading.value) : "--";
    const levelUnit = document.createElement("span");
    levelUnit.className = "level-unit";
    levelUnit.textContent = reading && reading.unitName ? reading.unitName : "m";
    value.append(levelNumber, levelUnit);

    const meta = document.createElement("div");
    meta.className = "reading-meta";
    meta.append(createChip(reading ? formatDateTime(reading.dateTime) : "No latest reading", reading ? "" : "missing"));
    if (reading && reading.qualifier) {
      meta.append(createChip(reading.qualifier, ""));
    }

    const range = formatTypicalRange(station, reading);
    if (range) {
      meta.append(createChip(range, ""));
    }

    card.append(header, value, meta);
    return card;
  }

  function updateSummary(river) {
    const readingCount = river.stations.filter(function (station) {
      return Boolean(selectReadingForStation(station));
    }).length;
    const latestTime = latestReadingTime(river);

    els.riverSummary.replaceChildren(
      createSummaryItem(river.stationCount, "gauges"),
      createSummaryItem(readingCount, "current"),
      createSummaryItem(latestTime ? formatTimeOnly(latestTime) : "--", "latest")
    );
  }

  function createSummaryItem(value, label) {
    const item = document.createElement("div");
    item.className = "summary-item";

    const valueEl = document.createElement("span");
    valueEl.className = "summary-value";
    valueEl.textContent = value;

    const labelEl = document.createElement("span");
    labelEl.className = "summary-label";
    labelEl.textContent = label;

    item.append(valueEl, labelEl);
    return item;
  }

  function refreshOverviewLevels(options) {
    if (state.selectedRiverKey) return;

    loadLatestReadings({
      force: Boolean(options && options.force)
    }).then(function () {
      if (!state.selectedRiverKey) {
        renderRiverList({ preserveScroll: true });
        renderDataFreshness();
        if (state.latestDataState.kind === "live") {
          els.statusMessage.textContent = "Live gauge readings loaded.";
        } else if (state.latestDataState.kind === "cached") {
          els.statusMessage.textContent = "Gauge readings loaded from cache.";
        } else if (state.latestDataState.kind === "stale") {
          els.statusMessage.textContent = "Stale cached readings shown because the live refresh failed.";
        } else {
          els.statusMessage.textContent = "Live gauge readings are unavailable.";
        }
      }
    }).catch(function (error) {
      console.warn(error);
      state.latestDataState = {
        kind: "failed",
        fetchedAt: state.latestFetchedAt,
        error: error && error.message ? error.message : "Live reading refresh failed."
      };
      renderDataFreshness();
      els.statusMessage.textContent = state.stationDataState.kind === "failed"
        ? "Live Environment Agency data is unavailable; Rainchasers and NRW snapshot data remain available."
        : "Live gauge readings are unavailable.";
    });
  }

  function drawOverviewMarkers(rivers, options) {
    clearOverviewMarkers();
    if (!state.map || state.selectedRiverKey) return;

    const bounds = L.latLngBounds([]);
    asArray(rivers).slice(0, MAX_RIVERS_VISIBLE).forEach(function (river) {
      const point = overviewPointForRiver(river);
      if (!point) return;

      const flow = classifyRainchasersFlow(river);
      const marker = L.marker([point.lat, point.lng], {
        icon: createOverviewIcon(flow.kind),
        title: displaySelectedName(river)
      })
        .bindPopup(createOverviewPopupHtml(river, flow))
        .on("click", function () {
          selectRiver(river.key);
        })
        .addTo(state.map);

      state.overviewMarkers.push(marker);
      bounds.extend([point.lat, point.lng]);
    });

    if (options && options.fit && bounds.isValid()) {
      fitBoundsAwayFromPanel(bounds, 70);
    }
  }

  function overviewPointForRiver(river) {
    if (river && river.overviewPoint && isFiniteNumber(river.overviewPoint.lat) && isFiniteNumber(river.overviewPoint.lng)) {
      return river.overviewPoint;
    }

    if (river && river.riverType !== "whitewater" && river.center &&
        isFiniteNumber(river.center.lat) && isFiniteNumber(river.center.lng)) {
      return river.center;
    }

    return null;
  }

  function drawGaugeMarkers(river) {
    clearMarkers();

    river.stations.forEach(function (station) {
      if (!isFiniteNumber(station.lat) || !isFiniteNumber(station.lng)) return;

      const reading = selectReadingForStation(station);
      const readingStatus = classifyReading(reading, station);
      const marker = L.circleMarker([station.lat, station.lng], createMarkerStyle(readingStatus.kind))
        .bindPopup(createPopupHtml(station, reading, readingStatus))
        .addTo(state.map);

      state.markers.push(marker);
    });
  }

  function drawAccessMarkers(river) {
    clearAccessMarkers();

    getMatchingAccessSections(river).forEach(function (section) {
      section.points.forEach(function (point) {
        const marker = L.marker([point.lat, point.lng], {
          icon: createAccessIcon(point.type),
          title: `${point.label}: ${section.name}`
        })
          .bindPopup(createAccessPopupHtml(point, section))
          .addTo(state.map);

        state.accessMarkers.push(marker);
      });
    });
  }

  function getMatchingAccessSections(river) {
    if (river.accessSectionId) {
      return state.accessSections.filter(function (section) {
        return section.sectionId === river.accessSectionId || section.id === river.accessSectionId;
      });
    }

    const riverKey = accessMatchKey(river.name);
    const exactRainchasersKey = river.rainchasersKey || makeKey(river.name);
    if (!riverKey) return [];

    return state.accessSections.filter(function (section) {
      if (section.riverKey && section.riverKey === exactRainchasersKey) return true;
      if (river.rainchasersKey) return false;

      return section.matchKey === riverKey ||
        section.matchKey.startsWith(`${riverKey}-`) ||
        riverKey.startsWith(`${section.matchKey}-`);
    });
  }

  function drawRiverLines(lines) {
    clearRiverLines();

    lines.forEach(function (path) {
      const latLngs = path.map(function (point) {
        return [point.lat, point.lng];
      });

      const halo = L.polyline(latLngs, {
        color: "#ffffff",
        opacity: 0.95,
        weight: 14,
        interactive: false
      }).addTo(state.map);

      const line = L.polyline(latLngs, {
        color: "#00a3d7",
        opacity: 1,
        weight: 7,
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }).addTo(state.map);

      state.riverLines.push(halo, line);
    });
  }

  function clearMapLayers() {
    clearMarkers();
    clearOverviewMarkers();
    clearAccessMarkers();
    clearRiverLines();
    if (state.map) state.map.closePopup();
  }

  function clearMarkers() {
    state.markers.forEach(function (marker) {
      marker.remove();
    });
    state.markers = [];
  }

  function clearOverviewMarkers() {
    state.overviewMarkers.forEach(function (marker) {
      marker.remove();
    });
    state.overviewMarkers = [];
  }

  function clearAccessMarkers() {
    state.accessMarkers.forEach(function (marker) {
      marker.remove();
    });
    state.accessMarkers = [];
  }

  function clearRiverLines() {
    state.riverLines.forEach(function (line) {
      line.remove();
    });
    state.riverLines = [];
  }

  function fitToStations(river) {
    const bounds = leafletBoundsFromPlain(river.bounds);
    if (!bounds) return;
    fitBoundsAwayFromPanel(bounds, 60);
  }

  function fitToSelectedContent(river, lines) {
    const bounds = L.latLngBounds([]);

    river.stations.forEach(function (station) {
      if (!isFiniteNumber(station.lat) || !isFiniteNumber(station.lng)) return;
      bounds.extend([station.lat, station.lng]);
    });

    getMatchingAccessSections(river).forEach(function (section) {
      section.points.forEach(function (point) {
        bounds.extend([point.lat, point.lng]);
      });
    });

    lines.forEach(function (line) {
      line.forEach(function (point) {
        bounds.extend([point.lat, point.lng]);
      });
    });

    if (bounds.isValid()) {
      fitBoundsAwayFromPanel(bounds, 64);
    }
  }

  function fitBoundsAwayFromPanel(bounds, basePadding) {
    if (!state.map || !bounds || !bounds.isValid()) return;

    const padding = getMapFitPadding(basePadding);
    state.map.fitBounds(bounds, Object.assign({
      maxZoom: 13
    }, padding));
  }

  function getMapFitPadding(basePadding) {
    const fallback = { padding: [basePadding, basePadding] };
    if (!state.map || !els.riverPanel) return fallback;

    const mapRect = state.map.getContainer().getBoundingClientRect();
    const panelRect = els.riverPanel.getBoundingClientRect();
    const overlapLeft = Math.max(mapRect.left, panelRect.left);
    const overlapRight = Math.min(mapRect.right, panelRect.right);
    const overlapTop = Math.max(mapRect.top, panelRect.top);
    const overlapBottom = Math.min(mapRect.bottom, panelRect.bottom);
    const overlapWidth = Math.max(0, overlapRight - overlapLeft);
    const overlapHeight = Math.max(0, overlapBottom - overlapTop);

    if (!overlapWidth || !overlapHeight) return fallback;

    const mapWidth = Math.max(1, mapRect.width);
    const mapHeight = Math.max(1, mapRect.height);
    const extraGap = 24;
    const edgeTolerance = 48;
    const topLeft = [basePadding, basePadding];
    const bottomRight = [basePadding, basePadding];
    const widePanel = overlapWidth > mapWidth * 0.65;
    const tallPanel = overlapHeight > mapHeight * 0.25;

    if (!widePanel && tallPanel && panelRect.right > mapRect.right - edgeTolerance) {
      bottomRight[0] = Math.min(Math.round(mapWidth * 0.52), Math.ceil(overlapWidth + basePadding + extraGap));
    }

    if (!widePanel && tallPanel && panelRect.left < mapRect.left + edgeTolerance) {
      topLeft[0] = Math.min(Math.round(mapWidth * 0.52), Math.ceil(overlapWidth + basePadding + extraGap));
    }

    if (widePanel && panelRect.bottom > mapRect.bottom - edgeTolerance) {
      bottomRight[1] = Math.min(Math.round(mapHeight * 0.48), Math.ceil(overlapHeight + basePadding + extraGap));
    }

    if (widePanel && panelRect.top < mapRect.top + edgeTolerance) {
      topLeft[1] = Math.min(Math.round(mapHeight * 0.48), Math.ceil(overlapHeight + basePadding + extraGap));
    }

    return {
      paddingTopLeft: topLeft,
      paddingBottomRight: bottomRight
    };
  }

  function selectRiverFromHash() {
    const hashName = parseLocationHash(window.location.hash);
    if (!hashName) return;
    const key = makeKey(hashName);
    if (state.riverByKey.has(key)) {
      selectRiver(key);
      return;
    }

    const match = state.rivers.find(function (river) {
      return makeKey(displayRiverName(river)) === key || makeKey(displaySelectedName(river)) === key;
    });
    if (match) {
      selectRiver(match.key);
    }
  }

  function selectReadingForStation(station) {
    if (station.latestReading) return station.latestReading;
    if (!station.stationReference) return null;
    const readings = state.latestByStationRef.get(station.stationReference);
    if (!readings || !readings.length) return null;

    const measureIds = new Set(station.measures.map(function (measure) {
      return measure.id;
    }).filter(Boolean));

    const matching = readings.filter(function (reading) {
      return !measureIds.size || !reading.measureId || measureIds.has(reading.measureId);
    });

    return matching[0] || readings[0] || null;
  }

  function classifyReading(reading, station) {
    if (!reading || !isFiniteNumber(reading.value)) {
      return { kind: "missing", label: "No reading" };
    }

    if (station && station.source === "nrw" && /offline/i.test(station.statusText || "")) {
      return { kind: "missing", label: "Offline" };
    }

    const scale = scaleForReading(station, reading);
    if (scale && isFiniteNumber(scale.typicalRangeHigh) && reading.value > scale.typicalRangeHigh) {
      return { kind: "high", label: "Above typical" };
    }

    if (scale && isFiniteNumber(scale.typicalRangeLow) && reading.value < scale.typicalRangeLow) {
      return { kind: "low", label: "Below typical" };
    }

    return { kind: "good", label: scale ? "Within typical" : "Latest reading" };
  }

  function classifyRainchasersFlow(river) {
    const measures = asArray(river && river.rainchasersMeasures);
    let fallback = {
      kind: "missing",
      label: FLOW_LEVEL_META.missing.label
    };

    for (const measure of measures) {
      const station = stationForRainchasersMeasure(river, measure);
      const reading = station ? selectReadingForStation(station) : null;
      const status = classifyRainchasersMeasure(measure, reading);
      const result = Object.assign({}, status, {
        measure,
        station,
        reading
      });

      if (result.kind !== "missing") return result;
      fallback = result;
    }

    return fallback;
  }

  function classifyRainchasersMeasure(measure, reading) {
    if (!reading || !isFiniteNumber(reading.value)) {
      return {
        kind: "missing",
        label: "No live reading"
      };
    }

    const hasThreshold = FLOW_LEVELS.some(function (level) {
      return isFiniteNumber(measure && measure[level]);
    });
    if (!hasThreshold) {
      return {
        kind: "missing",
        label: "No measure thresholds"
      };
    }

    let kind = "scrape";
    FLOW_LEVELS.slice().reverse().some(function (level) {
      if (isFiniteNumber(measure[level]) && reading.value >= measure[level]) {
        kind = level;
        return true;
      }
      return false;
    });

    const meta = FLOW_LEVEL_META[kind] || FLOW_LEVEL_META.missing;
    return {
      kind,
      label: meta.label
    };
  }

  function stationForRainchasersMeasure(river, measure) {
    const dataUrl = String((measure && (measure.dataUrl || measure.data_url)) || "").toLowerCase();
    if (dataUrl) {
      const match = asArray(river && river.stations).find(function (station) {
        return String(station && station.dataUrl || "").toLowerCase() === dataUrl;
      });
      if (match) return match;
    }

    const stations = asArray(river && river.stations);
    return stations.length === 1 ? stations[0] : null;
  }

  function isNearestGaugeStation(river, station) {
    return Boolean(river && station && river.nearestGaugeStationId && river.nearestGaugeStationId === station.id);
  }

  function scaleForReading(station, reading) {
    if (reading && /downstream/i.test(reading.qualifier || "")) {
      return station.downstageScale || station.stageScale || null;
    }
    return station.stageScale || station.downstageScale || null;
  }

  function latestReadingTime(river) {
    const dates = river.stations
      .map(selectReadingForStation)
      .filter(Boolean)
      .map(function (reading) { return new Date(reading.dateTime); })
      .filter(function (date) { return !Number.isNaN(date.getTime()); });

    if (!dates.length) return null;
    return new Date(Math.max.apply(null, dates.map(function (date) { return date.getTime(); })));
  }

  function normalizeStation(item) {
    const measures = asArray(item.measures).map(normalizeMeasure).filter(function (measure) {
      return measure.parameter === "level" && !/groundwater/i.test(measure.qualifier || "");
    });

    return {
      id: String(item.stationReference || item.notation || tailFromUri(item["@id"])),
      source: "ea",
      sourceLabel: "Environment Agency",
      dataUrl: stationDataUrlFromRloiId(item),
      uri: item["@id"] || "",
      stationReference: item.stationReference || "",
      label: localisedText(item.label) || item.stationReference || "Unnamed gauge",
      riverName: cleanRiverName(localisedText(item.riverName)),
      town: localisedText(item.town),
      catchmentName: localisedText(item.catchmentName),
      lat: Number(item.lat),
      lng: Number(item.long),
      measures,
      stageScale: normalizeScale(item.stageScale),
      downstageScale: normalizeScale(item.downstageScale)
    };
  }

  function stationDataUrlFromRloiId(item) {
    const rloiId = item && (item.RLOIid || item.RLOIId || item.rloiId || item.rloiID);
    return rloiId ? `rloi://${String(rloiId).trim()}`.toLowerCase() : "";
  }

  function normalizeNrwStations(items) {
    return asArray(items).map(normalizeNrwStation).filter(Boolean);
  }

  function normalizeNrwStation(item) {
    const parameter = asArray(item && item.parameters).find(isNrwRiverLevelParameter);
    if (!item || !parameter) return null;

    const coords = osGridToLatLng(
      item.britishNationalGrid && item.britishNationalGrid.x,
      item.britishNationalGrid && item.britishNationalGrid.y
    );
    if (!coords) return null;

    const id = String(item.id || parameter.locationId || "");
    if (!id) return null;

    const stationReference = `nrw-${id}`;
    const measureId = `nrw-${parameter.id || id}`;
    const unitName = parameter.unit || "m";

    return {
      id: stationReference,
      source: "nrw",
      sourceLabel: "Natural Resources Wales",
      dataUrl: `rloi://${id}`,
      uri: `https://rivers-and-seas.naturalresources.wales/Station/Details/${id}`,
      stationReference,
      label: localisedText(item.title) || localisedText(item.name) || `NRW ${id}`,
      riverName: cleanRiverName(localisedText(item.waterBody)),
      town: "",
      catchmentName: cleanRiverName(localisedText(item.catchment)),
      statusText: localisedText(item.statusText),
      lat: coords.lat,
      lng: coords.lng,
      measures: [{
        id: measureId,
        label: localisedText(parameter.typeText) || "River Level",
        parameter: "level",
        qualifier: "stage",
        unitName
      }],
      latestReading: {
        stationReference,
        value: numberOrNull(parameter.latestValue),
        dateTime: parameter.latestTime || "",
        qualifier: "stage",
        unitName,
        measureId,
        measureLabel: localisedText(parameter.typeText) || "River Level",
        source: "nrw"
      },
      stageScale: null,
      downstageScale: null
    };
  }

  function isNrwRiverLevelParameter(parameter) {
    return Number(parameter && parameter.typeId) === 1 || /river level/i.test(localisedText(parameter && parameter.typeText));
  }

  function normalizeMeasure(measure) {
    return {
      id: measure["@id"] || "",
      label: measure.label || "",
      parameter: String(measure.parameter || "").toLowerCase(),
      qualifier: measure.qualifier || "",
      unitName: measure.unitName || ""
    };
  }

  function normalizeScale(scale) {
    if (!scale) return null;
    return {
      typicalRangeHigh: numberOrNull(scale.typicalRangeHigh),
      typicalRangeLow: numberOrNull(scale.typicalRangeLow),
      scaleMax: numberOrNull(scale.scaleMax)
    };
  }

  function normalizeLatestReading(item) {
    const measure = item.measure || {};
    const stationReference = measure.stationReference || "";
    const qualifier = measure.qualifier || "";
    if (!stationReference || /groundwater/i.test(qualifier)) return null;

    return {
      stationReference,
      value: numberOrNull(item.value),
      dateTime: item.dateTime || item.date || "",
      qualifier,
      unitName: measure.unitName || "m",
      measureId: measure["@id"] || "",
      measureLabel: measure.label || ""
    };
  }

  function isRiverLevelStation(item) {
    if (!cleanRiverName(item.riverName)) return false;
    if (!isFiniteNumber(Number(item.lat)) || !isFiniteNumber(Number(item.long))) return false;

    const typeText = asArray(item.type).map(typeName).join(" ").toLowerCase();
    if (typeText.includes("groundwater") || typeText.includes("coastal") || typeText.includes("meteorological")) {
      return false;
    }

    return asArray(item.measures).some(function (measure) {
      return String(measure.parameter || "").toLowerCase() === "level" && !/groundwater/i.test(measure.qualifier || "");
    });
  }

  function compareReadings(a, b) {
    const priority = readingPriority(a) - readingPriority(b);
    if (priority !== 0) return priority;
    return new Date(b.dateTime).getTime() - new Date(a.dateTime).getTime();
  }

  function readingPriority(reading) {
    const qualifier = (reading.qualifier || "").toLowerCase();
    if (qualifier === "stage") return 0;
    if (qualifier.includes("upstream")) return 1;
    if (qualifier.includes("downstream")) return 2;
    if (qualifier.includes("tidal")) return 4;
    return 3;
  }

  function buildOverpassQuery(river) {
    const riverName = typeof river === "string" ? river : river.name;
    const variants = riverNameVariants(riverName).map(escapeOverpassRegex);
    const pattern = variants.join("|");
    const bbox = overpassBboxForRiver(river);

    if (bbox) {
      return `
[out:json][timeout:25];
(
  way["waterway"~"^(river|stream|canal)$"]["name"~"^(${pattern})$",i]${bbox};
  relation["waterway"~"^(river|stream|canal)$"]["name"~"^(${pattern})$",i]${bbox};
  relation["type"="waterway"]["name"~"^(${pattern})$",i]${bbox};
);
out geom;`;
    }

    return `
[out:json][timeout:25];
area["ISO3166-2"="GB-ENG"][admin_level=4]->.searchArea;
(
  way["waterway"~"^(river|stream|canal)$"]["name"~"^(${pattern})$",i](area.searchArea);
  relation["waterway"~"^(river|stream|canal)$"]["name"~"^(${pattern})$",i](area.searchArea);
  relation["type"="waterway"]["name"~"^(${pattern})$",i](area.searchArea);
);
out geom;`;
  }

  function overpassBboxForRiver(river) {
    if (!river || !river.bounds || !Number.isFinite(river.bounds.north)) return "";
    const bounds = expandPlainBounds(river.bounds, 0.35);
    return `(${bounds.south},${bounds.west},${bounds.north},${bounds.east})`;
  }

  function extractLinesFromOverpass(data) {
    const lines = [];
    asArray(data.elements).forEach(function (element) {
      if (Array.isArray(element.geometry)) {
        addGeometryLine(lines, element.geometry);
      }

      asArray(element.members).forEach(function (member) {
        if (Array.isArray(member.geometry)) {
          addGeometryLine(lines, member.geometry);
        }
      });
    });

    return lines;
  }

  function addGeometryLine(lines, geometry) {
    const path = geometry
      .map(function (point) {
        return { lat: Number(point.lat), lng: Number(point.lon) };
      })
      .filter(function (point) {
        return isFiniteNumber(point.lat) && isFiniteNumber(point.lng);
      });

    if (path.length > 1) {
      lines.push(path);
    }
  }

  function filterLinesNearRiver(lines, river) {
    if (!lines.length) return lines;
    const bounds = expandPlainBounds(river.bounds, 0.6);
    const filtered = lines.filter(function (line) {
      return line.some(function (point) {
        return point.lat >= bounds.south &&
          point.lat <= bounds.north &&
          point.lng >= bounds.west &&
          point.lng <= bounds.east;
      });
    });

    return filtered.length ? filtered : lines;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, Object.assign({
      headers: { Accept: "application/json" }
    }, options || {}));

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    return response.json();
  }

  async function fetchAllItems(url, options) {
    const pageSize = Number(options && options.pageSize) || API_PAGE_SIZE;
    const signal = options && options.signal;
    const fetchPage = options && options.fetchPage;
    const items = [];

    for (let page = 0; page < MAX_API_PAGES; page += 1) {
      const pageUrl = new URL(url, window.location.href);
      pageUrl.searchParams.set("_limit", pageSize);
      pageUrl.searchParams.set("_offset", page * pageSize);
      const data = fetchPage
        ? await fetchPage(pageUrl.toString(), { signal })
        : await fetchJson(pageUrl.toString(), { signal });
      const pageItems = asArray(data && data.items);
      items.push.apply(items, pageItems);
      if (pageItems.length < pageSize) return items;
    }

    throw new Error(`API pagination exceeded ${MAX_API_PAGES} pages.`);
  }

  function createMarkerStyle(kind) {
    const colors = {
      good: "#137a52",
      low: "#486edb",
      high: "#c4631a",
      missing: "#7a7f85"
    };
    const color = colors[kind] || colors.missing;
    return {
      radius: 8,
      color: "#ffffff",
      weight: 3,
      fillColor: color,
      fillOpacity: 0.95,
      opacity: 0.95
    };
  }

  function createOverviewIcon(kind) {
    const meta = FLOW_LEVEL_META[kind] || FLOW_LEVEL_META.missing;
    return L.divIcon({
      className: "",
      html: `<span class="overview-marker flow-${meta.className}"></span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12]
    });
  }

  function createAccessIcon(type) {
    const isPutIn = type === "put-in";
    const className = isPutIn ? "access-marker put-in" : "access-marker get-out";
    const label = isPutIn ? "IN" : "OUT";

    return L.divIcon({
      className: "",
      html: `<span class="${className}">${label}</span>`,
      iconSize: [44, 28],
      iconAnchor: [22, 14],
      popupAnchor: [0, -14]
    });
  }

  function createOverviewPopupHtml(river, flow) {
    const section = river.sectionName ? `<br><span>${escapeHtml(river.sectionName)}</span>` : "";
    const grade = river.gradeSummary ? `<br><span>Grade ${escapeHtml(river.gradeSummary)}</span>` : "";
    const status = flow && flow.label ? flow.label : FLOW_LEVEL_META.missing.label;
    const reading = flow && flow.reading && isFiniteNumber(flow.reading.value)
      ? `${formatLevel(flow.reading.value)} ${flow.reading.unitName || "m"}`
      : "";
    const gauge = flow && flow.station ? flow.station.label : "";
    const detail = [status, reading, gauge].filter(Boolean).join(" / ");

    return `
      <div class="info-window">
        <strong>${escapeHtml(displayRiverName(river))}</strong>${section}${grade}<br>
        <span>${escapeHtml(detail || "No live measure")}</span>
      </div>
    `;
  }

  function createPopupHtml(station, reading, readingStatus) {
    const value = reading && isFiniteNumber(reading.value)
      ? `${formatLevel(reading.value)} ${reading.unitName || "m"}`
      : "No latest reading";
    const time = reading ? formatDateTime(reading.dateTime) : "";
    const place = [station.town, station.catchmentName].filter(Boolean).join(" / ");
    const source = station.sourceLabel ? `Source: ${station.sourceLabel}` : "";

    return `
      <div class="info-window">
        <strong>${escapeHtml(station.label)}</strong><br>
        ${place ? `<span>${escapeHtml(place)}</span><br>` : ""}
        <span>${escapeHtml(value)}</span><br>
        <span>${escapeHtml(readingStatus.label)}${time ? `, ${escapeHtml(time)}` : ""}</span>
        ${source ? `<br><span>${escapeHtml(source)}</span>` : ""}
      </div>
    `;
  }

  function createAccessPopupHtml(point, section) {
    const sourceName = section.sourceName || "Rainchasers";
    const license = section.license || "MIT";
    const links = [];

    const guidebookLink = safeExternalUrl(section.guidebookLink);
    const accessIssue = safeExternalUrl(section.accessIssue);
    const sourceUrl = safeExternalUrl(section.sourceUrl) || "https://github.com/robtuley/rainchasers";

    if (guidebookLink) {
      links.push(`<a href="${escapeHtml(guidebookLink)}" target="_blank" rel="noopener noreferrer">Guidebook</a>`);
    }
    if (accessIssue) {
      links.push(`<a href="${escapeHtml(accessIssue)}" target="_blank" rel="noopener noreferrer">Access issue</a>`);
    }

    return `
      <div class="info-window">
        <strong>${escapeHtml(point.label)}</strong><br>
        <span>${escapeHtml(section.name)}</span><br>
        ${section.grade ? `<span>Grade ${escapeHtml(section.grade)}</span><br>` : ""}
        ${isFiniteNumber(section.km) ? `<span>${escapeHtml(formatDistance(section.km))}</span><br>` : ""}
        ${links.length ? `<span>${links.join(" | ")}</span><br>` : ""}
        <span>Source: <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceName)}</a> (${escapeHtml(license)})</span>
      </div>
    `;
  }

  function createChip(text, className) {
    const chip = document.createElement("span");
    chip.className = `chip ${className || ""}`.trim();
    chip.textContent = text;
    return chip;
  }

  function formatTypicalRange(station, reading) {
    const scale = scaleForReading(station, reading);
    if (!scale || !isFiniteNumber(scale.typicalRangeLow) || !isFiniteNumber(scale.typicalRangeHigh)) {
      return "";
    }
    const unit = reading && reading.unitName ? reading.unitName : "m";
    return `Typical ${formatLevel(scale.typicalRangeLow)}-${formatLevel(scale.typicalRangeHigh)} ${unit}`;
  }

  function formatRainchasersMeasures(measures) {
    const items = asArray(measures).map(function (measure) {
      const reference = formatMeasureReference(measure && measure.data_url);
      const levels = ["scrape", "low", "medium", "high", "huge", "too_high"].map(function (key) {
        if (!measure || !isFiniteNumber(measure[key])) return "";
        return `${key.replace("_", " ")} ${formatLevel(measure[key])}`;
      }).filter(Boolean).join(", ");

      return [reference, levels].filter(Boolean).join(": ");
    }).filter(Boolean);

    if (!items.length) return "";
    return items.length > 2 ? `${items.slice(0, 2).join("; ")}; +${items.length - 2} more` : items.join("; ");
  }

  function formatMeasureReference(value) {
    const text = String(value || "");
    const rloi = text.match(/^rloi:\/\/(.+)$/i);
    if (rloi) return `RLOI ${rloi[1]}`;
    return text;
  }

  function formatDistance(value) {
    if (!isFiniteNumber(value)) return "";
    return `${Number(value).toLocaleString("en-GB", { maximumFractionDigits: 1 })} km`;
  }

  function distanceBetweenPointsKm(a, b) {
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const deltaLat = toRadians(b.lat - a.lat);
    const deltaLng = toRadians(b.lng - a.lng);
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function toRadians(value) {
    return Number(value) * Math.PI / 180;
  }

  function formatLevel(value) {
    if (!isFiniteNumber(value)) return "--";
    return Number(value).toFixed(2);
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function formatTimeOnly(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function setBusy(message) {
    els.connectionDot.classList.remove("ready");
    els.connectionDot.classList.add("busy");
    els.connectionDot.setAttribute("aria-label", "Data connection status: loading");
    if (message) els.statusMessage.textContent = message;
  }

  function setReady() {
    els.connectionDot.classList.remove("busy");
    const hasFailure = state.stationDataState.kind === "failed" || state.latestDataState.kind === "failed";
    els.connectionDot.classList.toggle("ready", !hasFailure);
    els.connectionDot.setAttribute("aria-label", hasFailure
      ? "Application ready; some data is unavailable"
      : "Data connection status: ready");
  }

  function showError(error) {
    console.error(error);
    els.connectionDot.classList.remove("ready", "busy");
    els.connectionDot.setAttribute("aria-label", "Data connection status: error");
    els.statusMessage.textContent = error && error.message ? error.message : "Something went wrong.";
    renderDataFreshness();
  }

  function selectedRiverStatus(river, readingCount, accessCount) {
    const parts = [];
    if (!river.stationCount) {
      parts.push("No gauge data is available.");
    } else if (!hasStationSource(river, "ea") && hasStationSource(river, "nrw")) {
      parts.push(`${readingCount} NRW snapshot readings shown across ${river.stationCount} gauges.`);
    } else if (state.latestDataState.kind === "live") {
      parts.push(`${readingCount} live readings retrieved across ${river.stationCount} gauges.`);
    } else if (state.latestDataState.kind === "cached") {
      parts.push(`${readingCount} cached readings shown across ${river.stationCount} gauges.`);
    } else if (state.latestDataState.kind === "stale") {
      parts.push(`${readingCount} stale cached readings shown; live refresh failed.`);
    } else if (state.latestDataState.kind === "failed") {
      parts.push(readingCount
        ? `${readingCount} previously loaded readings shown; live refresh failed.`
        : "Live reading refresh failed and no readings are available.");
    } else {
      parts.push(`${readingCount} readings found across ${river.stationCount} gauges.`);
    }
    if (accessCount) parts.push(`${accessCount} access points shown.`);
    return parts.join(" ");
  }

  function renderDataFreshness() {
    if (!els.dataFreshness) return;
    const parts = [];
    if (state.stationDataState.kind !== "missing") {
      parts.push(`EA stations: ${dataStateLabel(state.stationDataState)}.`);
    }
    if (state.latestDataState.kind !== "missing") {
      parts.push(`EA readings: ${dataStateLabel(state.latestDataState)}.`);
    }
    if (state.nrwFetchedAt) {
      parts.push(`NRW snapshot: ${snapshotAgeLabel(state.nrwFetchedAt)}.`);
    } else if (window.NRW_STATIONS) {
      parts.push("NRW snapshot date unavailable.");
    }
    els.dataFreshness.textContent = parts.join(" ");
  }

  function dataStateLabel(dataState) {
    const age = dataState.fetchedAt ? relativeAge(dataState.fetchedAt) : "";
    if (dataState.kind === "live") return `live${age ? `, retrieved ${age}` : ""}`;
    if (dataState.kind === "cached") return `cached${age ? `, saved ${age}` : ""}`;
    if (dataState.kind === "stale") return `stale cache${age ? ` from ${age}` : ""}; refresh failed`;
    if (dataState.kind === "failed") return `refresh failed${age ? `; previous data from ${age}` : ""}`;
    return "missing";
  }

  function snapshotAgeLabel(timestamp) {
    const ageDays = Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
    const freshness = ageDays <= 2 ? "current" : ageDays <= 7 ? "recent" : "stale";
    return `${freshness}, ${ageDays} day${ageDays === 1 ? "" : "s"} old`;
  }

  function relativeAge(timestamp) {
    const elapsed = Math.max(0, Date.now() - timestamp);
    if (elapsed < 60 * 1000) return "just now";
    if (elapsed < 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 1000))} minutes ago`;
    if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / (60 * 60 * 1000))} hours ago`;
    return `${Math.floor(elapsed / (24 * 60 * 60 * 1000))} days ago`;
  }

  function parseDateTime(value) {
    const timestamp = new Date(value || "").getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function parseLocationHash(hash) {
    const encoded = String(hash || "").replace(/^#/, "");
    if (!encoded) return "";
    try {
      return decodeURIComponent(encoded);
    } catch (error) {
      console.warn("Ignoring malformed URL hash.", error);
      return "";
    }
  }

  function safeExternalUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value), window.location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function cleanRiverName(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function riverDisplayName(value) {
    return cleanRiverName(value)
      .replace(/\briver\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function displayRiverName(river) {
    return riverDisplayName(river && (river.displayName || river.name));
  }

  function displaySelectedName(river) {
    const name = displayRiverName(river);
    return river && river.sectionName ? `${name} - ${river.sectionName}` : name;
  }

  function localisedText(value) {
    if (!value) return "";
    if (Array.isArray(value)) return localisedText(value[0]);
    if (typeof value === "string") return value;
    return value.english || value.en || value.welsh || "";
  }

  function makeKey(value) {
    return cleanRiverName(value)
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function accessMatchKey(value) {
    return cleanRiverName(value)
      .replace(/\([^)]*\)/g, " ")
      .replace(/\b(river|afon|allt|upper|lower)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function classifyRiverType(riverName) {
    const key = accessMatchKey(riverName);
    return key && getRainchasersRiverKeys().has(key) ? "whitewater" : "flatwater";
  }

  function getRainchasersRiverKeys() {
    if (state.rainchasersRiverKeys) return state.rainchasersRiverKeys;

    state.rainchasersRiverKeys = new Set(getRainchasersRiverSummaries().map(function (summary) {
      return summary.accessKey;
    }));
    return state.rainchasersRiverKeys;
  }

  function getRainchasersNameKeysByRloi() {
    const byRloi = new Map();

    asArray(window.RAINCHASERS_SECTIONS).forEach(function (section) {
      const riverName = cleanRiverName(section && (section.riverName || section.river));
      const nameKey = makeKey(riverName);
      if (!nameKey) return;

      asArray(section.measures).forEach(function (measure) {
        const dataUrl = String(measure && measure.data_url || "").toLowerCase();
        if (!/^rloi:\/\/\d+$/i.test(dataUrl)) return;

        if (!byRloi.has(dataUrl)) {
          byRloi.set(dataUrl, []);
        }
        if (!byRloi.get(dataUrl).includes(nameKey)) {
          byRloi.get(dataUrl).push(nameKey);
        }
      });
    });

    return byRloi;
  }

  function getRainchasersSectionSummaries() {
    if (state.rainchasersSectionSummaries) return state.rainchasersSectionSummaries;

    state.rainchasersSectionSummaries = asArray(window.RAINCHASERS_SECTIONS).map(function (section) {
      const riverName = cleanRiverName(section && (section.riverName || section.river));
      const sectionName = cleanRiverName(section && (section.sectionName || section.section));
      const sectionId = String(section && (section.id || section.uuid || makeKey([riverName, sectionName].join("-"))));
      const bounds = createEmptyBounds();
      const measures = normalizeRainchasersMeasures(section && section.measures);
      const measureDataUrls = [];
      const points = asArray(section && section.points).map(normalizeAccessPoint).filter(Boolean);
      const putIn = findAccessPoint(points, "put-in");

      points.forEach(function (point) {
        extendPlainBounds(bounds, point.lat, point.lng);
      });

      measures.forEach(function (measure) {
        const dataUrl = measure.dataUrl;
        if (dataUrl && !measureDataUrls.includes(dataUrl)) {
          measureDataUrls.push(dataUrl);
        }
      });

      if (!riverName || !sectionName || !Number.isFinite(bounds.north)) return null;

      return {
        sectionId,
        sectionKey: makeKey([riverName, sectionName, sectionId].join("-")),
        riverName,
        riverKey: makeKey(riverName),
        sectionName,
        grade: section.grade || "",
        km: numberOrNull(section.km),
        notes: section.notes || "",
        putIn,
        points,
        measures,
        measureDataUrls,
        bounds
      };
    }).filter(Boolean);

    return state.rainchasersSectionSummaries;
  }

  function getRainchasersRiverSummaries() {
    if (state.rainchasersRiverSummaries) return state.rainchasersRiverSummaries;

    const summaries = new Map();
    asArray(window.RAINCHASERS_SECTIONS).forEach(function (section) {
      const name = cleanRiverName(section && (section.riverName || section.river));
      const nameKey = makeKey(name);
      const accessKey = accessMatchKey(name);
      if (!name || !nameKey || !accessKey) return;

      if (!summaries.has(nameKey)) {
        summaries.set(nameKey, {
          name,
          nameKey,
          accessKey,
          sectionCount: 0,
          grades: new Set(),
          gradeSummary: "",
          bounds: createEmptyBounds()
        });
      }

      const summary = summaries.get(nameKey);
      summary.sectionCount += 1;
      if (section.grade) {
        summary.grades.add(String(section.grade));
      }
      asArray(section.points).forEach(function (point) {
        extendPlainBounds(summary.bounds, point.lat, point.lng);
      });
    });

    summaries.forEach(function (summary) {
      summary.gradeSummary = summarizeGrades(Array.from(summary.grades));
      delete summary.grades;
    });

    state.rainchasersRiverSummaries = Array.from(summaries.values());
    return state.rainchasersRiverSummaries;
  }

  function countRainchasersSummariesByAccessKey() {
    return getRainchasersRiverSummaries().reduce(function (counts, summary) {
      counts.set(summary.accessKey, (counts.get(summary.accessKey) || 0) + 1);
      return counts;
    }, new Map());
  }

  function summarizeGrades(grades) {
    const cleanGrades = grades.map(function (grade) {
      return cleanRiverName(grade);
    }).filter(Boolean);
    const numericGrades = cleanGrades.flatMap(function (grade) {
      return grade.match(/\d+(?:\.\d+)?/g) || [];
    }).map(Number).filter(isFiniteNumber);

    if (numericGrades.length) {
      const min = Math.min.apply(null, numericGrades);
      const max = Math.max.apply(null, numericGrades);
      return min === max ? formatGradeNumber(min) : `${formatGradeNumber(min)}-${formatGradeNumber(max)}`;
    }

    const unique = Array.from(new Set(cleanGrades)).slice(0, 2);
    return unique.join(", ");
  }

  function formatGradeNumber(value) {
    return Number(value).toLocaleString("en-GB", { maximumFractionDigits: 1 });
  }

  function makeUniqueRiverKey(base, riverMap) {
    const root = base || "river";
    let candidate = root;
    let suffix = 2;
    while (riverMap.has(candidate)) {
      candidate = `${root}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  function makeUniqueStationId(id, used) {
    const base = id || "station";
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  function typeName(type) {
    const value = typeof type === "string" ? type : type && (type["@id"] || type.label) || "";
    return tailFromUri(value);
  }

  function tailFromUri(value) {
    return String(value || "").split(/[\/#]/).pop();
  }

  function numberOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
  }

  function osGridToLatLng(easting, northing) {
    const E = Number(easting);
    const N = Number(northing);
    if (!isFiniteNumber(E) || !isFiniteNumber(N)) return null;

    const deg = 180 / Math.PI;
    const a = 6377563.396;
    const b = 6356256.909;
    const F0 = 0.9996012717;
    const lat0 = 49 * Math.PI / 180;
    const lon0 = -2 * Math.PI / 180;
    const N0 = -100000;
    const E0 = 400000;
    const e2 = 1 - (b * b) / (a * a);
    const n = (a - b) / (a + b);

    let lat = lat0;
    let M = 0;
    do {
      lat = (N - N0 - M) / (a * F0) + lat;
      const Ma = (1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * (lat - lat0);
      const Mb = (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
      const Mc = ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
      const Md = (35 / 24) * n * n * n * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
      M = b * F0 * (Ma - Mb + Mc - Md);
    } while (N - N0 - M >= 0.00001);

    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
    const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
    const eta2 = nu / rho - 1;
    const tanLat = Math.tan(lat);
    const tan2 = tanLat * tanLat;
    const tan4 = tan2 * tan2;
    const secLat = 1 / cosLat;
    const dE = E - E0;

    const VII = tanLat / (2 * rho * nu);
    const VIII = tanLat / (24 * rho * Math.pow(nu, 3)) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
    const IX = tanLat / (720 * rho * Math.pow(nu, 5)) * (61 + 90 * tan2 + 45 * tan4);
    const X = secLat / nu;
    const XI = secLat / (6 * Math.pow(nu, 3)) * (nu / rho + 2 * tan2);
    const XII = secLat / (120 * Math.pow(nu, 5)) * (5 + 28 * tan2 + 24 * tan4);
    const XIIA = secLat / (5040 * Math.pow(nu, 7)) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan4 * tan2);

    const latOsgb = lat - VII * dE * dE + VIII * Math.pow(dE, 4) - IX * Math.pow(dE, 6);
    const lonOsgb = lon0 + X * dE - XI * Math.pow(dE, 3) + XII * Math.pow(dE, 5) - XIIA * Math.pow(dE, 7);
    const wgs84 = osgb36ToWgs84(latOsgb, lonOsgb);

    return {
      lat: wgs84.lat * deg,
      lng: wgs84.lng * deg
    };
  }

  function osgb36ToWgs84(lat, lon) {
    const cart = latLngToCartesian(lat, lon, 6377563.396, 6356256.909);
    const tx = 446.448;
    const ty = -125.157;
    const tz = 542.06;
    const s = -20.4894 * 1e-6;
    const rx = 0.1502 * Math.PI / (180 * 3600);
    const ry = 0.2470 * Math.PI / (180 * 3600);
    const rz = 0.8421 * Math.PI / (180 * 3600);

    const x = tx + (1 + s) * cart.x - rz * cart.y + ry * cart.z;
    const y = ty + rz * cart.x + (1 + s) * cart.y - rx * cart.z;
    const z = tz - ry * cart.x + rx * cart.y + (1 + s) * cart.z;

    return cartesianToLatLng(x, y, z, 6378137, 6356752.3141);
  }

  function latLngToCartesian(lat, lon, a, b) {
    const e2 = 1 - (b * b) / (a * a);
    const sinLat = Math.sin(lat);
    const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat);

    return {
      x: nu * Math.cos(lat) * Math.cos(lon),
      y: nu * Math.cos(lat) * Math.sin(lon),
      z: (nu * (1 - e2)) * sinLat
    };
  }

  function cartesianToLatLng(x, y, z, a, b) {
    const e2 = 1 - (b * b) / (a * a);
    const p = Math.sqrt(x * x + y * y);
    let lat = Math.atan2(z, p * (1 - e2));
    let previous;

    do {
      previous = lat;
      const sinLat = Math.sin(lat);
      const nu = a / Math.sqrt(1 - e2 * sinLat * sinLat);
      lat = Math.atan2(z + e2 * nu * sinLat, p);
    } while (Math.abs(lat - previous) > 1e-12);

    return {
      lat,
      lng: Math.atan2(y, x)
    };
  }

  function createEmptyBounds() {
    return {
      north: -Infinity,
      south: Infinity,
      east: -Infinity,
      west: Infinity
    };
  }

  function normalizePlainBounds(bounds) {
    if (!bounds) return createEmptyBounds();
    return {
      north: numberOrNull(bounds.north) ?? -Infinity,
      south: numberOrNull(bounds.south) ?? Infinity,
      east: numberOrNull(bounds.east) ?? -Infinity,
      west: numberOrNull(bounds.west) ?? Infinity
    };
  }

  function clonePlainBounds(bounds) {
    return normalizePlainBounds(bounds);
  }

  function extendPlainBounds(bounds, lat, lng) {
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) return;
    bounds.north = Math.max(bounds.north, lat);
    bounds.south = Math.min(bounds.south, lat);
    bounds.east = Math.max(bounds.east, lng);
    bounds.west = Math.min(bounds.west, lng);
  }

  function extendPlainBoundsFromBounds(target, source) {
    if (!source || !Number.isFinite(source.north)) return;
    extendPlainBounds(target, source.north, source.east);
    extendPlainBounds(target, source.south, source.west);
  }

  function centerOfPlainBounds(bounds) {
    if (!Number.isFinite(bounds.north)) {
      return null;
    }
    return {
      lat: (bounds.north + bounds.south) / 2,
      lng: (bounds.east + bounds.west) / 2
    };
  }

  function expandPlainBounds(bounds, padding) {
    return {
      north: bounds.north + padding,
      south: bounds.south - padding,
      east: bounds.east + padding,
      west: bounds.west - padding
    };
  }

  function leafletBoundsFromPlain(bounds) {
    if (!Number.isFinite(bounds.north)) return null;
    return L.latLngBounds([
      [bounds.south, bounds.west],
      [bounds.north, bounds.east]
    ]);
  }

  function riverNameVariants(name) {
    const clean = cleanRiverName(name);
    const variants = new Set([clean]);

    if (/^river\s+/i.test(clean)) {
      variants.add(clean.replace(/^river\s+/i, ""));
    } else {
      variants.add(`River ${clean}`);
    }

    return Array.from(variants).filter(Boolean);
  }

  function escapeOverpassRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function truncateText(value, maxLength) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trim()}...`;
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      console.warn("Browser storage is unavailable.", error);
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      console.warn("Browser storage write failed.", error);
      return false;
    }
  }

  function safeStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (error) {
      console.warn("Browser storage removal failed.", error);
      return false;
    }
  }

  function readCache(key, maxAge, options) {
    try {
      const raw = safeStorageGet(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.createdAt) {
        safeStorageRemove(key);
        return null;
      }
      const expired = Date.now() - parsed.createdAt > maxAge;
      if (expired && !(options && options.allowExpired)) return null;
      const value = parsed.value || parsed;
      return options && options.includeMeta
        ? { value, createdAt: parsed.createdAt, expired }
        : value;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      const payload = value && value.createdAt ? value : { createdAt: Date.now(), value };
      safeStorageSet(key, JSON.stringify(payload));
    } catch (error) {
      console.warn(error);
    }
  }

  window.RIVER_APP_TEST_API = Object.freeze({
    accessMatchKey,
    buildOverpassQuery,
    distanceBetweenPointsKm,
    fetchAllItems,
    findNearestStationForSection,
    normalizeLatestReading,
    normalizeNrwStation,
    normalizeStation,
    osGridToLatLng,
    parseLocationHash,
    readCache,
    safeExternalUrl,
    safeStorageGet,
    safeStorageRemove,
    safeStorageSet,
    snapshotAgeLabel,
    writeCache
  });
})();
