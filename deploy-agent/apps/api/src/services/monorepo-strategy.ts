/**
 * R60 (2026-05-07): Honest-Monorepo Descent Strategy
 *
 * Pure function deciding how to handle a source archive's root layout. Replaces
 * the eager "descend into first subdir with Dockerfile" logic that dropped
 * sibling directories (e.g. wavenetdeveloper-rfp-agent had `backend/main.py`
 * referencing `os.path.join(BASE_DIR, "..", "frontend")` for static files;
 * pipeline descended into `backend/` and the static mount failed at runtime).
 *
 * The decider runs AFTER R44f single-wrapper descent (`descendIntoWrapperDir`),
 * so its input is the "real" source root.
 *
 * Five strategies returned:
 *
 *   - `flat`            — root IS the project (has Dockerfile or package.json).
 *                         Build context = root, dockerfilePath = "Dockerfile".
 *
 *   - `honest-monorepo` — multi-subdir layout where ONLY ONE subdir has a
 *                         Dockerfile. The user likely uses sibling references
 *                         (FastAPI StaticFiles mounting `../frontend`, etc).
 *                         Build context = root (KEEP siblings),
 *                         dockerfilePath = "<sub>/Dockerfile".
 *
 *   - `multi-service`   — ≥2 subdirs each have a Dockerfile. Split into
 *                         N projects (existing behavior preserved).
 *
 *   - `auto-gen-flat`   — no Dockerfile anywhere. Auto-gen will produce one
 *                         at root. Build context = root,
 *                         dockerfilePath = "Dockerfile".
 *                         Same plumbing as `flat` — distinguished only for
 *                         logging / decider transparency.
 *
 * Pure function — no filesystem access, no DB, no time. Caller materializes
 * the directory entries.
 */

export type MonorepoStrategy =
  | { kind: 'flat'; dockerfilePath: 'Dockerfile' }
  | { kind: 'honest-monorepo'; dockerfilePath: string; subdirName: string }
  | { kind: 'multi-service'; servicesWithDockerfile: string[] }
  | { kind: 'auto-gen-flat'; dockerfilePath: 'Dockerfile' };

export interface DirEntry {
  name: string;
  isDir: boolean;
  hasDockerfile: boolean; // only meaningful when isDir === true
}

export interface RootInfo {
  hasDockerfile: boolean;
  hasPackageJson: boolean;
  entries: DirEntry[]; // direct children of source root, junk filtered out
}

export function selectMonorepoStrategy(root: RootInfo): MonorepoStrategy {
  // R1: root IS the project — has Dockerfile at root.
  if (root.hasDockerfile) {
    return { kind: 'flat', dockerfilePath: 'Dockerfile' };
  }

  // R2: ≥2 subdirs each have a Dockerfile → split into N services.
  // Preserves the existing "monorepo" behavior in routes/projects.ts.
  const subdirsWithDockerfile = root.entries.filter(
    (e) => e.isDir && e.hasDockerfile,
  );

  if (subdirsWithDockerfile.length >= 2) {
    return {
      kind: 'multi-service',
      servicesWithDockerfile: subdirsWithDockerfile.map((d) => d.name),
    };
  }

  // R3: root has package.json (Node project at root) but no Dockerfile yet
  // → auto-gen will produce one at root. dockerfilePath stays 'Dockerfile'.
  // Honest-monorepo doesn't apply because the package.json signals a
  // single-project layout regardless of any subdirs.
  if (root.hasPackageJson) {
    return { kind: 'auto-gen-flat', dockerfilePath: 'Dockerfile' };
  }

  // R4: ≥2 subdirs, exactly 1 has a Dockerfile → honest-monorepo.
  // KEEP root as build context so sibling references work.
  // dockerfilePath relative to root (e.g. "backend/Dockerfile").
  const subdirCount = root.entries.filter((e) => e.isDir).length;
  if (subdirCount >= 2 && subdirsWithDockerfile.length === 1) {
    const subdir = subdirsWithDockerfile[0]!;
    return {
      kind: 'honest-monorepo',
      dockerfilePath: `${subdir.name}/Dockerfile`,
      subdirName: subdir.name,
    };
  }

  // R5: anything else (0 or 1 subdir, no Dockerfile, no package.json,
  // or 1 subdir with Dockerfile) → auto-gen-flat.
  // Note: single subdir with Dockerfile is handled here as auto-gen-flat;
  // R44f `descendIntoWrapperDir` should have already descended in that case.
  // If it didn't (e.g. caller skipped that step), auto-gen produces at root
  // and the build will use root as context — likely fails, but conservative.
  return { kind: 'auto-gen-flat', dockerfilePath: 'Dockerfile' };
}
