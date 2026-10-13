# Partwright

Partwright is a parametric 3D part modeller for the desktop. You draw 2D sketches on planes or flat faces, turn them into solids with features, and change any step later. Every feature after it rebuilds automatically.

It runs as a normal Windows program (installer or portable `.exe`), and also on macOS and Linux. Geometry is computed by the OpenCASCADE kernel compiled to WebAssembly, so parts are true B-rep solids: they export to STEP for other CAD systems and to STL for 3D printing.

## Download

Every push builds the apps with GitHub Actions. Open the repository's **Actions** tab, pick the latest green **Build** run and download the artifact:

| Artifact | Contains |
|---|---|
| `Partwright-Windows` | `Partwright-<version>-setup.exe` (installer) and `Partwright-<version>-portable.exe` (no install) |
| `Partwright-macOS` | `.dmg` |
| `Partwright-Linux` | `.AppImage` |

Pushing a tag such as `v0.1.0` also publishes these files on the **Releases** page.

## What it can do

- **Sketches** on the Top, Front and Right planes, on offset planes, or on any flat face of a part. The sketch tools are line, corner and centre rectangle, circle, 3-point arc, point and construction geometry.
  - Snapping to end points, midpoints, centres and the origin, with horizontal and vertical inference.
  - Type exact sizes while drawing: `40` for a length or radius, `60,40` for a rectangle.
  - Closed regions, including holes and nested shapes, are detected and shaded automatically.
- **Features** recorded in a feature list:
  - Extrude: blind or symmetric, new / add / remove / intersect.
  - Revolve around a sketch axis or line.
  - Fillet and chamfer edges.
  - Shell: remove faces and hollow the part.
  - Offset plane.
  - Linear and circular pattern.
  - Mirror.
  - STEP / STL import.
- **Editing the history:**
  - Double-click any feature to change it, with a live preview.
  - Rename, suppress or delete features; undo and redo.
  - Fillets, chamfers and shells keep hold of their edges and faces when earlier features change size.
- **Multiple parts** with names, colours, hide / isolate, and per-part export.
- **Viewing:**
  - Orbit, pan and zoom with the mouse; view cube and named views; view normal to a face.
  - Shaded, shaded with edges, translucent and wireframe display.
  - Section view with capped cut faces.
- **Measuring:** click faces and edges to see area, length, volume and the distance between them.
- **Files:**
  - `.pwd` part studio documents keep the full feature history.
  - STEP and STL export; PNG screenshots.

## Mouse and keys

| Action | Input |
|---|---|
| Rotate / pan / zoom | Right drag / middle drag or Ctrl + right drag / wheel |
| Select, add to selection | Click, Shift + click |
| Sketch, Extrude, Revolve, Fillet, Chamfer, Shell, Plane | Shift + S, E, W, F, C, L, P |
| Sketch tools | L line, R rectangle, Shift+R centre rectangle, C circle, A arc, P point, Q construction |
| Finish sketch | Ctrl + Enter |
| Accept / cancel a feature | Enter / Esc |
| Views | Shift + 1…7 (front, back, left, right, top, bottom, isometric), F fit, N normal to |
| Undo / redo / save / open / new | Ctrl + Z / Y / S / O / N |

Press **F1** in the app for the full list.

## Building from source

Requires Node.js 22.

```bash
npm ci
npm start            # bundle and run the desktop app
npm test             # modelling kernel tests (real OpenCASCADE)
npm run test:e2e     # drives the real app: sketch, extrude, fillet, edit, export
npm run dist         # build installers for the current OS into dist/
```

Source layout:
- `src/kernel/`: sketch region detection, feature evaluation and tessellation. It runs in a Web Worker.
- `src/ui/`: the viewport, sketcher, feature dialogs and feature tree.
- `main.js` and `preload.js`: the Electron desktop shell.

## Licence

MIT. See `LICENSE`, which also lists the bundled third-party components. That includes OpenCASCADE, which is under the LGPL v2.1 and ships as a separate, replaceable WebAssembly file.
