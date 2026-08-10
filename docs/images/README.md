# Media checklist

Drop the files here with these exact names and the README picks them up. Shoot on a
dark GNOME theme unless a light twin is noted. Keep GIFs under ~4 MB.

| File | Type | Priority | What to capture |
|------|------|----------|-----------------|
| `logo-dark.svg` / `logo-light.svg` | SVG | **done** | The Kubernetes helm, black for the light theme and white for dark. Recolored from `icons/kubernetes-symbolic.svg`; vector, so no PNG needed. |
| `demo.mp4` + `hero.png` | video (5 MB) + still | **done** | Full ~28s walkthrough (open menu → meters → click-to-copy → context switcher → prefs) + a poster still, both from the recording. On publish, embed demo.mp4 as an inline `<video>` (see README comment). |
| `prefs.png` | PNG | **done** | Pulled from the walkthrough: Connection group, context = demo-cluster, kubectl/kubeconfig paths, Test button. |
| `panel-states.png` | PNG, ~600px | **must** | Tight crop of just the panel icon in green / amber / red, composited into one strip. |
| `notification.png` | PNG, ~560px | **must** | Screenshot of the "worker-2 is down" desktop notification, ideally with the panel's red dot in frame. Trigger: `docker stop k3d-demo-agent-1`. |

Tips: for GIFs, `peek` or `wf-recorder` + `gifski` give clean output. Crop tight, the
panel and popup are small. Blur or use fake node names if your real cluster names are
sensitive.
