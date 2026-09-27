# Orchard × LEMON — visual direction

Orchard is the local place where people and their already-running agents share work. LEMON's synthetic orchard is a visual metaphor for that collaboration: many small Lemon Chans tending ideas inside a big computer. The scenes are **concept explorations**, not screenshots or claims about product features.

## Palette and voice

- Ink black `#090f0d` grounds the terminal setting.
- Neon citron `#e6ff68` carries primary emphasis; leaf green `#81e78a` supports it.
- Pale cream `#eef4da` keeps text readable against the dark field.
- Small ASCII motifs, command prompts, and monospace labels give the scenes a playful retro-computer rhythm. Decorative ASCII stays selectable text and is hidden from screen readers when it conveys no extra information.
- The mascot can be mischievous and busy; product copy should stay literal about Orchard's local workspace, human and agent collaboration, and provider-owned agents.

## Art set

The [brand gallery](../site/brand/index.html) presents three wide orchard backgrounds and the square app icon study. The backgrounds are `01-compiler-grove.png`, `02-harvest-loop.png`, and `03-midnight-cultivation.png` in `site/assets/lemon-orchard/`, with `app-icon.png` alongside them. These names indicate a sequence of visual studies rather than application states. The images were made with built-in image generation; the exact prompts are saved in [`prompts.json`](../site/assets/lemon-orchard/prompts.json).

## App icon

The square art has a normalized 1024 × 1024 source at `crates/orchard-desktop/icons/lemon-orchard-1024.png`. The next package build uses `scripts/build-macos-icon.sh` to make an `Orchard.icns` with the standard macOS sizes, places it in `Contents/Resources`, and sets `CFBundleIconFile` in `Info.plist`. Tauri's `bundle.icon` also points at the normalized source. The macOS menu bar mark stays a separate template icon rendered in `crates/orchard-desktop/src/main.rs` so it remains legible in light and dark menu bars.

This source change does not alter an already published app. The Finder icon will arrive in a future version after packaging, signing, notarization, and an installed-app visual check. The current gallery presents the art direction in the meantime.
