import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  peerDependencies?: Record<string, string>;
};

test("runtime Pi imports are declared as Pi-provided peers", () => {
  expect(packageJson.peerDependencies?.["@earendil-works/pi-ai"]).toBe("*");
});
