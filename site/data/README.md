# Boundary data

| File | What | Source dataset | Accuracy |
|------|------|----------------|----------|
| `community-areas.min.geojson` | 77 community areas (simplified sample, committed) | [`igwz-8jzy`](https://data.cityofchicago.org/d/cauq-8yn6) | official |
| `neighborhoods.min.geojson` | 98 neighborhoods (simplified sample, committed) | [`y6yq-dbs2`](https://data.cityofchicago.org/d/bbvz-uum9) | approximate |
| `community-areas.geojson` | full-resolution (created by `fetch-data.sh` / Docker build) | `igwz-8jzy` | official |
| `neighborhoods.geojson` | full-resolution (created by `fetch-data.sh` / Docker build) | `y6yq-dbs2` | approximate |

The app loads the **full-resolution** file if present, otherwise the committed
**sample**, otherwise the **live** portal (CORS). To pull full resolution:

```bash
../../scripts/fetch-data.sh
```

**Note on accuracy:** *Community Areas* are the City of Chicago's official,
legally-defined 77 areas — stable and authoritative. *Neighborhoods* come from
Choose Chicago / the Office of Tourism; the portal states their boundaries are
"approximate and names are not official." There is no official neighborhood
boundary set for Chicago.
