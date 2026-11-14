import { describe, expect, it } from 'vitest';
import { chooseJava, classifyCrash, compareVersions, coordinatePath, evaluateRules, fallbackJavaMajor, hashesMatch, inside, isAllowedModpackUrl, isModrinthCdn, isPlainFileName, javaComponentFor, joinInside, nativeClassifier, normalizeLocalName, offlineUuid, parseJvmArgs, parseServerAddress, pickForgeVersion, pickNeoForgeVersion, safeFileName, safeRelative } from '../src/main/logic';

const win = { os: 'windows', arch: 'x64' } as const;

describe('evaluateRules', () => {
  it('allows libraries without rules', () => expect(evaluateRules(undefined, win)).toBe(true));
  it('last matching rule wins: allow, then disallow windows', () => expect(evaluateRules([{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], win)).toBe(false));
  it('allow + disallow for another OS stays allowed', () => expect(evaluateRules([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], win)).toBe(true));
  it('os-only allow rule excludes other systems', () => expect(evaluateRules([{ action: 'allow', os: { name: 'osx' } }], win)).toBe(false));
  it('x86 arch rule does not match x64', () => expect(evaluateRules([{ action: 'allow', os: { name: 'windows', arch: 'x86' } }], win)).toBe(false));
  it('ignores feature rules', () => expect(evaluateRules([{ action: 'allow', features: { is_demo_user: true } }], win)).toBe(false));
});

describe('natives and coordinates', () => {
  it('resolves the arch placeholder', () => expect(nativeClassifier({ windows: 'natives-windows-${arch}' }, win)).toBe('natives-windows-64'));
  it('builds a Maven path with classifier', () => expect(coordinatePath('org.lwjgl:lwjgl:3.3.3:natives-windows')).toBe('org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar'));
});

describe('loader version selection', () => {
  const neo = ['20.4.237', '21.0.167', '21.1.1', '21.1.95', '21.1.265', '21.1.300-beta', '21.10.5', '21.11.1', '21.4.100'];
  it('1.21.1 never picks 21.10/21.11/21.4', () => expect(pickNeoForgeVersion(neo, '1.21.1')).toBe('21.1.265'));
  it('1.21 maps to 21.0', () => expect(pickNeoForgeVersion(neo, '1.21')).toBe('21.0.167'));
  it('1.21.4 maps to 21.4', () => expect(pickNeoForgeVersion(neo, '1.21.4')).toBe('21.4.100'));
  it('returns undefined when there is no build', () => expect(pickNeoForgeVersion(neo, '1.19.2')).toBeUndefined());
  it('falls back to a beta when nothing stable exists', () => expect(pickNeoForgeVersion(['21.5.1-beta', '21.5.2-beta'], '1.21.5')).toBe('21.5.2-beta'));
  it('compares numerically', () => expect(compareVersions('21.1.9', '21.1.10')).toBeLessThan(0));
  it('picks the highest Forge build numerically', () => expect(pickForgeVersion(['1.21.1-52.0.9', '1.21.1-52.1.21', '1.21.1-52.1.3'])).toBe('1.21.1-52.1.21'));
});

describe('java selection', () => {
  const installed = [{ major: 8 }, { major: 17 }, { major: 21 }];
  it('prefers the exact major', () => expect(chooseJava(installed, 17)?.major).toBe(17));
  it('uses the smallest newer JVM for 16+', () => expect(chooseJava([{ major: 21 }, { major: 25 }], 17)?.major).toBe(21));
  it('never runs Java 8 games on a newer JVM', () => expect(chooseJava([{ major: 17 }, { major: 21 }], 8)).toBeUndefined());
  it('returns undefined when nothing fits', () => expect(chooseJava([{ major: 8 }], 21)).toBeUndefined());
  it('maps components', () => { expect(javaComponentFor(8).component).toBe('jre-legacy'); expect(javaComponentFor(21).component).toBe('java-runtime-delta'); });
  it('fallback java by version', () => { expect(fallbackJavaMajor('1.12.2')).toBe(8); expect(fallbackJavaMajor('1.18.2')).toBe(17); expect(fallbackJavaMajor('1.21.1')).toBe(21); expect(fallbackJavaMajor('1.20.4')).toBe(17); });
});

describe('paths and file names', () => {
  it('keeps spaces and brackets in mod names', () => expect(safeFileName('Sodium (Fabric) 0.5+mc1.21.jar')).toBe('Sodium (Fabric) 0.5+mc1.21.jar'));
  it('strips directories and bad characters', () => expect(safeFileName('..\\evil/a:b?.jar')).toBe('a_b_.jar'));
  it('plain names only', () => { expect(isPlainFileName('a b.jar')).toBe(true); expect(isPlainFileName('../a.jar')).toBe(false); expect(isPlainFileName('a/b.jar')).toBe(false); expect(isPlainFileName('..')).toBe(false); });
  it('inside is strict', () => { expect(inside('/a/b', '/a/b/c')).toBe(true); expect(inside('/a/b', '/a/b')).toBe(false); expect(inside('/a/b', '/a/bc')).toBe(false); expect(inside('/a/b', '/a/b/../c')).toBe(false); });
  it('safeRelative drops traversal', () => expect(safeRelative('../../x/./y')).toBe(['x', 'y'].join(process.platform === 'win32' ? '\\' : '/')));
  it('joinInside rejects empty or escaping paths', () => { expect(() => joinInside('/a/b', '../..')).toThrow(); expect(joinInside('/a/b', 'mods/x.jar')).toContain('mods'); });
});

describe('identity and servers', () => {
  it('offline uuid matches the vanilla algorithm', () => expect(offlineUuid('Notch')).toBe('b50ad385829d3141a2167e7d7539ba7f'));
  it('normalizes names', () => { expect(normalizeLocalName('A very long name!!')).toBe('Averylongname'); expect(normalizeLocalName('!!!')).toBe('OfflinePlayer'); expect(normalizeLocalName('abcdefghijklmnopqrst')).toHaveLength(16); });
  it('parses host and port', () => { expect(parseServerAddress('play.example.com')).toEqual({ host: 'play.example.com', port: 25565 }); expect(parseServerAddress('a.b:1234')).toEqual({ host: 'a.b', port: 1234 }); expect(parseServerAddress('[::1]:2000')).toEqual({ host: '::1', port: 2000 }); });
  it('rejects bad addresses', () => { expect(() => parseServerAddress('')).toThrow(); expect(() => parseServerAddress('a.b:70000')).toThrow(); expect(() => parseServerAddress('a b')).toThrow(); });
});

describe('downloads and arguments', () => {
  it('allows only Modrinth CDN for mods', () => { expect(isModrinthCdn('https://cdn.modrinth.com/data/x/y.jar')).toBe(true); expect(isModrinthCdn('https://evil.example/y.jar')).toBe(false); expect(isModrinthCdn('http://cdn.modrinth.com/y.jar')).toBe(false); });
  it('allows only listed modpack hosts over https', () => { expect(isAllowedModpackUrl('https://raw.githubusercontent.com/a/b/c')).toBe(true); expect(isAllowedModpackUrl('https://cdn.modrinth.com.evil.io/a')).toBe(false); expect(isAllowedModpackUrl('file:///etc/passwd')).toBe(false); });
  it('verifies hashes', () => { const data = new TextEncoder().encode('hello'); expect(hashesMatch(data, { sha1: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d' })).toBe(true); expect(hashesMatch(data, { sha1: '00' })).toBe(false); expect(hashesMatch(data, {})).toBeUndefined(); });
  it('accepts normal JVM args', () => expect(parseJvmArgs('-XX:+UseG1GC -Dfoo=bar')).toEqual(['-XX:+UseG1GC', '-Dfoo=bar']));
  it('rejects code-loading JVM args', () => { expect(() => parseJvmArgs('-javaagent:/x.jar')).toThrow(); expect(() => parseJvmArgs('-cp /x')).toThrow(); expect(() => parseJvmArgs('notanarg')).toThrow(); });
});

describe('crash classification', () => {
  it('detects wrong Java', () => expect(classifyCrash('java.lang.UnsupportedClassVersionError: class file version 65.0')).toMatch(/Java/));
  it('detects memory problems', () => expect(classifyCrash('java.lang.OutOfMemoryError: Java heap space')).toMatch(/memory/i));
  it('detects mixin failures', () => expect(classifyCrash('Mixin apply failed foo.mixins.json')).toMatch(/Mixin/));
  it('detects dependency problems', () => expect(classifyCrash('Mod resolution failed')).toMatch(/dependency|incompatible/i));
  it('returns undefined for unknown crashes', () => expect(classifyCrash('something else')).toBeUndefined());
});

import { isValidSkinSource, loaderFromDependencies, readSkinPng, skinLoaderConfig } from '../src/main/logic';

import { fakePng } from './helpers';

describe('skins', () => {
  it('accepts https skin sources with {USERNAME}', () => expect(isValidSkinSource('https://raw.githubusercontent.com/me/skins/main/{USERNAME}.png')).toBe(true));
  it('rejects http, missing placeholder, spaces and quotes', () => { expect(isValidSkinSource('http://x.io/{USERNAME}.png')).toBe(false); expect(isValidSkinSource('https://x.io/skin.png')).toBe(false); expect(isValidSkinSource('https://x.io/a b/{USERNAME}.png')).toBe(false); expect(isValidSkinSource('https://x.io/"{USERNAME}.png')).toBe(false); });
  it('accepts 64x64 and 64x32 PNGs only', () => { expect(readSkinPng(fakePng(64, 64))).toEqual({ width: 64, height: 64 }); expect(readSkinPng(fakePng(64, 32)).height).toBe(32); expect(() => readSkinPng(fakePng(128, 128))).toThrow(/64x64/); expect(() => readSkinPng(new Uint8Array(40))).toThrow(/PNG/); });
  it('puts the local skin first and Mojang last', () => { const config = skinLoaderConfig('https://x.io/{USERNAME}.png'); expect(config.loadlist.map(item => item.name)).toEqual(['LocalSkin', 'XaviFriends', 'Mojang']); expect(skinLoaderConfig().loadlist.map(item => item.name)).toEqual(['LocalSkin', 'Mojang']); });
  it('maps modpack dependencies to a loader', () => { expect(loaderFromDependencies({ minecraft: '1.21.1', 'fabric-loader': '0.16.5' })).toEqual({ loader: 'Fabric', loaderVersion: '0.16.5' }); expect(loaderFromDependencies({ neoforge: '21.1.172' })?.loader).toBe('NeoForge'); expect(loaderFromDependencies({ minecraft: '1.21.1' })).toBeUndefined(); });
});

import { classifyExit, describeJvmCrash } from '../src/main/logic';
describe('native crash reporting', () => {
  it('names the AMD driver from an hs_err log', () => expect(describeJvmCrash('# Problematic frame:\n# C  [atio6axx.dll+0x4a1b2c]\n')).toMatch(/AMD graphics driver.*atio6axx\.dll/));
  it('names the Java runtime and unknown modules', () => { expect(describeJvmCrash('# Problematic frame:\n# C  [jvm.dll+0x123]')).toMatch(/Java runtime/); expect(describeJvmCrash('# Problematic frame:\n# C  [weird.dll+0x1]')).toMatch(/weird\.dll/); });
  it('returns undefined when there is no frame', () => expect(describeJvmCrash('nothing here')).toBeUndefined());
  it('explains 0xC0000005 exit codes', () => { expect(classifyExit(3221225477)).toMatch(/access violation/); expect(classifyExit(1)).toBeUndefined(); });
  it('no longer blames the graphics driver for every log that mentions OpenGL', () => expect(classifyCrash('Using graphics backend OpenGL, using drivers: 3.3.0')).toBeUndefined());
});

import { describeModule, parseFaultEvent } from '../src/main/logic';
describe('Windows fault events', () => {
  const sample = `Event[0]:\n  Log Name: Application\n  Source: Application Error\n  Description:\nFaulting application name: Teams.exe, version: 1.0, time stamp: 0x1\nFaulting module name: foo.dll, version: 1, time stamp: 0x1\nException code: 0xc0000005\n\nEvent[1]:\n  Log Name: Application\n  Source: Application Error\n  Description:\nFaulting application name: javaw.exe, version: 25.0.1.0, time stamp: 0x68\nFaulting module name: atio6axx.dll, version: 32.0.21025.1004, time stamp: 0x6a\nException code: 0xc0000005\nFault offset: 0x00000000012abcde\n`;
  it('finds the java crash and skips other applications', () => expect(parseFaultEvent(sample)).toEqual({ application: 'javaw.exe', module: 'atio6axx.dll', code: '0xc0000005', offset: '0x00000000012abcde' }));
  it('returns undefined without a java event', () => expect(parseFaultEvent('Event[0]:\nFaulting application name: x.exe, v\nFaulting module name: y.dll, v')).toBeUndefined());
  it('describes unknown modules too', () => expect(describeModule('mystery.dll')).toMatch(/mystery\.dll/));
});

import { compatibilityVariants } from '../src/main/logic';
describe('troubleshooting variants', () => {
  it('starts with the least invasive option and ends with the interpreter', () => { const v = compatibilityVariants(25); expect(v[0].jvmArgs).toEqual([]); expect(v.at(-1)?.jvmArgs).toEqual(['-Xint']); });
  it('only offers the Java 24+ memory flags on Java 24+', () => { expect(compatibilityVariants(25).some(v => v.jvmArgs.some(a => a.startsWith('--sun-misc-unsafe')))).toBe(true); expect(compatibilityVariants(21).some(v => v.jvmArgs.some(a => a.startsWith('--sun-misc-unsafe')))).toBe(false); });
  it('every option passes the JVM-argument safety filter', () => { for (const v of compatibilityVariants(25)) expect(() => parseJvmArgs(v.jvmArgs.join(' '))).not.toThrow(); });
});

import { isPlayerName, isPrivateServerHost, serverArguments } from '../src/main/logic';
describe('second player rules', () => {
  it('recognises servers on this PC or home network', () => { for (const host of ['localhost', '127.0.0.1', '192.168.1.20', '10.0.0.5', '172.16.4.1', '172.31.255.1', 'mypc.local', '::1']) expect(isPrivateServerHost(host)).toBe(true); });
  it('rejects public hosts and look-alikes', () => { for (const host of ['play.example.com', '8.8.8.8', '172.32.0.1', '192.169.1.1', '300.1.1.1', 'localhost.evil.com', '10.0.0.5.evil.com']) expect(isPrivateServerHost(host)).toBe(false); });
  it('validates player names', () => { expect(isPlayerName('Player_2')).toBe(true); expect(isPlayerName('ab')).toBe(false); expect(isPlayerName('has space')).toBe(false); expect(isPlayerName('a'.repeat(17))).toBe(false); });
  it('uses quick play from 1.20 and the 26.x numbering, --server before that', () => {
    expect(serverArguments({ host: '127.0.0.1', port: 25565 }, '1.21.1')).toEqual(['--quickPlayMultiplayer', '127.0.0.1:25565']);
    expect(serverArguments({ host: 'a.b', port: 1 }, '26.3')[0]).toBe('--quickPlayMultiplayer');
    expect(serverArguments({ host: 'a.b', port: 25566 }, '1.16.5')).toEqual(['--server', 'a.b', '--port', '25566']);
    expect(serverArguments({ host: '::1', port: 25565 }, '1.21.1')[1]).toBe('[::1]:25565');
  });
});
