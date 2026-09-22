# Kyiv / Kyiv Oblast data pipeline

Create scripts that can:
1. obtain a current Ukraine OSM PBF from a legitimate OSM data provider;
2. clip the Kyiv/oblast bounding polygon;
3. build vector-map assets;
4. build Valhalla routing tiles;
5. build local POI and address indexes;
6. generate checksums and metadata;
7. package the result for the mobile app.

Do not commit large generated map binaries to git.
The app should import a signed/versioned package.
Respect the license/attribution and usage policies of each data provider.
