import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { ServerMetadata } from '../config/configManager';

export type ContentKind = 'mods' | 'plugins';

export interface ContentItem {
  file: string;       // jar filename on disk
  name: string;       // human name from jar metadata, or the filename
  version: string;    // version from jar metadata, or 'unknown'
  sizeBytes: number;
}

export interface ContentListing {
  kind: ContentKind;
  dir: string;
  exists: boolean;
  items: ContentItem[];
}

/** Software that loads `mods/` rather than `plugins/`. */
function usesMods(software: string): boolean {
  return /fabric|forge|quilt|neoforge/i.test(software);
}

/** Resolves which folder (mods or plugins) holds this server's content. */
export function resolveContentDir(server: ServerMetadata): { kind: ContentKind; dir: string } {
  const kind: ContentKind = usesMods(server.software) ? 'mods' : 'plugins';
  return { kind, dir: path.join(server.path, kind) };
}

/** Best-effort metadata extraction from a single mod/plugin jar. */
function readJarMetadata(jarPath: string): { name?: string; version?: string } {
  try {
    const zip = new AdmZip(jarPath);

    // Fabric / Quilt
    const fabric = zip.getEntry('fabric.mod.json') || zip.getEntry('quilt.mod.json');
    if (fabric) {
      const json = JSON.parse(zip.readAsText(fabric));
      const meta = json.quilt_loader || json; // quilt nests under quilt_loader
      const name = meta.name || meta.metadata?.name || json.name;
      const version = meta.version || json.version;
      if (name || version) return { name, version: version && String(version) };
    }

    // Paper / Spigot / Bukkit
    const yml = zip.getEntry('plugin.yml') || zip.getEntry('paper-plugin.yml');
    if (yml) {
      const text = zip.readAsText(yml);
      const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      if (name || version) return { name, version };
    }

    // Forge / NeoForge (TOML — best-effort regex, not a full parser)
    const toml = zip.getEntry('META-INF/mods.toml') || zip.getEntry('META-INF/neoforge.mods.toml');
    if (toml) {
      const text = zip.readAsText(toml);
      const name = text.match(/displayName\s*=\s*["'](.+?)["']/)?.[1];
      const version = text.match(/version\s*=\s*["'](.+?)["']/)?.[1];
      if (name || version) return { name, version };
    }
  } catch {
    // Corrupt/unreadable jar — fall back to filename.
  }
  return {};
}

/**
 * Lists the installed mods or plugins for a server, choosing the folder by the
 * server software, and enriching each jar with its real name + version.
 */
export function scanContent(server: ServerMetadata): ContentListing {
  const { kind, dir } = resolveContentDir(server);

  if (!fs.existsSync(dir)) {
    return { kind, dir, exists: false, items: [] };
  }

  const items: ContentItem[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.jar')) continue;
    const full = path.join(dir, file);
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(full).size; } catch { /* ignore */ }
    const meta = readJarMetadata(full);
    items.push({
      file,
      name: meta.name || file.replace(/\.jar$/i, ''),
      version: meta.version || 'unknown',
      sizeBytes,
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name));
  return { kind, dir, exists: true, items };
}
