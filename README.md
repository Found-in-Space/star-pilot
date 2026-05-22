# Star Pilot

PixiJS + TypeScript + Vite sketch for a SkyKit-powered learning-through-play
demo.

The first pass takes:

- starting position `(x, y, z)` in parsecs
- game normal vector for the 2D play plane
- universe slice thickness in parsecs

It streams Gaia-derived stars from the published SkyKit alpha
`@found-in-space/star-octree-provider` package with an app-owned **Pizza Strategy**:
cells are requested only when their semantic octree bounds intersect the round
slice around the ship. The loaded pizza diameter is twice the visible play
circle diameter, giving the ship room to scroll before the next slice finishes
loading. The app then projects the visible slice into 2D and renders an inertial
triangle ship with PixiJS.

This is intentionally game-like rather than physically photometric: stars inside
the slice are visible, and draw size/brightness comes from absolute magnitude
only rather than distance-based apparent magnitude.
The sidecar label resolver is wired through
`@found-in-space/meta-sidecar-provider`. Star Pilot derives the render dataset id
from the star octree descriptor, opens the matching generated `meta` sidecar, and
uses public `StarObjectRef` values for raw metadata lookups. Hover labels use an
app-local metadata formatter; automatic map labels are limited to stars with a
proper name or Flamsteed designation and are chosen by walking the brightest
loaded stars, fetching each needed sidecar cell once.
For the demo, Star Pilot also labels the origin star `(0, 0, 0)` as Sol.

## Development

```sh
cd star-pilot
npm install
npm run dev -- --host 127.0.0.1 --port 4323
```

The project consumes the published SkyKit alpha packages from npm.
