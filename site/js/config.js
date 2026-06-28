/* chilocal configuration
 * ----------------------------------------------------------------------------
 * Everything that's likely to change lives here. To add a new boundary layer
 * later (wards, police districts, zip codes, your own data), just add an entry
 * to LAYERS and drop a GeoJSON file in /data — the UI builds itself from this.
 */

window.CHILOCAL_CONFIG = {
  app: {
    name: "chilocal",
    tagline: "Chicago, mapped",
    center: [41.8585, -87.6800], // Chicago
    zoom: 11,
    minZoom: 9,
    maxZoom: 18,
    defaultBasemap: "light",
  },

  // Keyless basemaps (no API token needed — good for self-hosting).
  basemaps: [
    {
      id: "light", label: "Light", default: true,
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: "abcd", maxZoom: 20,
    },
    {
      id: "streets", label: "Streets",
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: "abcd", maxZoom: 20,
    },
    {
      id: "dark", label: "Dark",
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution: '&copy; OpenStreetMap, &copy; CARTO', subdomains: "abcd", maxZoom: 20,
    },
    {
      id: "satellite", label: "Satellite",
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics", maxZoom: 19,
    },
  ],

  /* Boundary layers.
   * file   = preferred full-resolution data (created by scripts/fetch-data.sh
   *          or the Docker build — see README). May be absent on first run.
   * sample = lightweight simplified copy committed to the repo so the map works
   *          immediately, even offline.
   * live   = last-resort fallback fetched straight from the Chicago Data Portal
   *          (CORS-enabled). Used only if the local files are missing.
   * nameField / idField are the property keys in the raw portal data; the local
   * files are pre-normalized to also include `name` and `id`.
   */
  layers: [
    {
      id: "community-areas",
      title: "Community Areas",
      subtitle: "77 official areas",
      color: "#41b6e6",
      defaultOn: true,
      file: "data/community-areas.geojson",
      sample: "data/community-areas.min.geojson",
      live: "https://data.cityofchicago.org/resource/igwz-8jzy.geojson?$limit=100",
      nameField: "community",
      idField: "area_numbe",
      accuracy: "official",
      source: "City of Chicago",
      sourceUrl: "https://data.cityofchicago.org/d/cauq-8yn6",
    },
    {
      id: "neighborhoods",
      title: "Neighborhoods",
      subtitle: "98 informal areas",
      color: "#f2784b",
      defaultOn: false,
      file: "data/neighborhoods.geojson",
      sample: "data/neighborhoods.min.geojson",
      live: "https://data.cityofchicago.org/resource/y6yq-dbs2.geojson?$limit=200",
      nameField: "pri_neigh",
      idField: "pri_neigh",
      accuracy: "approximate",
      source: "Choose Chicago / Office of Tourism",
      sourceUrl: "https://data.cityofchicago.org/d/bbvz-uum9",
    },
  ],

  /* Choropleth metrics. `prop` reads a numeric property already on the feature.
   * Add custom metrics at runtime with ChiLocal.setData() (see README). */
  metrics: [
    { id: "none", label: "None (outline only)" },
    { id: "area_sqmi", label: "Area (sq mi)", prop: "area_sqmi", unit: "sq mi" },
  ],
};
