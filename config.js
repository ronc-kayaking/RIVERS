window.RIVER_APP_CONFIG = {
  defaultCenter: { lat: 52.8, lng: -1.6 },
  defaultZoom: 6,
  defaultTileLayer: "esri-street",
  accessSectionsGlobal: "RAINCHASERS_SECTIONS",
  accessSectionsSourceName: "Rainchasers",
  accessSectionsSourceUrl: "https://github.com/robtuley/rainchasers",
  accessSectionsLicense: "MIT",
  tileLayers: [
    {
      id: "osm-hot",
      label: "OpenStreetMap Humanitarian",
      url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles style by HOT'
    },
    {
      id: "osm-standard",
      label: "OpenStreetMap Standard",
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    },
    {
      id: "carto-light",
      label: "CARTO Light",
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    {
      id: "esri-street",
      label: "Esri Street",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
      attribution: "Tiles &copy; Esri"
    }
  ]
};
