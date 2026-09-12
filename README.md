# England River Levels Map

Static prototype for selecting rivers, highlighting their river line on an OpenStreetMap background, and showing Rainchasers put-in/get-out points with Environment Agency and local Natural Resources Wales gauge snapshots where available.

No Google Maps key is required.

## Run

You can open `index.html` directly, but a local HTTP preview is usually more reliable for browser API calls:

```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1 -Port 5173
```

Then open:

```text
http://localhost:5173/
```

## Map

- Background map: selectable tile layers displayed with Leaflet. Esri Street is the default because it tends to be more reliable on restricted networks.
- River line highlight: OpenStreetMap river geometry fetched through the Overpass API. If no exact river geometry is found, the app shows gauges only instead of drawing an artificial line.

The tile layer list lives in `config.js`. If one provider is patchy on your network, use the Map menu to switch to another.

## River Data

- River gauges and latest water levels: Environment Agency real-time flood monitoring API.
- Welsh river gauges in the White water tab: local snapshot from Natural Resources Wales' public river-level site station feed.
- The river menu is built from active EA level stations that have a `riverName`.
- The menu is split into White water and Flat water tabs. White water contains every Rainchasers paddle section from the local data copy, including sections outside England. Flat water contains the remaining Environment Agency rivers.
- White water menu cards show the river name, section name, section notes, distance, and grade from the Rainchasers section file.
- Put-in and get-out markers: local generated data from the cloned `robtuley/rainchasers` `rivers/*.yaml` files. Rainchasers is MIT licensed.

## Local Rainchasers Copy

- Source submodule: `data/rainchasers-source`
- Generated browser data: `data/rainchasers-sections.js`

After a fresh clone, initialise the pinned Rainchasers source and rebuild the browser data:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Initialize-ProjectData.ps1
```

To rebuild after updating the submodule:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Build-RainchasersData.ps1
```

To refresh the local NRW gauge snapshot:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Refresh-NrwData.ps1
```

Pass `-RefreshNrw` to `Initialize-ProjectData.ps1` to perform both operations. Generated browser assets are committed so the website can run without PowerShell or Git submodule support.

The interface reports whether Environment Agency data is live, cached, stale, unavailable, or failed to refresh. It also shows the age of the bundled NRW snapshot.

## Tests

The automated suite runs in headless Microsoft Edge without installing packages:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
```

It covers generated-data consistency, EA/NRW normalisation, coordinate conversion, gauge matching, pagination and API errors, cache expiry, URL hashes, and external URL validation.

## Notes

- Some river names are shared by different watercourses, so a production version should add disambiguation by catchment or stored river IDs.
- The river line overlay depends on matching EA river names to OpenStreetMap names, so a few rivers may show gauges without a line.
- Rainchasers includes paddle sections beyond England. Those sections appear individually in the White water tab and selecting one shows only that section's put-in/get-out markers. Welsh sections show linked NRW gauges when the local NRW snapshot matches the section's Rainchasers `rloi://` gauge IDs.
- For heavier public use, avoid relying directly on free tile and Overpass endpoints from every visitor. Add caching or use a hosted tile/API plan.
