import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import manifest from "../../../vendor/ag-ui/manifest.json" with { type: "json" };

const root = new URL("../../../", import.meta.url);

for (const pkg of manifest) {
  test(`${pkg.name} matches its qualified archive`, async () => {
    const bytes = await readFile(new URL(`vendor/ag-ui/${pkg.archive}`, root));
    const digest = createHash("sha512").update(bytes).digest("base64");
    assert.equal(`sha512-${digest}`, pkg.integrity);

    const installed = new URL(`node_modules/${pkg.name}/`, root);
    const metadata = JSON.parse(await readFile(new URL("package.json", installed), "utf8"));
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    assert.equal(metadata.license, pkg.license);
    for (const notice of pkg.notices) {
      assert.ok((await readFile(new URL(notice, installed))).length > 0, notice);
    }
  });
}

test("Pi's public coding-session example loads in the consumer", async () => {
  const { createExampleServer } = await import("@ag-ui/pi/examples/server");
  assert.equal(typeof createExampleServer, "function");
});
