# Media checklist

Drop the files here with these exact names and the README picks them up. Shoot on a
**dark** GNOME theme unless a light twin is noted. Keep GIFs under ~4 MB.

| File | Type | Priority | What to capture |
|------|------|----------|-----------------|
| `logo-dark.svg` / `logo-light.svg` | SVG | **done** | The Kubernetes helm, black for the light theme and white for dark. Recolored from `icons/kubernetes-symbolic.svg`; vector, so no PNG needed. |
| `hero.png` | PNG (or GIF), ~1400px | **must** | Panel top-right with the menu open: the context header + "updated now", the pods line, 2–3 nodes with CPU/MEM bars, and one node red (down). Real wallpaper behind it. This is the one shot that carries the README. |
| `panel-states.png` | PNG, ~600px | **must** | Tight crop of just the panel icon in green / amber / red, composited into one strip. |
| `notification.gif` | GIF, few sec | **must** | A node flipping to NotReady: dot goes red + the GNOME notification slides in. Use a throwaway cluster (kind/minikube), never a real one. |
| `prefs.png` | PNG, ~700px | recommended | Preferences window: Connection group with green checks on kubectl/kubeconfig, context dropdown open, ideally the Test "Connected" toast. |

Tips: for GIFs, `peek` or `wf-recorder` + `gifski` give clean output. Crop tight, the
panel and popup are small. Blur or use fake node names if your real cluster names are
sensitive.
