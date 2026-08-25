import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { BackendProtocolV2 } from "deepagents";
import type { OpenWikiOutputMode } from "../agent/types.js";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../claims/evidence/repository/resource.js";
import { parseFrontmatterFields, setOkfSources } from "./frontmatter.js";
import { listWikiConceptPaths } from "./index-sync.js";

/**
 * Stable prefix identifying source entries owned by the Claims projection.
 */
const OPENWIKI_SOURCE_ID_PREFIX = "openwiki-source-";

/**
 * Page-local repository evidence resources keyed by virtual concept path.
 */
export type ClaimEvidenceResources = ReadonlyMap<string, readonly string[]>;

/**
 * Projects page-owned Claims evidence files into OKF `sources` front matter.
 *
 * Existing producer-authored source entries are retained. OpenWiki-owned
 * entries receive deterministic IDs derived from their resource, allowing a
 * later Claims reconciliation to replace or remove only its own projection.
 * Pages without Claims state are left untouched.
 *
 * @param backend - Active generated-wiki filesystem.
 * @param outputMode - Current wiki target.
 * @param resourcesByPage - Complete current evidence resources per Claims page.
 */
export async function synchronizeClaimSources(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  resourcesByPage: ClaimEvidenceResources,
): Promise<void> {
  const concepts = new Set(await listWikiConceptPaths(backend, outputMode));
  const pages = [...resourcesByPage.keys()].sort((left, right) =>
    left.localeCompare(right),
  );

  for (const page of pages) {
    if (!concepts.has(page)) continue;
    const content = await readRequiredContent(backend, page);
    const currentSources = readSourceEntries(content);
    const nextSources = mergeClaimSources(
      currentSources,
      resourcesByPage.get(page) ?? [],
    );
    if (isDeepStrictEqual(currentSources, nextSources)) continue;

    const result = await backend.write(
      page,
      setOkfSources(content, nextSources),
    );
    if (result.error) {
      throw new Error(
        `Unable to synchronize OKF sources for ${page}: ${result.error}`,
      );
    }
  }
}

interface ParsedSource {
  resource: string; // base repo://path sem fragmento
  start?: number;
  end?: number;
  key: string; // repo://path ou repo://path#Lstart-Lend (canônico)
}

/**
 * Parses a `repo://` evidence resource into a canonical source key, preserving
 * optional line ranges.
 */
function parseRepoSource(resource: string): ParsedSource | undefined {
  if (!resource.startsWith("repo://")) return undefined;
  try {
    const parsed = parseRepositoryEvidenceResource(resource);
    const base = formatRepositoryEvidenceResource({ path: parsed.path });
    if (!parsed.range) return { resource: base, key: base };
    const { startLine, endLine } = parsed.range;
    const key = formatRepositoryEvidenceResource({
      path: parsed.path,
      range: parsed.range,
    });
    return { resource: base, start: startLine, end: endLine, key };
  } catch {
    return undefined;
  }
}

/**
 * Merges code-owned Claims resources with independently authored OKF sources.
 */
function mergeClaimSources(
  current: readonly Record<string, unknown>[],
  resources: readonly string[],
): Record<string, unknown>[] {
  // 1. Manter fontes independentes (não openwiki-source-*) e calcular suas chaves
  const retained: Record<string, unknown>[] = [];
  const retainedKeys = new Set<string>();

  for (const entry of current) {
    if (isOpenWikiSource(entry)) continue;
    const resource =
      typeof entry.resource === "string" ? entry.resource : "";
    if (!resource) continue;
    const parsed = parseRepoSource(resource);
    const start =
      typeof entry.start === "number" ? entry.start : parsed?.start;
    const end =
      typeof entry.end === "number" ? entry.end : parsed?.end;
    const key =
      parsed && start !== undefined && end !== undefined
        ? formatRepositoryEvidenceResource({
            path: parsed.resource.slice("repo://".length),
            range: { startLine: start, endLine: end },
          })
        : resource;
    retainedKeys.add(key);
    const normalized: Record<string, unknown> = {
      ...entry,
      resource: parsed?.resource ?? resource,
    };
    if (start !== undefined) normalized.start = start;
    if (end !== undefined) normalized.end = end;
    retained.push(normalized);
  }

  // 2. Projetar fontes a partir das Claims
  const projected = new Map<string, Record<string, unknown>>();
  for (const resource of resources) {
    const parsed = parseRepoSource(resource);
    if (!parsed) continue;
    if (retainedKeys.has(parsed.key)) continue;
    if (projected.has(parsed.key)) continue;

    projected.set(parsed.key, {
      id: openWikiSourceId(parsed.key),
      resource: parsed.resource,
      ...(parsed.start !== undefined ? { start: parsed.start } : {}),
      ...(parsed.end !== undefined ? { end: parsed.end } : {}),
    });
  }

  const projectedSorted = [...projected.values()].sort(compareSourceEntries);
  return [...retained, ...projectedSorted];
}

/**
 * Reads valid source mappings while treating a malformed field as empty.
 *
 * The OKF validator separately reports malformed producer input. Projection
 * repairs that field rather than reproducing entries that cannot satisfy the
 * required `resource` contract.
 */
function readSourceEntries(content: string): Record<string, unknown>[] {
  const value = parseFrontmatterFields(content)?.sources;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      typeof entry.resource === "string" &&
      entry.resource.trim() !== "",
  );
}

/**
 * Identifies one source entry emitted by this Claims projection.
 */
function isOpenWikiSource(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.id === "string" &&
    entry.id.startsWith(OPENWIKI_SOURCE_ID_PREFIX)
  );
}

/**
 * Derives a stable, portable source ID suitable for later footnote joins.
 */
function openWikiSourceId(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${OPENWIKI_SOURCE_ID_PREFIX}${digest}`;
}

/**
 * Deterministically orders source entries by resource, then start line, then end
 * line. Entries without a range sort after entries with a range.
 */
function compareSourceEntries(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const lRes = String(left.resource);
  const rRes = String(right.resource);
  if (lRes !== rRes) return lRes.localeCompare(rRes);
  const lStart =
    typeof left.start === "number" ? left.start : Number.POSITIVE_INFINITY;
  const rStart =
    typeof right.start === "number" ? right.start : Number.POSITIVE_INFINITY;
  if (lStart !== rStart) return lStart - rStart;
  const lEnd =
    typeof left.end === "number" ? left.end : Number.POSITIVE_INFINITY;
  const rEnd =
    typeof right.end === "number" ? right.end : Number.POSITIVE_INFINITY;
  return lEnd - rEnd;
}

/**
 * Reads one required concept as UTF-8-compatible Markdown.
 */
async function readRequiredContent(
  backend: BackendProtocolV2,
  page: string,
): Promise<string> {
  const read = await backend.readRaw(page);
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    throw new Error(
      `Unable to read ${page} while synchronizing OKF sources: ${read.error ?? "no text data"}`,
    );
  }
  return Array.isArray(content) ? content.join("\n") : content;
}

/**
 * Narrows an unknown value to a non-array mapping.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
