# Changes in 0.6.0

Added "Add player" (Servers): starts a second copy of the profile with another local name that joins the same server, with its own game folder (mods/config shared) and log. Offline names, including this feature, can only join servers on this PC or home network; public servers need a Microsoft account that owns the game. Servers are joined with --quickPlayMultiplayer on 1.20+ and the 26.x versions.

# Changes in 0.5.0

Added "Find a working setup" (Settings) and "Fix automatically" (crash panel): Xavi launches the profile with a short list of safe Java option sets (default, class-data sharing off, Java 24+ memory flags, 2 GB heap, C1 only, interpreter only), keeps the first that stays alive for 30 s, and saves it to Settings. Removed the hardcoded 26.3 JIT workaround; it is now one of the options tested.

# Changes in 0.4.4

After a native crash Xavi asks the Windows Application event log which module crashed java/javaw (the same data as Event Viewer) and writes a "Crash analysis" line into the game log and the crash panel.

# Changes in 0.4.3

Game now starts with javaw.exe like the official launcher (minecraft-launcher-core's Java check is bypassed for javaw only). The JVM crash report is always written into the game folder (-XX:ErrorFile), and the 0xC0000005 message explains how to find the faulting module in Windows Event Viewer.

# Changes in 0.4.2

Libraries whose Mojang rules do not match this PC are removed before launch. Correction: the `natives-windows-arm64` jars are still on the classpath afterwards because Mojang's own manifest allows them on Windows, so they are NOT the cause of the 26.3 crash (an earlier note here said otherwise). Fixed: the old non-standard offline UUID is migrated to the standard MD5 offline UUID, so saves and offline servers match other launchers.

# Changes in 0.4.1

Crash reports now read the JVM hs_err log and name the failing module (AMD/NVIDIA/Intel driver, Java, LWJGL), explain Windows exit code 0xC0000005, and show hs_err logs in diagnostics. The crash hint no longer blames the graphics driver for every log that mentions OpenGL.

# Changes in 0.4.0 (on top of 0.3.0)

Added: Skins screen (offline skins via CustomSkinLoader, shared friends source, Microsoft skin upload), Fabric API auto-install, one-click modpack to profile, crash recovery panel (disable all mods, vanilla fallback, log), server-to-profile pairing, Forge "no build" message with newest supported versions.

# Changes in 0.3.0

Fixed: Java chosen from the version manifest (auto-download); NeoForge/Forge version matching; Mojang rule evaluation, legacy natives, logging config; mod names with spaces/brackets; safe Modrinth updates with hash checks and dependency install; offline start (cached manifest, allSettled); Microsoft login (POST device code, refresh, slow_down, XSTS errors, ownership); memory settings that actually apply (memory mode selector); delete profile removes game folder with world backup; crash hints.

Security: validated IPC with sender check, profile referenced by id only, tokens encrypted and never sent to the renderer, sandboxed renderer + bundled preload, dialog-approved directories, JVM-arg filter, host allowlist + hash and size limits for mods/modpacks/installers, production-only CSP.

Reliability: atomic JSON writes, corrupt files kept aside and reported, log truncation + queue, per-profile locks, destroyed-window guards, minimise instead of quit on launch.

Renderer: no DOM injection, no stale closures, unsubscribing listeners, version filter + snapshots toggle.

Build: pinned dependencies, split tsconfigs, esbuild preload bundle, vitest (59 tests), CI workflow, smoke test moved to dev-only module.

Not done: shared assets/libraries between profiles, installer signing/auto-update, app icon, log export/profile duplication UI. Install/launch/login flows must be run against the real services (see RESEARCH.md).
