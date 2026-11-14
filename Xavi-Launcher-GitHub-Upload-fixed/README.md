# Xavi Launcher

Xavi is an ad-free desktop launcher for Minecraft Java Edition on Windows and macOS, built with Electron, React, and TypeScript.

## Run in Visual Studio Code

1. Install Node.js 22 LTS. Xavi detects Java or downloads the Mojang runtime that the selected Minecraft version needs.
2. Open this folder in VS Code and run `npm install`.
3. Copy `.env.example` to `.env` and add a Microsoft Entra public-client app ID (optional, only for online play). Enable **Allow public client flows**.
4. `npm run dev` (on Windows PowerShell use `npm.cmd run dev` if scripts are blocked). The main process is compiled once at start; restart `dev` after changing files in `src/main`.

Other scripts: `npm run typecheck`, `npm test`, `npm run build:win` (NSIS installer), `npm run build:mac` (DMG), `npm run smoke` (developer-only install/launch check: `XAVI_SMOKE_LOADER`, `XAVI_SMOKE_VERSION`, `XAVI_SMOKE_LAUNCH=1`).

For MacBook users, run `npm run build:mac` on macOS to create the DMG. The launcher supports both Intel Macs and Apple Silicon Macs. It detects an installed Java runtime automatically and downloads the matching Mojang runtime when needed.

If you do not own a Mac, upload this project to GitHub, open the **Actions** tab, choose **Build macOS installer**, and click **Run workflow**. GitHub will build a universal DMG on a Mac runner. Download the `xavi-launcher-macos` artifact, then upload the `.dmg` inside it to MediaFire.

## Using it

- **Settings → New installation**: pick a version (releases by default; tick "Show snapshots and old versions" for the rest) and a loader (Vanilla, Fabric, Forge, NeoForge). Installing downloads the game, libraries, assets and the right Java runtime in one step.
- **Mods**: search Modrinth, install with required dependencies, enable/disable/remove, update, or import `.jar`, `.zip` and `.mrpack`. Vanilla profiles can't use mods.
- **Memory mode** in Settings: *Auto* picks values for your PC; choose *Custom* to use your own minimum/maximum RAM.
- **Delete profile** copies your worlds to `%APPDATA%\XaviLauncher\backups` before removing the game folder.
- Fabric profiles get **Fabric API** installed automatically.
- **Import modpack** (Play screen) reads a `.mrpack`, creates a profile with the right Minecraft version and loader, installs it, and imports the pack in one step.
- **Crash recovery**: when Minecraft closes unexpectedly, Xavi shows the likely cause and offers *Disable all mods*, *Install vanilla fallback* and *View log*.
- **Servers** can be paired with a profile, so *Launch* opens the right version and mods.
- **Add player** (Servers): starts another copy of the game with a different local name and joins the same server, handy for testing your own server or LAN with two players. Offline names can only join servers on this PC or your home network; public servers need a Microsoft account that owns the game.
- Once a profile is installed it launches without a network connection.

## Skins

- **Microsoft account:** upload a PNG in **Skins**; it becomes your official skin and every player sees it.
- **Without Microsoft login:** choose a 64×64 PNG once in **Skins** and install the skin mod (CustomSkinLoader) for a Fabric/Forge/NeoForge profile. Xavi copies the skin in and writes the mod config on each launch (a config you edited by hand is never overwritten). Add a shared address such as `https://raw.githubusercontent.com/you/skins/main/{USERNAME}.png` so friends who use the same mod see each other.
- **Limit:** players on plain Minecraft cannot see these skins, because only Mojang can sign skins for online play. For them, the server needs a skin plugin such as SkinsRestorer. Xavi has no skin server and does not spoof Mojang authentication.

## Accounts

- **Local profile**: a name plus a stable UUID stored in `%APPDATA%/XaviLauncher/local-profile.json`. Changing the name keeps the UUID. Names are normalized to Minecraft's 16-character format. This is for offline single-player only.
- **Microsoft account** (optional): device-code sign-in, then Xbox Live and Minecraft Services. Xavi refreshes the session automatically and stores tokens encrypted with Electron `safeStorage` (Windows DPAPI, macOS Keychain). The renderer never receives tokens.
- Online servers require an authenticated account that owns Minecraft: Java Edition. Xavi does not bypass authentication or ownership checks, and offline names cannot have signed skins.

> **Important:** new Microsoft Entra app registrations must be approved by Mojang before `login_with_xbox` accepts them. Until approved, sign-in fails with a 403 "Invalid app registration" error, which Xavi reports as such. See Mojang's launcher-authentication documentation for the approval form.

## Security model

The renderer is sandboxed and only talks to the main process through a validated IPC bridge. It names profiles by id; directories, install state and tokens come from the main process. File and directory choices go through native dialogs. Downloads are checksum-verified (Mojang assets/libraries, Forge/NeoForge installers via their `.sha1`, Modrinth mods and modpack files). `.mrpack` downloads are limited to Modrinth, GitHub and GitLab hosts, and archives are size-limited. Extra JVM arguments that can load code (`-javaagent`, `-cp`, …) are rejected.

See [RESEARCH.md](./RESEARCH.md) for design notes, the verification matrix and known limitations.
