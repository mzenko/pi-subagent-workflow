import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  peerDependencies?: Record<string, string>;
  files?: string[];
  pi?: Record<string, string[]>;
};

// Pi resource types a package manifest can declare (pi-coding-agent RESOURCE_TYPES).
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;

test("runtime Pi imports are declared as Pi-provided peers", () => {
  expect(packageJson.peerDependencies?.["@earendil-works/pi-ai"]).toBe("*");
});

test("every shipped Pi resource directory is declared in the pi manifest", () => {
  // Pi auto-discovers resource directories by convention ONLY when a package
  // declares no `pi` manifest at all. Once a manifest exists, Pi reads
  // manifest[resourceType] for each type and never falls back to scanning - so
  // an undeclared directory ships to users and is silently ignored. Shipping
  // skills/ without declaring it is exactly how workflow-authoring went missing.
  const manifest = packageJson.pi;
  expect(manifest).toBeDefined();

  for (const resourceType of RESOURCE_TYPES) {
    const present = existsSync(join(repoRoot, resourceType)) && readdirSync(join(repoRoot, resourceType)).length > 0;
    if (!present) continue;
    expect(manifest?.[resourceType], `${resourceType}/ exists but is not declared in the pi manifest`).toBeDefined();
    expect(packageJson.files ?? [], `${resourceType}/ is declared but not shipped in files`).toContain(`${resourceType}/`);
  }
});

test("declared pi manifest entries resolve to shipped files", () => {
  for (const [resourceType, entries] of Object.entries(packageJson.pi ?? {})) {
    for (const entry of entries) {
      if (entry.startsWith("!") || entry.includes("*")) continue;
      const target = join(repoRoot, entry);
      expect(existsSync(target), `pi.${resourceType} entry "${entry}" does not exist`).toBe(true);
      if (statSync(target).isDirectory()) {
        expect(readdirSync(target).length, `pi.${resourceType} entry "${entry}" is an empty directory`).toBeGreaterThan(0);
      }
    }
  }
});

test("each shipped skill is a loadable SKILL.md with name and description", () => {
  // Pi collects skills/<name>/SKILL.md and reads the frontmatter name and
  // description to build the skill listing; a skill missing either is not
  // offered to the agent.
  const skillsDir = join(repoRoot, "skills");
  const skillDirs = readdirSync(skillsDir).filter((name) => statSync(join(skillsDir, name)).isDirectory());
  expect(skillDirs.length).toBeGreaterThan(0);

  for (const name of skillDirs) {
    const skillPath = join(skillsDir, name, "SKILL.md");
    expect(existsSync(skillPath), `skills/${name} has no SKILL.md`).toBe(true);
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(skillPath, "utf8"))?.[1];
    expect(frontmatter, `skills/${name}/SKILL.md has no frontmatter`).toBeDefined();
    expect(frontmatter).toContain(`name: ${name}`);
    expect(/^description: \S/m.test(frontmatter ?? ""), `skills/${name} needs a description`).toBe(true);
  }
});
