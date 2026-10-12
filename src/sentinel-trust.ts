import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  executionGrantSchema,
  gitSourceVerifier,
  type ExecutionGrant,
} from "./sentinel-executor.js";
import { hash } from "./sentinel-dev.js";
import type { GitWorkspace } from "./git.js";
import type { SentinelHost } from "./sentinel-dispatch.js";

const sourceSchema = z.strictObject({
  repository: z.string().min(1),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceRef: z.string().min(1),
});

const recordSchema = z.strictObject({
  grant: executionGrantSchema,
  provenance: sourceSchema,
});

export const signedBundlePayloadSchema = z.strictObject({
  version: z.literal(1),
  grants: z.array(recordSchema).max(10),
});

const signedBundleSchema = z.strictObject({
  payload: signedBundlePayloadSchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});

export type SignedBundlePayload = z.infer<typeof signedBundlePayloadSchema>;
export type SourceProvenance = z.infer<typeof sourceSchema>;

// Canonical schema-ordered serialization and a domain separator prevent the
// signature being accepted for a different file or protocol. This function
// is public only so the OFFLINE operator can sign an exact payload.
export function signedBundleMessage(input: unknown): Buffer {
  const payload = signedBundlePayloadSchema.parse(input);
  return Buffer.from(
    "CODEXBRIDGE_SENTINEL_GRANTS_V1\n" + JSON.stringify(payload),
    "utf8",
  );
}

export function sourceProvenanceBytes(input: unknown): string {
  return JSON.stringify(sourceSchema.parse(input));
}

export interface SignedTrustOptions {
  bundlePath: string;
  // The public key is supplied by a trusted host/operator, never by the
  // worker's ticket, the WorldPrep policy or MCP request content.
  publicKeyPem: string;
  git: Pick<GitWorkspace, "repository" | "resolve">;
  repositories: readonly string[];
  schedulerAllows: (repository: string) => boolean;
  now?: () => number;
}

function createReader(filename: string, publicKey: KeyObject) {
  return (): SignedBundlePayload => {
    // The bundle can be read by the service but never needs to be writable.
    // No symlink following, no arbitrary path from taskId or job output.
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > 65536)
        throw Error("Invalid signed authorization document");
      content = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const parsed = signedBundleSchema.parse(JSON.parse(content));
    const signature = Buffer.from(parsed.signature, "base64");
    if (
      signature.length !== 64 ||
      !verify(null, signedBundleMessage(parsed.payload), publicKey, signature)
    )
      throw Error("Authorization signature rejected");
    const seen = new Set<string>();
    for (const { grant, provenance } of parsed.payload.grants) {
      if (seen.has(grant.taskId))
        throw Error("Duplicate task authorization");
      seen.add(grant.taskId);
      if (
        grant.repository !== provenance.repository ||
        grant.baseCommit !== provenance.baseCommit ||
        grant.sourceRef !== provenance.sourceRef ||
        hash(sourceProvenanceBytes(provenance)) !== grant.provenanceHash
      )
        throw Error("Signed source provenance mismatch");
    }
    return parsed.payload;
  };
}

/**
 * Strictly opt-in protected host adapter. No signer, executor, worker,
 * timer, approval writer or production configuration change is created here.
 * All failures deny admission and never expose the signed document.
 */
export function signedFileSentinelHost(options: SignedTrustOptions): SentinelHost {
  if (!path.isAbsolute(options.bundlePath) || !options.repositories.length)
    throw Error("A protected absolute bundle path and allowlist are required");
  const publicKey = createPublicKey(options.publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519")
    throw Error("Sentinel grants require a trusted Ed25519 public key");
  const read = createReader(options.bundlePath, publicKey);
  const now = options.now ?? Date.now;

  const matching = (grant: ExecutionGrant) => {
    try {
      const candidate = read().grants.find((entry) => entry.grant.taskId === grant.taskId);
      return candidate &&
        candidate.grant.expiresAt > now() &&
        JSON.stringify(candidate.grant) === JSON.stringify(executionGrantSchema.parse(grant))
        ? candidate
        : null;
    } catch {
      return null;
    }
  };
  const verifyGit = gitSourceVerifier(options.git, async (grant) => {
    const record = matching(grant);
    if (!record) throw Error("Authorization revoked");
    return sourceProvenanceBytes(record.provenance);
  });

  return {
    repositories: [...new Set(options.repositories)],
    now,
    authorize: async (taskId) => {
      try {
        const candidate = read().grants.find((entry) => entry.grant.taskId === taskId);
        return candidate && candidate.grant.expiresAt > now()
          ? candidate.grant
          : null;
      } catch {
        return null;
      }
    },
    verifySource: async (grant) => {
      if (!matching(grant)) return false;
      try {
        return await verifyGit(grant);
      } catch {
        return false;
      }
    },
    // Re-read the signed bundle synchronously immediately before the
    // canonical SQLite job insertion; revocation cannot be hidden by
    // an earlier asynchronous Git check.
    revalidateGrant: (grant) => !!matching(grant),
    schedulerAllows: options.schedulerAllows,
  };
}
