# InsertPress Planner

A slicer-style planner for a heat-set insert press. Load an STL, place it on
the bed, pick the holes, preview the job, and download GRBL 1.1 G-code. Runs
entirely in the browser: no install, no build step, no server.

![Screenshot](docs/screenshot.png)
<!-- Add a screenshot: load the example block, set 3 x 2 copies, save as docs/screenshot.png -->

## Try it

- **Locally:** open `index.html` in Chrome, Firefox, or Edge.
- **GitHub Pages:** push this repo, then Settings → Pages → Deploy from branch →
  `main` / root. The app will be at `https://<you>.github.io/<repo>/`.

Click **Try the example block** to see it work without your own part. The 3D
view loads Three.js from jsDelivr; without a connection the app switches to a
2D top view and everything else still works.

## What it does

**1. Part.** Open or drop an STL. You get its size, volume, and surface area.
Turn it on X or Y until the insert holes face up. Position it on the bed by
typing X, Y, and an angle, with the Move tool (drag the part), or with
**Into fence corner** and **Center on bed**. **Copies** lays out a grid of the
same part so one job presses a whole batch, and tells you if the array runs
past your travel.

**2. Holes.** Insert-sized holes that open upward are found automatically.
Click rings in the view, rows in the list, or a size chip (⌀4.0 × 7) to add
them to the press order. Drag the number tags to reorder or press
**Shortest path**. Click a row to open its inspector: measured diameter versus
what the insert wants, knurl OD, depth versus insert length, wall thickness,
bed coordinates, and press depth. Use the Place tool to add holes the finder
missed.

**3. Machine.** Pick a plastic (PLA, PETG, ABS, ASA, Nylon, PC) to fill in a
starting iron temperature, press speed, and hold time. Every feed, height,
and travel limit is editable. Save setups as named **machine profiles**, such
as one for the Z-only press head and one for the full gantry.

**4. Preview.** Job time with a breakdown (travel, Z moves, pressing,
holding, lifting, loading), inserts per part, X/Y travel distance, a parts list
with cost, and warnings. Press play to watch the iron work through the job;
the G-code line it's on is highlighted. Download the G-code, or a **1:1
placement template** (SVG) that shows where each part sits on the bed.

Everything is undoable. **Save job** writes a `.ipjob.json` with the placement,
copies, picks, and settings; **Open job**, then the same STL, picks up where
you left off.

## Keyboard

| Key | Action |
|---|---|
| V / M / H | Select, Move, Place tool |
| Arrows | Nudge the part 1 mm (Shift: 10 mm) with Move |
| Shift while dragging | 0.1 mm steps instead of 0.5 mm |
| Space | Play or pause the preview |
| F | Fit the view |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo |
| Delete | Take the selected hole out of the press order |
| Esc | Back to Select |

## Machine setup this G-code assumes

| What | Convention |
|---|---|
| X0 Y0 | Inside corner of the fence |
| Z0 | Tip touching the bed with the spring float relaxed (paper test) |
| Units / mode | `G21 G90`, work coordinates `G54` |
| Float sensor | Wired to the GRBL probe pin (A5) |

Set the origin once per session: jog the tip into the fence corner and run
`G10 L20 P1 X0 Y0`, then touch off on the bed and run `G10 L20 P1 Z0`.

Each hole runs this sequence:

```
G0 X.. Y..             travel at clear height
(MSG,...) M0           pause: place the insert, then Cycle Start
G0 Z(H + L + gap)      drop to just above the insert
G38.3 Z(H - sink) F..  press; halts early if the float sensor trips
G4 P..                 hold at depth while the plastic sets
G1 Z.. F..             slow lift off the insert
G0 Z(clear)            back to travel height
```

`H` is the surface height at the hole, `L` the insert length, and clear height
is part top + longest insert + clearance. With copies, holes are numbered
through the whole batch and pressed copy by copy, row by row.

**Z only mode** is for the press head before the gantry exists: no X/Y moves;
the job pauses at each hole with its coordinates so you slide the part under
the tip.

**Placing parts:** with one part, push it into the fence corner (X 0, Y 0).
For anything else, print the placement template at 100%, check the 50 mm
scale bar, put the sheet's corner in the fence corner, and set each part on
its outline.

**First run:** do an air pass with the iron cold and Z0 set 20 mm above the
bed, then one test hole, before running a real part.

## How hole finding works

STL files are only triangles, so holes are found geometrically: near-vertical
triangles are grouped into connected wall patches, each patch gets a circle
fit, and a patch counts as a hole when it is round, wraps most of the way
around, and its normals face the axis (a round boss faces outward and is
skipped). If material covers the hole's center above its top, it opens
downward and is skipped. Wall thickness is the distance to the nearest other
vertical wall over the hole's height, minus its radius.

Limits: holes must be vertical in the chosen orientation; very low-poly
exports (under about 8 segments per circle) or holes cut by other features
may be missed. Place those by hand. The template uses each part's convex
outline.

## Project layout

```
index.html          page shell
css/style.css       styles
js/stl.js           STL parsing, orientation, dropping the part onto the bed
js/holes.js         hole detection and wall thickness
js/placement.js     position, rotation, copies, footprint, volume
js/gcode.js         inserts, materials, defaults, checks, G-code, motion timeline
js/viewer.js        Three.js view: copies, picking, move tool, tip, X-ray
js/viewer2d.js      2D top view with the same interface
js/app.js           UI state, history, profiles, preview, template, wiring
js/example.js       built-in example block
examples/           example-block.stl
test/run-tests.js   Node tests for the core logic
tools/              example STL generator
```

## Tests

```
node test/run-tests.js
```

No dependencies. Covers STL parsing, hole detection and wall thickness in
several orientations, placement and copies, insert guessing, G-code output,
the preview timeline, and path ordering.

## Roadmap

- Per-hole surface touch-off for warped parts
- Iron tip collision check against tall features near a hole
- Feeder support: pick-up moves instead of load pauses
- Stream G-code to GRBL from the browser (Web Serial)
- STEP/3MF import

## License

MIT
