# Xavi Launcher research and verification

This document separates what is covered by automated tests from what still needs a real-world check.

## Design notes

- Versions come from Mojang's manifest (cached on disk so the launcher opens offline). Libraries are filtered with Mojang's rule semantics (ordered, last match wins, OS + architecture). Legacy native classifier jars are downloaded and extracted so old versions run offline too.
- The required Java major version comes from the version manifest (`javaVersion.majorVersion`). Java 8 games only run on Java 8; newer games accept the smallest sufficient JVM; otherwise the Mojang runtime is downloaded.
- Fabric: loader metadata and generated profile JSON from Fabric Meta; Fabric's own libraries are pre-downloaded. Forge/NeoForge: the official installer (verified against the Maven `.sha1`) is run against the game directory and its profile merged with the vanilla manifest. NeoForge builds are matched on the exact `<minor>.<patch>.` prefix.
- Modrinth: the renderer sends only a version id; the file URL and hashes always come from Modrinth, downloads must come from `cdn.modrinth.com`, and the hash is verified before anything is written. Updates download and verify first, then replace the old file.
- Authentication: Microsoft device-code flow (POST), refresh tokens, Xbox Live/XSTS error mapping, Minecraft profile ownership check (404 means no Java Edition), tokens sealed with `safeStorage`.
- Electron: sandboxed renderer, bundled CommonJS preload (only `electron` is required), validated IPC with sender check, navigation denied, production-only CSP, packaged builds ignore `VITE_DEV_SERVER_URL`.

## Sources

[Mojang version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json) · [Java runtime index](https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json) · [Fabric Meta](https://meta.fabricmc.net/) · [Forge files](https://files.minecraftforge.net/net/minecraftforge/forge/) · [NeoForge docs](https://docs.neoforged.net/user/docs/) · [Modrinth API](https://docs.modrinth.com/api/) · [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) · [minecraft-launcher-core](https://github.com/Pierce08/minecraft-launcher-core) · [Mojang API](https://minecraft.wiki/w/Mojang_API)

## Status

| Area | Status | Evidence |
| --- | --- | --- |
| Library rules, natives, version/Java/loader selection | Unit-tested | `test/logic.test.ts` |
| Mod import/toggle/remove (names with spaces and brackets), zip and modpack safety | Integration-tested | `test/main.test.ts` |
| Corrupt-file handling, encrypted tokens, world backup on delete, directory approval, IPC validation | Integration-tested | `test/main.test.ts` |
| Vanilla / Fabric / Forge / NeoForge install and launch | **Needs a real run** | Code changed substantially (Java selection, natives, installer checksum). Run `npm run smoke` per loader before releasing; earlier 0.2.0 runs do not cover this code. |
| Offline launch of an installed profile | **Needs a real run** | Manifest cache and pre-downloaded libraries are implemented; verify with the network disabled. |
| Microsoft sign-in, refresh, skin upload | **Needs a real run** | Needs an Entra app approved by Mojang. Device-code request is now a POST (it was a GET before). |
| Modrinth search/install/update/dependencies | **Needs a real run** | Hash and host checks are unit-tested; the live API flow is not. |
| `.mrpack` import | Partial | Safety rules tested; downloads not run live. Third-party formats (CurseForge) are not supported. |
| Offline skins (CustomSkinLoader sync, PNG validation, config safety), Fabric API auto-install, modpack-to-profile, server pairing | Unit/integration-tested | `test/main.test.ts`; the mod's real config keys and the Modrinth slug `customskinloader` were not verified against the live service, so test one profile first. |
| Crash fallback (disable mods, vanilla fallback) | Implemented | UI flow not run end-to-end here. |
| Shared assets/libraries between profiles | Not implemented | Each profile still has its own copy (~1 GB). |
| Installer signing / auto-update | Not implemented | `signAndEditExecutable` stays off to avoid Windows symlink-privilege build failures. |

## Verification commands

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```
