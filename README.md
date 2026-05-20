# Star Pilot

PixiJS + TypeScript + Vite sketch for a SkyKit-powered learning-through-play
demo.

The first pass takes:

- starting position `(x, y, z)` in parsecs
- game normal vector for the 2D play plane
- universe slice thickness in parsecs

It streams Gaia-derived stars from the local SkyKit alpha
`@found-in-space/star-octree-provider` with an app-owned **Pizza Strategy**:
cells are requested only when their semantic octree bounds intersect the round
slice around the ship. The loaded pizza diameter is twice the visible play
circle diameter, giving the ship room to scroll before the next slice finishes
loading. The app then projects the visible slice into 2D and renders an inertial
triangle ship with PixiJS.

This is intentionally game-like rather than physically photometric: stars inside
the slice are visible, and draw size/brightness comes from absolute magnitude
only rather than distance-based apparent magnitude.
The sidecar label resolver is already wired through
`@found-in-space/meta-sidecar-provider`; it currently uses an empty in-memory
entry set until generated meta sidecar cells are exposed through the alpha
package boundary.

## Development

```sh
cd star-pilot
npm install
npm run dev -- --host 127.0.0.1 --port 4323
```

The project uses `file:` dependencies for the sibling SkyKit alpha packages so
changes in `../skykit/packages/*` can be tested locally.
